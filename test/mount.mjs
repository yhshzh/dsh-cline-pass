/**
 * Mount test for dsh-cline-pass.
 *
 * This composes and mounts a REAL dsh plugin tree — a throwaway profile whose
 * patch list is the shipped host rows plus this plugin — and then asserts what
 * only a mounted tree can show:
 *
 * - every row activated (the loader audit, not just "the file parses"),
 * - the provider route really is in `ctx.llm.listProviders()`,
 * - the LLM runtime accepts our model metadata (`listModels` /
 *   `resolveModelInfo`, whose validation is live and throws INVALID_* codes),
 * - a full model call streams end to end THROUGH the harness runtime against a
 *   stub gateway, with pinning applied,
 * - the `cline_pass_*` tools are registered on the real tool runtime.
 *
 * Everything is created under `test/.mount-*` and removed afterwards.
 *
 * Run with: node test/mount.mjs
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { boot, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { PANEL_PATH } from '../lib/panel.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
// Resolve the running dsh through a package every line shares, so the harness
// can be pointed at either supported line (install a different version into
// this tree, or run it from a separate one) instead of assuming the
// system-wide install. `@deepseek-ai/dsh` itself is not a dependency here, so
// the scope is derived from the settings package that dsh-settings always has.
const require = createRequire(import.meta.url)
// `installScope` is the `@deepseek-ai` directory that gets symlinked into the
// throwaway profile, so it is the parent of a resolved package.
const installScope = dirname(dirname(require.resolve('@deepseek-ai/dsh-settings/package.json')))
// The install anchor is the running dsh's own package.json. In a flat
// `node_modules` layout that is a sibling of the scope; in dsh's nested layout
// it sits one level above the scope's parent, so probe for it rather than
// assuming either shape.
const installAnchor = [
  join(installScope, 'dsh', 'package.json'),
  join(installScope, '..', '..', 'package.json'),
].find((candidate) => {
  if (!existsSync(candidate)) return false
  return String(JSON.parse(readFileSync(candidate, 'utf8')).name ?? '') === '@deepseek-ai/dsh'
})

/**
 * The settings row differs between the two dsh lines this plugin supports.
 *
 * 0.1.5 shipped `dsh-settings-file`, which carried its own `path` config; from
 * 0.1.7 that package is gone and `dsh-settings` reads and writes the profile's
 * own patch document, injecting `configEditor` and `profileContext`. Detecting
 * the package rather than the version keeps this working on anything in between.
 */
const hasSettingsFile = existsSync(join(installScope, 'dsh-settings-file'))

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) passed += 1
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ── stub gateway ────────────────────────────────────────────────────────────

const received = []
// Synthetic keys only: drive account refusals through the installed host.
const refusedKeys = new Map()
const servedAccounts = []
const gateway = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  received.push(body)
  const accountKey = request.headers.authorization?.replace(/^Bearer /, '')
  servedAccounts.push(accountKey)
  const refusal = refusedKeys.get(accountKey)
  if (refusal !== undefined) {
    response.writeHead(refusal.status, { 'Content-Type': 'application/json' })
    response.end(refusal.raw ?? JSON.stringify({ error: { message: refusal.message } }))
    return
  }
  const only = body?.providerOptions?.gateway?.only ?? body?.provider?.only ?? null
  const order = body?.providerOptions?.gateway?.order ?? body?.provider?.order ?? null
  const upstream = only?.[0] ?? order?.[0] ?? 'alibaba'
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `served by ${upstream}` } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ provider_metadata: { gateway: { routing: { finalProvider: upstream, canonicalSlug: 'z-ai/glm-5.2' } } }, choices: [] })}\n\n`)
  response.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, choices: [] })}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
})
await new Promise((resolvePromise) => gateway.listen(0, '127.0.0.1', resolvePromise))
const baseURL = `http://127.0.0.1:${gateway.address().port}/api/v1`

// ── throwaway profile ───────────────────────────────────────────────────────

const profileDir = mkdtempSync(join(here, '.mount-'))
const scratch = join(profileDir, 'scratch')
mkdirSync(scratch, { recursive: true })
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
symlinkSync(installScope, join(profileDir, 'node_modules', '@deepseek-ai'), 'dir')

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-mount-test', private: true, dsh: { profile: { bundles: ['dsh-profile-mount-test-bundle'] } } }, null, 2))
writeFileSync(join(profileDir, 'cordis.yml'), '# composed entirely from the patch file\n[]\n')
writeFileSync(join(profileDir, 'cordis.patch.yml'), `# Config overrides for the rows the bundle below mounts.
- id: cline-pass
  config:
    baseURL: ${JSON.stringify(baseURL)}
    apiKeyEnv: MOUNT_TEST_API_KEY
    knownModels:
      - cline-pass/glm-5.2
      - cline-pass/kimi-k3
    # This harness drives the tools, which are off by default, so it asks for
    # them the way a user would.
    exposeTools: true
${hasSettingsFile ? '' : `    accounts: {}
    accountMode: single
    activeAccount: ""
    hiddenModels: []
    models: {}
    perModel: {}
`}`)

// A real profile gets its host rows from bundle layers, so the harness builds
// one: the same split the shipped bundles use, with the profile patch above
// carrying only overrides.
const bundleDir = join(profileDir, 'node_modules', 'dsh-profile-mount-test-bundle')
mkdirSync(bundleDir, { recursive: true })
writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-mount-test-bundle',
  private: true,
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2))
writeFileSync(join(bundleDir, 'cordis.patch.yml'), `# The host rows this plugin needs, then the plugin itself: one insert over the
# empty profile root, the way dsh-base declares its own rows.
- insert:
${hasSettingsFile
  ? `  - id: settings
    name: '@deepseek-ai/dsh-settings-file'
    config:
      path: ${JSON.stringify(join(scratch, 'settings.yaml'))}
`
  : `  # dsh-settings injects configEditor and profileContext; the launcher provides
  # the latter, and this harness replaces the launcher, so boot is given it below.
  - id: config-editor
    name: '@deepseek-ai/dsh-config-editor'

  - id: settings
    name: '@deepseek-ai/dsh-settings'
`}
  - id: llm
    name: '@deepseek-ai/dsh-llm'

  - id: credentials
    name: '@deepseek-ai/dsh-credentials-local'
    config:
      path: ${JSON.stringify(join(scratch, 'credentials.yaml'))}

  # Ordered as dsh-base orders them: tools injects systemPrompt, and settings
  # injects configEditor, so each provider comes first.
  - id: system-prompt
    name: '@deepseek-ai/dsh-system-prompt'

  - id: tools
    name: '@deepseek-ai/dsh-tools'

  - id: webserver
    name: '@deepseek-ai/dsh-host-webserver'
    config:
      host: 127.0.0.1
      port: 0

  - id: connection
    name: '@deepseek-ai/dsh-client-connection'

  - id: client-modules
    name: '@deepseek-ai/dsh-client-modules'

  - id: cline-pass
    name: ${JSON.stringify(join(pluginDir, 'lib/index.js'))}
`)

process.env.MOUNT_TEST_API_KEY = 'sk_mount_test_key'

// ── mount ───────────────────────────────────────────────────────────────────

let ctx
try {
  // The launcher composes every layer: bundle patches first, then the profile's
  // own patch. boot is handed the composed list, which is why the bundle
  // package has to resolve exactly as it does in a real profile.
  const loaded = loadProfileDirectory('dsh', profileDir, installAnchor)
  const patches = [
    ...loaded.layers.flatMap((layer) => layer.patches),
    ...loaded.patches,
  ]
  check('the patch file composes', patches.length > 0, JSON.stringify(patches.length))
  check('the bundle layer contributes the host rows', loaded.layers.length === 1 && loaded.layers[0].patches.length > 0, JSON.stringify(loaded.layers.map((layer) => layer.packageName)))
  ctx = await boot('dsh', join(profileDir, 'cordis.yml'), patches, hasSettingsFile ? undefined : (hostCtx) => {
    // dsh-settings and config-editor both inject profileContext, which the
    // launcher normally provides; this harness replaces the launcher, so it
    // supplies the same shape over the throwaway profile.
    hostCtx.provide('profileContext', {
      name: 'dsh',
      dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
      installAnchor,
      cwd: process.cwd(),
      home: process.env.DSH_HOME ?? join(process.cwd(), '.dsh'),
      overlays: [],
    })
  })
  check('the tree mounted with every row activated', true)

  const entries = [...ctx.loader.entries()].map((entry) => entry.options?.id ?? entry.options?.name)
  check('the plugin row is in the loader', entries.includes('cline-pass'), entries.join(','))
  check('every host row this plugin needs mounted too', ['llm', 'settings', 'credentials', 'tools', 'cline-pass'].every((id) => entries.includes(id)), entries.join(','))

  // ── the LLM seam ──────────────────────────────────────────────────────────
  const llm = ctx.get('llm')
  const providers = llm.listProviders()
  check('the provider route is registered on the LLM runtime', providers.some((entry) => entry.id === 'cline-pass'), JSON.stringify(providers))
  check('the route advertises its display name', providers.find((entry) => entry.id === 'cline-pass')?.name === 'Cline Pass')

  const directory = llm.listConfigurableProviders()
  check('the route is declared to the configuration directory', directory.some((entry) => entry.provider === 'cline-pass' && entry.settingsNs === 'cline-pass'), JSON.stringify(directory))

  const models = await llm.listModels('cline-pass')
  check('the runtime accepts the model catalog', models.length === 2 && models.every((model) => model.provider === 'cline-pass' && model.id !== '' && model.name !== ''), JSON.stringify(models))
  const resolved = await llm.resolveModelInfo('cline-pass', 'cline-pass/glm-5.2')
  check('the runtime accepts the resolved model info', resolved.id === 'cline-pass/glm-5.2' && resolved.provider === 'cline-pass', JSON.stringify(resolved))
  check('the resolved model carries a context window and token cap', Number.isSafeInteger(resolved.context?.contextWindow) && resolved.context.contextWindow > 0 && Number.isSafeInteger(resolved.defaultMaxTokens) && resolved.defaultMaxTokens > 0, JSON.stringify(resolved))
  // The seam validates reasoning metadata at the boundary; a bad list would
  // surface here as INVALID_MODEL_REASONING rather than in the picker.
  const resolvedFlash = await llm.resolveModelInfo('cline-pass', 'cline-pass/deepseek-v4.1-flash')
  check('the real seam accepts the published context window', resolvedFlash.context.contextWindow === 1000000, JSON.stringify(resolvedFlash.context))
  // Image input reaches the adapter only when the seam advertises it: the
  // runtime projects images to text for a model that does not claim vision, so
  // these two facts are what decide whether 识图 can work at all.
  check('the vision model advertises image input on the real seam', Array.isArray(resolvedFlash.inputModalities) && resolvedFlash.inputModalities.includes('image'), JSON.stringify(resolvedFlash.inputModalities))
  const resolvedTextOnly = await llm.resolveModelInfo('cline-pass', 'cline-pass/deepseek-v4-pro')
  check('a text-only model does not advertise image input', Array.isArray(resolvedTextOnly.inputModalities) && !resolvedTextOnly.inputModalities.includes('image'), JSON.stringify(resolvedTextOnly.inputModalities))
  check('the real seam accepts the reasoning levels this model publishes',
    resolvedFlash.reasoning?.efforts.map((effort) => effort.id).join(',') === 'none,low,high,max'
      && !resolvedFlash.reasoning.efforts.some((effort) => effort.id === 'off'),
    JSON.stringify(resolvedFlash.reasoning))

  // ── the tools ─────────────────────────────────────────────────────────────
  const tools = ctx.get('tools')
  const names = ['cline_pass_status', 'cline_pass_models', 'cline_pass_probe', 'cline_pass_validate', 'cline_pass_test', 'cline_pass_pin', 'cline_pass_accounts', 'cline_pass_history']
  check('every tool is registered on the real tool runtime', names.every((toolName) => tools.get(toolName) !== undefined), names.filter((toolName) => tools.get(toolName) === undefined).join(','))

  // ── a full model call through the harness ─────────────────────────────────
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const userMessage = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const chunks = []
  for await (const chunk of llm.stream({
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [userMessage('hello')],
  })) {
    chunks.push(chunk)
  }
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  check('a model call streams through the runtime', text === 'served by alibaba', JSON.stringify(chunks))
  check('the stream finishes', chunks.at(-1)?.type === 'finish', JSON.stringify(chunks.at(-1)))
  check('the stub received the call with usage requested', received.length === 1 && received[0].stream === true && received[0].stream_options?.include_usage === true, JSON.stringify(received))
  // The outgoing `max_tokens` is the configured per-request BUDGET, not the model's
  // published output ceiling. dsh fills it from `defaultMaxTokens` and reserves the
  // same number as completion room, so sending the ceiling would reserve 131k of this
  // model's window on every call and compact it well below the threshold ratio.
  const ceiling = (await import('../lib/catalog.js')).catalogEntry('cline-pass/glm-5.2').maxTokens
  check('the outgoing request asks for the budget, not the model output ceiling',
    Number.isInteger(received[0].max_tokens) && received[0].max_tokens < ceiling,
    `max_tokens=${received[0].max_tokens} ceiling=${ceiling}`)

  // A pin written through the settings document must reach the next request.
  const settings = ctx.get('settings')
  await settings.update('cline-pass', { perModel: { 'cline-pass/glm-5.2': { upstreams: ['baseten'], exclude: [], pinMode: 'strict', sort: '' } } })
  const pinnedChunks = []
  let pinnedError = ''
  try {
    for await (const chunk of llm.stream({
      provider: 'cline-pass',
      model: 'cline-pass/glm-5.2',
      messages: [userMessage('hello again')],
    })) {
      pinnedChunks.push(chunk)
    }
  } catch (error) {
    pinnedError = ` threw ${error?.code ?? error?.name}: ${error?.message}`
  }
  check('a settings write reaches the next request without a restart', received.length === 2 && JSON.stringify(received[1]?.providerOptions?.gateway?.only) === JSON.stringify(['baseten']), `${received.length} request(s): ${JSON.stringify(received.map((body) => body?.providerOptions ?? null))}${pinnedError}`)
  check('the pinned call still streams', pinnedChunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('') === 'served by baseten', `${JSON.stringify(pinnedChunks.map((chunk) => chunk.type))}${pinnedError}`)

  // ── configuration surface ─────────────────────────────────────────────────
  const status = tools.get('cline_pass_status')
  const value = await status.execute({}, { signal: new AbortController().signal })
  check('the status tool runs against the mounted provider', value.provider === 'cline-pass' && value.routeRegistered === true && value.settingsAvailable === true, JSON.stringify(value))
  check('the status tool sees the configured account and its key', value.accounts.length === 1 && value.accounts[0].keyConfigured === true, JSON.stringify(value.accounts))

  // ── the browser setup panel channel ───────────────────────────────────────
  // The panel is published on the Connection RPC channel the browser half
  // calls; its behaviour is covered offline in smoke.mjs. What only a mounted
  // tree can show is that the Connection service really is present and that
  // the client half's manifest was accepted by the real module scanner.
  const connection = ctx.get('connection')
  check('the Connection service mounted, so the browser transport exists', connection !== undefined && typeof connection.rpc?.handle === 'function')

  // Mounting the client half is a host-side fact: the client-modules scanner
  // must accept this package's `dsh.client` declaration and its ./client export.
  const clientModules = ctx.get('clientModules')
  check('the client module system mounted', clientModules !== undefined && typeof clientModules.graph === 'function')
  const graph = clientModules.graph()
  const rows = (graph?.entries ?? []).map((row) => row.id)
  check('this package declares a browser bundle the module system accepted', rows.includes('dsh-cline-pass'), rows.join(',') || '(no client rows)')
  const clientRow = (graph?.entries ?? []).find((row) => row.id === 'dsh-cline-pass')
  check('the browser bundle is served from a revisioned URL', typeof clientRow?.url === 'string' && clientRow.url.includes('rev='), String(clientRow?.url))
  check('the browser bundle declares the plugins it waits for', Array.isArray(clientRow?.inject) && clientRow.inject.includes('@deepseek-ai/dsh-client-connection'), JSON.stringify(clientRow?.inject))
  // The usage pill reads the selected provider from the model-selection service,
  // so the bundle has to declare it. Without the declaration the service is
  // gated and the pill's inject throws — which only shows up in the browser.
  check('the browser bundle waits for the model-selection service',
    Array.isArray(clientRow?.inject) && clientRow.inject.includes('@deepseek-ai/dsh-client-ui-model-selection'),
    JSON.stringify(clientRow?.inject))

  // ── the panel route over real HTTP ────────────────────────────────────────
  // A rendered browser half proves nothing about the host route it calls: a
  // missing route silently falls through to the static fallback, which answers
  // POST with 405. So the route is exercised over a real socket here.
  const webServer = ctx.get('webServer')
  check('the webserver mounted on an ephemeral port', Number.isSafeInteger(webServer?.port) && webServer.port > 0, String(webServer?.port))
  const origin = `http://127.0.0.1:${webServer.port}`

  const envelope = (method, payload = {}) => JSON.stringify({ endpoint: method, payload })

  /** POST one panel action, optionally carrying the browser session cookie. */
  const panelPost = async (body, cookie) => {
    const response = await fetch(`${origin}${PANEL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
      body,
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* a non-JSON body is the caller's evidence */ }
    return { status: response.status, text, json }
  }

  // Unauthenticated: a route inside the /api fence answers 401. A 404/405 means
  // it never registered and the static fallback took the request instead —
  // which is exactly the failure this check exists to catch.
  const unauthenticated = await panelPost(envelope('state'))
  check('the panel route is registered, not answered by the static fallback', unauthenticated.status === 401, `HTTP ${unauthenticated.status} — ${unauthenticated.text.slice(0, 60)}`)

  // Authenticate the way the browser does: exchange the launch token for the
  // session cookie, then speak the panel protocol with it. In a full Web
  // composition the dist server claims the fallback seat and runs this
  // exchange; this minimal tree has no dist, so root is mounted here on the
  // very method that server calls.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/',
    handler: (req, res) => {
      if (connection.authorizeIndex(req, res) === true) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html></html>')
      }
    },
  }), 'mount-test: index seat')
  const login = await fetch(connection.authenticatedUrl(origin), { redirect: 'manual' })
  const cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(';')[0]
  check('the browser session cookie was issued', typeof cookie === 'string' && cookie.length > 0, `HTTP ${login.status}`)

  const stateResponse = await panelPost(envelope('state'), cookie)
  check('the panel answers state over real HTTP', stateResponse.status === 200 && stateResponse.json?.ok === true, `HTTP ${stateResponse.status} — ${stateResponse.text.slice(0, 120)}`)
  check('the panel state names the mounted route', stateResponse.json?.value?.provider === 'cline-pass', JSON.stringify(stateResponse.json?.value?.provider))
  // The tools posture travels with every reading, so the panel can show a switch
  // and a restart notice that agree with what the host actually registered. This
  // harness asked for them on, and the tools above are only reachable that way.
  check('the panel reports the tools posture it mounted under', stateResponse.json?.value?.exposeTools === true, JSON.stringify(stateResponse.json?.value?.exposeTools))
  check('the panel state confirms the configured key', stateResponse.json?.value?.ready === true, JSON.stringify(stateResponse.json?.value?.ready))

  const pinResponse = await panelPost(envelope('model.pin', { model: 'cline-pass/kimi-k3', upstreams: ['gmicloud'], pinMode: 'preferred', sort: 'ttft' }), cookie)
  // Read the written document rather than a service accessor: `settings.get`
  // existed on 0.1.5 and is gone in 0.1.7. Which file holds it differs too —
  // 0.1.5 keeps its own settings document, 0.1.7 rewrites the profile patch —
  // so both are searched for the value that was just written.
  const documents = [
    join(scratch, 'settings.yaml'),
    join(profileDir, 'cordis.patch.yml'),
  ].filter((path) => existsSync(path)).map((path) => readFileSync(path, 'utf8'))
  const writtenPerModel = documents.some((text) => /perModel:/.test(text) && /gmicloud/.test(text))
  check('a panel write reaches the settings document', pinResponse.status === 200 && writtenPerModel, `${pinResponse.status} — ${documents.map((text) => text.slice(0, 160)).join(' | ')}`)

  // The tools switch writes a field the panel did not previously touch, and a
  // write to a field the schema does not mark volatile is refused outright —
  // `Config field "exposeTools" is not volatile`. Only a real settings service
  // enforces that, so this cannot be covered by a stub: it has to go through the
  // mounted document, which is what a browser click does.
  const exposeResponse = await panelPost(envelope('tools.expose', { value: false }), cookie)
  check('the tools switch writes through the real settings service',
    exposeResponse.status === 200 && exposeResponse.json?.ok === true,
    `HTTP ${exposeResponse.status} — ${exposeResponse.text.slice(0, 300)}`)
  const afterWrite = [
    join(scratch, 'settings.yaml'),
    join(profileDir, 'cordis.patch.yml'),
  ].filter((path) => existsSync(path)).map((path) => readFileSync(path, 'utf8'))
  check('the tools switch reaches the settings document',
    afterWrite.some((text) => /exposeTools:\s*false/.test(text)),
    afterWrite.map((text) => text.slice(0, 200)).join(' | '))
  // And the switch keeps showing what was chosen. Reporting the value the
  // *running* plugin was built with instead would flip it straight back to
  // `true` here, so this is the check that the control does not lie about a
  // click that in fact succeeded.
  const afterState = await panelPost(envelope('state'), cookie)
  check('the switch keeps the choice it was just given',
    afterState.json?.value?.exposeTools === false,
    JSON.stringify(afterState.json?.value?.exposeTools))

  // ── the output budget writes ────────────────────────────────────────────────
  //
  // Same refusal as the switch above, and the same reason this cannot be a stub: the
  // real settings service rejects a write to a field the schema does not mark live,
  // while every stub accepts it. A card that only looked clickable would pass all of
  // them.
  const budgetResponse = await panelPost(envelope('budget.set', { value: 256000 }), cookie)
  check('the output budget writes through the real settings service',
    budgetResponse.status === 200 && budgetResponse.json?.ok === true,
    `HTTP ${budgetResponse.status} — ${budgetResponse.text.slice(0, 300)}`)
  const budgetWrite = [
    join(scratch, 'settings.yaml'),
    join(profileDir, 'cordis.patch.yml'),
  ].filter((path) => existsSync(path)).map((path) => readFileSync(path, 'utf8'))
  check('the output budget reaches the settings document',
    budgetWrite.some((text) => /defaultMaxTokens:\s*256000/.test(text)),
    budgetWrite.map((text) => text.slice(0, 200)).join(' | '))
  const budgetState = await panelPost(envelope('state'), cookie)
  check('the budget card keeps the value it was just given',
    budgetState.json?.value?.defaultMaxTokens === 256000,
    JSON.stringify(budgetState.json?.value?.defaultMaxTokens))
  const budgetBad = await panelPost(envelope('budget.set', { value: 12 }), cookie)
  check('an impossible output budget is refused rather than written',
    budgetBad.json?.ok === false, budgetBad.text.slice(0, 200))

  // ── removing an account actually removes it ───────────────────────────────
  //
  // Adding a second account and then deleting it is the only way to see whether
  // the removal reaches the document: `settings.update` merges recursively, so a
  // patch that simply omits the key leaves it in place — the panel reports
  // success over HTTP and the account is still there on the next read. Both host
  // lines merge this way, and only an `unset` edit deletes a key.
  const readAccounts = async () => {
    const response = await panelPost(envelope('state'), cookie)
    return response.json?.value?.accounts ?? []
  }
  const added = await panelPost(envelope('account.add', { name: 'doomed', key: 'sk_doomed_key_123456' }), cookie)
  check('the panel adds a second account', added.json?.ok === true && (await readAccounts()).some((account) => account.key === 'doomed'), `${added.status} — ${JSON.stringify((await readAccounts()).map((a) => a.key))}`)

  // ── the reading follows the account a request would use ───────────────────
  //
  // With a pool, `activeAccount` is only the single-mode choice and usage is per
  // account, so a surface that names the wrong one describes quota that is not
  // about to be spent. The host has to say which account is in line; the client
  // cannot work it out, and before this it simply took the first one that read.
  const chooseAccount = async (active) => {
    await panelPost(envelope('account.mode', { mode: 'single', active }), cookie)
    const response = await panelPost(envelope('state'), cookie)
    return response.json?.value?.effectiveAccount
  }
  check('the reading follows the account the pool is pointed at',
    await chooseAccount('doomed') === 'doomed', `effective=${await chooseAccount('doomed')}`)
  check('the reading returns to the first enabled account when none is chosen',
    await chooseAccount('') === 'default', `effective=${await chooseAccount('')}`)

  // The pill takes the account from the `usage` reply, which is this same state
  // plus a reading, so the field has to travel there too — a client that only
  // found it on `state` would fall back to its own older copy.
  const usageReply = await panelPost(envelope('usage'), cookie)
  check('the usage reply carries the account a request would use',
    usageReply.json?.value?.effectiveAccount === 'default',
    JSON.stringify(usageReply.json?.value?.effectiveAccount))

  // In round-robin no single account represents the pool: a request takes the
  // one the cursor points at and advances it, so a reading pinned to the first
  // account describes a key that is only sometimes the one being spent.
  await panelPost(envelope('account.mode', { mode: 'roundrobin', active: '' }), cookie)
  const readEffective = async () => (await panelPost(envelope('state'), cookie)).json?.value?.effectiveAccount
  const beforeTurn = await readEffective()
  let streamed = false
  try {
    for await (const chunk of llm.stream({ provider: 'cline-pass', model: 'cline-pass/glm-5.2', messages: [userMessage('advance')] })) {
      if (chunk.type === 'text-delta') streamed = true
    }
  } catch { /* the rotation already moved; the reading is what is under test */ }
  const afterTurn = await readEffective()
  check('a pool rotates the reading to the account the next request would use',
    beforeTurn !== afterTurn && beforeTurn !== '' && afterTurn !== '',
    `${beforeTurn} -> ${afterTurn} (streamed=${streamed})`)
  // Reading quota is not a request, so asking must not consume a turn of its own.
  check('reading the quota does not consume a round-robin turn',
    await readEffective() === afterTurn, `${afterTurn} -> ${await readEffective()}`)
  await panelPost(envelope('account.mode', { mode: 'single', active: '' }), cookie)

  const removed = await panelPost(envelope('account.remove', { name: 'doomed' }), cookie)
  const remaining = await readAccounts()
  check('a removed account is gone from the state', removed.json?.ok === true && !remaining.some((account) => account.key === 'doomed'), `${removed.status} — ${JSON.stringify(remaining.map((a) => a.key))}`)
  // The account that was in line is gone, so the reading has to name another one
  // rather than keep pointing at a key that no longer exists.
  check('the reading survives the account it named being removed',
    (await panelPost(envelope('state'), cookie)).json?.value?.effectiveAccount === 'default',
    JSON.stringify((await panelPost(envelope('state'), cookie)).json?.value?.effectiveAccount))
  // The service is the authority: re-read the document rather than trusting the
  // panel's own projection of it.
  const sideDocuments = [
    join(scratch, 'settings.yaml'),
    join(profileDir, 'cordis.patch.yml'),
  ].filter((path) => existsSync(path)).map((path) => readFileSync(path, 'utf8'))
  check('a removed account is gone from the settings document too', !sideDocuments.some((text) => /doomed/.test(text)), sideDocuments.map((text) => text.slice(0, 200)).join(' | '))

  const unknownResponse = await panelPost(envelope('nope'), cookie)
  check('an unknown action is a typed failure over the wire', unknownResponse.status === 200 && unknownResponse.json?.ok === false, `HTTP ${unknownResponse.status} — ${unknownResponse.text.slice(0, 120)}`)

  // Account refusal must work independently of the channel count, and the
  // cooldown must consume the installed host's actual quota error constant.
  await panelPost(envelope('model.pin', { model: 'cline-pass/glm-5.2', upstreams: ['alibaba'], pinMode: 'strict' }), cookie)
  const backupKey = 'sk_mount_backup_key'
  await panelPost(envelope('account.add', { name: 'backup', key: backupKey }), cookie)
  const verifyAccountFailover = async (name, key, mode, refusal) => {
    await panelPost(envelope('account.add', { name, key }), cookie)
    // Each case has a fresh pair, so cooldowns from earlier refusals cannot
    // conceal a broken round-robin path or make it choose an untested key.
    for (const account of await readAccounts()) {
      const enabled = await panelPost(envelope('account.enable', { name: account.key, enabled: account.key === name || account.key === 'backup' }), cookie)
      if (enabled.json?.ok !== true) throw new Error(`account.enable failed: ${enabled.text}`)
    }
    await panelPost(envelope('account.mode', { mode, active: name }), cookie)
    if (mode === 'roundrobin' && await readEffective() !== name) {
      for await (const chunk of llm.stream({ provider: 'cline-pass', model: 'cline-pass/glm-5.2', messages: [userMessage('align cursor')] })) { /* drain */ }
    }
    check(`${mode}: the refusal case starts on the intended account`, await readEffective() === name, await readEffective())
    refusedKeys.set(key, refusal)
    const start = servedAccounts.length
    let answered = false
    for await (const chunk of llm.stream({ provider: 'cline-pass', model: 'cline-pass/glm-5.2', messages: [userMessage('account failover')] })) {
      if (chunk.type === 'text-delta') answered = true
    }
    const used = servedAccounts.slice(start)
    check(`${mode}: an account refusal is absorbed by the backup`, answered && used.includes(backupKey), used.join(' -> '))
    check(`${mode}: the exhausted key is not retried on another channel`, used.filter((value) => value === key).length === 1, used.join(' -> '))
    check(`${mode}: the panel follows the backup after cooldown`, await readEffective() === 'backup', await readEffective())
    const nextStart = servedAccounts.length
    for await (const chunk of llm.stream({ provider: 'cline-pass', model: 'cline-pass/glm-5.2', messages: [userMessage('cooldown')] })) { /* drain */ }
    check(`${mode}: later requests skip the cooling account`, JSON.stringify(servedAccounts.slice(nextStart)) === JSON.stringify([backupKey]), servedAccounts.slice(nextStart).join(' -> '))
    const history = (await panelPost(envelope('history'), cookie)).json?.value?.entries ?? []
    check(`${mode}: history retains the refused account and original error`, history.some((row) => row.account === name && row.error?.includes(refusal.message)), JSON.stringify(history.map((row) => ({ account: row.account, error: row.error }))))
  }
  await verifyAccountFailover('spent-weekly', 'sk_mount_spent_weekly', 'single', { status: 429, message: 'Weekly limit reached' })
  await verifyAccountFailover('spent-five-hour', 'sk_mount_spent_five_hour', 'roundrobin', { status: 429, message: 'five_hour window exhausted' })
  await verifyAccountFailover('spent-payment', 'sk_mount_spent_payment', 'single', { status: 402, message: 'Payment required' })
  await verifyAccountFailover('auth-empty', 'sk_mount_auth_empty', 'single', { status: 401, message: 'HTTP 401', raw: '' })
  await verifyAccountFailover('auth-html', 'sk_mount_auth_html', 'single', { status: 403, message: 'Access denied', raw: '<html>Access denied</html>' })

  // A locally unconfigured account must be skipped before opening a request.
  await panelPost(envelope('account.add', { name: 'missing-key', apiKeyEnv: 'MOUNT_MISSING_KEY' }), cookie)
  for (const account of await readAccounts()) {
    await panelPost(envelope('account.enable', { name: account.key, enabled: ['missing-key', 'backup'].includes(account.key) }), cookie)
  }
  await panelPost(envelope('account.mode', { mode: 'single', active: 'missing-key' }), cookie)
  const beforeMissing = servedAccounts.length
  const missingChunks = []
  for await (const chunk of llm.stream({ provider: 'cline-pass', model: 'cline-pass/glm-5.2', messages: [userMessage('missing credential')] })) missingChunks.push(chunk)
  check('missing credentials do not block a valid backup through the installed runtime', missingChunks.at(-1)?.reason?.kind === 'stop')
  check('only the configured backup reaches the gateway', JSON.stringify(servedAccounts.slice(beforeMissing)) === JSON.stringify([backupKey]))
  check('quota peeks skip accounts without a credential too', await readEffective() === 'backup')

  // update merges objects, so replacing the pool needs explicit deletion.
  const accountTool = tools.get('cline_pass_accounts')
  const afterSet = await accountTool.execute({ action: 'set', accounts: [{ name: 'backup' }] }, { signal: new AbortController().signal })
  check('full replacement removes omitted accounts in real settings', JSON.stringify(afterSet.accounts.map((a) => a.key)) === JSON.stringify(['backup']))
  check('replacement clears an omitted active account', afterSet.activeAccount === '')
  const replacementDocuments = [join(scratch, 'settings.yaml'), join(profileDir, 'cordis.patch.yml')].filter(existsSync).map((path) => readFileSync(path, 'utf8'))
  check('replacement removes the old account from the persisted document', !replacementDocuments.some((text) => text.includes('missing-key')))
  await accountTool.execute({ action: 'set', accounts: [] }, { signal: new AbortController().signal })
  const emptyState = (await panelPost(envelope('state'), cookie)).json?.value
  check('empty replacement removes all explicit accounts in real settings', emptyState.accounts.length === 1 && emptyState.accounts[0].key === 'default' && emptyState.accounts[0].declared === false)
} catch (error) {
  failures.push(`unexpected failure — ${error?.stack ?? error}`)
} finally {
  if (ctx !== undefined) {
    try {
      await ctx.dispose?.()
    } catch { /* teardown is best effort */ }
  }
  gateway.close()
  if (!existsSync(join(here, '.keep-mount'))) rmSync(profileDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} check(s) failed, ${passed} passed:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✔ all ${passed} mount checks passed`)
// A mounted dsh tree owns file watchers and timers that legitimately outlive the
// assertions; exit explicitly so the test cannot hang the shell (and npm) after
// it has already reported its result.
process.exit(0)
