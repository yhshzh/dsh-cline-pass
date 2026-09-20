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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { PANEL_PATH } from '../lib/panel.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const installAnchor = '/usr/lib/node_modules/@deepseek-ai/dsh/package.json'
const installScope = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) passed += 1
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ── stub gateway ────────────────────────────────────────────────────────────

const received = []
const gateway = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  received.push(body)
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

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-mount-test', private: true, dsh: { profile: { bundles: [] } } }, null, 2))
writeFileSync(join(profileDir, 'cordis.yml'), '# composed entirely from the patch file\n[]\n')
writeFileSync(join(profileDir, 'cordis.patch.yml'), `# The host rows this plugin needs, then the plugin itself.
- insert:
    - id: llm
      name: '@deepseek-ai/dsh-llm'

    - id: settings
      name: '@deepseek-ai/dsh-settings-file'
      config:
        path: ${JSON.stringify(join(scratch, 'settings.yaml'))}

    - id: credentials
      name: '@deepseek-ai/dsh-credentials-local'
      config:
        path: ${JSON.stringify(join(scratch, 'credentials.yaml'))}

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
      config:
        baseURL: ${JSON.stringify(baseURL)}
        apiKeyEnv: MOUNT_TEST_API_KEY
        knownModels:
          - cline-pass/glm-5.2
          - cline-pass/kimi-k3
`)

process.env.MOUNT_TEST_API_KEY = 'sk_mount_test_key'

// ── mount ───────────────────────────────────────────────────────────────────

let ctx
try {
  const patches = loadOptionalPatches('dsh', join(profileDir, 'cordis.patch.yml')) ?? []
  check('the patch file composes', patches.length > 0, JSON.stringify(patches))
  ctx = await boot('dsh', join(profileDir, 'cordis.yml'), patches)
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
  check('the real seam accepts the reasoning efforts', resolvedFlash.reasoning?.efforts.length === 7 && !resolvedFlash.reasoning.efforts.some((effort) => effort.id === 'off'), JSON.stringify(resolvedFlash.reasoning))

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
  check('the panel state confirms the configured key', stateResponse.json?.value?.ready === true, JSON.stringify(stateResponse.json?.value?.ready))

  const pinResponse = await panelPost(envelope('model.pin', { model: 'cline-pass/kimi-k3', upstreams: ['gmicloud'], pinMode: 'preferred', sort: 'ttft' }), cookie)
  check('a panel write reaches the settings document', pinResponse.status === 200 && JSON.stringify(settings.get('cline-pass')?.perModel?.['cline-pass/kimi-k3']?.upstreams) === JSON.stringify(['gmicloud']), JSON.stringify(settings.get('cline-pass')?.perModel))

  const unknownResponse = await panelPost(envelope('nope'), cookie)
  check('an unknown action is a typed failure over the wire', unknownResponse.status === 200 && unknownResponse.json?.ok === false, `HTTP ${unknownResponse.status} — ${unknownResponse.text.slice(0, 120)}`)
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
