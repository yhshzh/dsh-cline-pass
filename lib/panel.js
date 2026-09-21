/**
 * The host half of the Cline Pass setup panel.
 *
 * The `cline_pass_*` tools let an agent configure the provider; this publishes
 * the same control surface to the package's browser half (`lib/client.js`) as an
 * exact route inside Connection's authenticated `/api` prefix, so a user can
 * paste a key and click once instead of composing a tool call.
 *
 * The panel is a thin projection, never a second source of truth: reads go
 * through the live config and the observation store, and writes go through the
 * same `control` surface the tools use. Only lossless JSON crosses the wire —
 * credentials are reported as a masked hint, never as a value.
 *
 * @module dsh-cline-pass/panel
 */
import { normalizePinMode } from './protocol.js'

/**
 * The exact `/api` Fetch route this package owns.
 *
 * It lives under `/api` deliberately: that prefix belongs to Connection, whose
 * handler is the only thing applying the Host/Origin fence and browser-cookie
 * authentication. A route registered on the bare webserver would be reachable
 * by anything that can reach the port.
 */
export const PANEL_PATH = '/api/cline-pass'

/** RPC failure code shared by every endpoint of this channel. */
export const PANEL_ERROR_CODE = 'cline-pass/panel'

/** How many models one `setup.auto` run may consider. */
const AUTO_MAX_CHANNELS = 12

/** Collapse a value into one display line. */
function firstLine(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Mask a secret, keeping just enough to recognize it. */
export function maskKey(value) {
  const key = String(value ?? '')
  if (key.length === 0) return ''
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/**
 * Order availability verdicts from most to least usable.
 *
 * `not-adopted` ranks below `unknown` and above `bad`: the channel demonstrably
 * answered, but a different one served the request, so it cannot be trusted to
 * honor a pin. Leaving it out of this table would rank it as `unknown` and let
 * auto-configuration pick it.
 */
const VERDICT_RANK = { ok: 0, limited: 1, unknown: 2, 'not-adopted': 3, bad: 4, auth: 5 }

/** Rank one channel verdict for auto-selection. */
function rankVerdict(status) {
  return VERDICT_RANK[status] ?? VERDICT_RANK.unknown
}

/** Project one model from the live configuration plus what the store observed. */
export function projectModel(model, pin, meta) {
  const upstreamStatus = Object.entries(meta?.upstreamStatus ?? {}).map(([upstream, verdict]) => ({
    upstream: String(upstream),
    status: String(verdict?.status ?? 'unknown'),
    ms: Number(verdict?.ms ?? 0),
    note: firstLine(verdict?.note, 160),
    checkedAt: Number(verdict?.checkedAt ?? 0),
  }))
  return {
    id: String(model),
    displayName: String(model).replace(/^cline-pass\//, ''),
    pipeline: String(meta?.pipeline ?? ''),
    pinnable: meta?.pinnable === true,
    // The mode a request will actually run, from the same normalizer the router
    // uses — the panel and the tools used to disagree about a padded "strict ".
    pinMode: normalizePinMode(pin?.pinMode),
    sort: String(pin?.sort ?? ''),
    pinned: Array.isArray(pin?.upstreams) ? pin.upstreams.map(String) : [],
    excluded: Array.isArray(pin?.exclude) ? pin.exclude.map(String) : [],
    upstreams: Array.isArray(meta?.upstreams) ? meta.upstreams.map(String) : [],
    upstreamStatus,
    lastProvider: String(meta?.lastProvider ?? ''),
    lastMs: Number(meta?.lastMs ?? 0),
    probedAt: Number(meta?.probedAt ?? 0),
    validatedAt: Number(meta?.validatedAt ?? 0),
  }
}

/**
 * Build the panel's JSON API over the plugin's control surface.
 *
 * @param options - `{ control, engine, store }`, exactly what the tools receive.
 * @returns an endpoint table: `name -> (payload) => Promise<json>`.
 */
export function createPanel({ control, engine, store }) {
  const readConfig = () => control.readConfig()

  /** The model id a payload names, or a helpful refusal. */
  const modelOf = (payload) => {
    const model = String(payload?.model ?? '').trim()
    if (model.length === 0) throw new Error('this action needs a `model` id')
    return model
  }

  /** One account as the panel shows it: never the key itself. */
  const accountView = (account) => ({
    key: String(account.key),
    displayName: String(account.displayName ?? account.key),
    apiKeyEnv: String(account.apiKeyEnv ?? ''),
    enabled: account.enabled !== false,
    keyConfigured: account.keyConfigured === true,
    keyHint: String(account.keyHint ?? ''),
  })

  /** The whole panel snapshot in one round trip. */
  async function state() {
    const config = readConfig()
    const accounts = (await control.accountsWithKeys()).map(accountView)
    const models = (config.knownModels ?? []).map((id) => projectModel(id, config.perModel?.[id] ?? {}, store.metaOf(id)))
    const usable = accounts.some((account) => account.keyConfigured && account.enabled)
    const pinned = models.filter((model) => model.pinned.length > 0).length
    return {
      provider: control.providerName,
      displayName: control.displayName,
      baseURL: String(config.baseURL ?? ''),
      settingsAvailable: control.settingsAvailable(),
      accountMode: config.accountMode === 'roundrobin' ? 'roundrobin' : 'single',
      activeAccount: String(config.activeAccount ?? ''),
      accounts,
      ready: usable,
      models,
      pinnedModels: pinned,
      catalogCount: Number(store.catalog()?.ids?.length ?? 0),
      historySize: store.historySize(),
    }
  }

  /** Store one credential literal under its reference. */
  async function keySet(payload) {
    const ref = String(payload?.ref ?? '').trim()
    const value = String(payload?.value ?? '').trim()
    if (ref.length === 0) throw new Error('storing a key needs the credential reference it belongs to')
    if (value.length === 0) throw new Error('the key is empty')
    await control.setCredential(ref, value)
    return { ref, stored: true, ...(await state()) }
  }

  /**
   * Verify one account by making a single tiny real request.
   *
   * A value supplied here is tested WITHOUT being stored, so a user can check a
   * key before committing it.
   */
  async function keyTest(payload) {
    const typed = String(payload?.value ?? '').trim()
    const ref = String(payload?.ref ?? '').trim()
    const config = readConfig()
    let key = typed
    let baseURL = String(config.baseURL ?? '')
    let label = typed.length > 0 ? '(typed key)' : ref
    if (key.length === 0) {
      if (ref.length === 0) throw new Error('testing a key needs a `value` or the `ref` of a stored account')
      const account = control.accounts().find((entry) => String(entry.apiKeyEnv) === ref)
      key = await control.readCredential(ref)
      if (key === '') throw new Error(`no key is stored at ${ref}`)
      baseURL = String(account?.baseURL ?? '') || baseURL
      label = String(account?.key ?? ref)
    }
    const model = (config.knownModels ?? [])[0] ?? 'cline-pass/glm-5.3-flash'
    const result = await engine.testAccount({ key, baseURL, model })
    return {
      ok: result.authorized === true,
      label,
      ms: Number(result.ms ?? 0),
      error: firstLine(result.error, 240),
    }
  }

  /** Add or update one account, optionally storing its key in the same step. */
  async function accountAdd(payload) {
    const name = String(payload?.name ?? '').trim()
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('the account name may use letters, digits, dot, dash and underscore only')
    const config = readConfig()
    const accounts = { ...(config.accounts ?? {}) }
    // Materialize the implicit default account before the first explicit one
    // replaces it, so a top-level key is never silently orphaned.
    if (Object.keys(accounts).length === 0) {
      accounts.default = {
        displayName: String(config.displayName ?? 'default'),
        apiKeyEnv: String(config.apiKeyEnv ?? ''),
        enabled: true,
        baseURL: '',
      }
    }
    const apiKeyEnv = String(payload?.apiKeyEnv ?? '').trim()
      || `CLINE_PASS_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_KEY`
    accounts[name] = {
      displayName: String(payload?.displayName ?? '').trim() || name,
      apiKeyEnv,
      enabled: payload?.enabled !== false,
      baseURL: '',
    }
    await control.updateConfig({ accounts })
    const value = String(payload?.key ?? '').trim()
    if (value.length > 0) await control.setCredential(apiKeyEnv, value)
    return { name, apiKeyEnv, keyStored: value.length > 0, ...(await state()) }
  }

  /** Remove one account; its stored credential is left in place. */
  async function accountRemove(payload) {
    const name = String(payload?.name ?? '').trim()
    const config = readConfig()
    const accounts = { ...(config.accounts ?? {}) }
    if (accounts[name] === undefined) throw new Error(`no account named ${JSON.stringify(name)}`)
    delete accounts[name]
    const activeAccount = String(config.activeAccount ?? '') === name ? '' : config.activeAccount
    await control.updateConfig({ accounts, activeAccount })
    return { removed: name, ...(await state()) }
  }

  /** Switch the pool between a manual account and round-robin. */
  async function accountMode(payload) {
    const patch = {}
    if (payload?.mode !== undefined) patch.accountMode = payload.mode === 'roundrobin' ? 'roundrobin' : 'single'
    if (payload?.active !== undefined) patch.activeAccount = String(payload.active ?? '').trim()
    if (Object.keys(patch).length === 0) throw new Error('switching the account mode needs `mode` or `active`')
    await control.updateConfig(patch)
    return await state()
  }

  /**
   * Persist one model's pin.
   *
   * Omitted fields keep their stored value, so a single toggle in the panel
   * never rewrites the rest of the pin.
   */
  async function modelPin(payload) {
    const model = modelOf(payload)
    const config = readConfig()
    const current = config.perModel?.[model] ?? {}
    const next = {
      upstreams: Array.isArray(payload?.upstreams) ? payload.upstreams.map(String) : (current.upstreams ?? []).map(String),
      exclude: Array.isArray(payload?.exclude) ? payload.exclude.map(String) : (current.exclude ?? []).map(String),
      pinMode: payload?.pinMode === 'preferred' || payload?.pinMode === 'strict'
        ? payload.pinMode
        : (current.pinMode === 'preferred' ? 'preferred' : 'strict'),
      sort: payload?.sort === undefined
        ? (current.sort ?? '')
        : (payload.sort === 'none' || payload.sort === '' ? '' : String(payload.sort)),
    }
    await control.updateConfig({ perModel: { ...(config.perModel ?? {}), [model]: next } })
    return { model, pin: next, ...(await state()) }
  }

  /** Discover one model's pipeline and channel list (one tiny real request). */
  async function modelProbe(payload) {
    const model = modelOf(payload)
    const result = await engine.probe(model)
    return { model, result: { ...result, error: firstLine(result.error, 300) } }
  }

  /** Test every known channel of one model and record the verdicts. */
  async function modelValidate(payload) {
    const model = modelOf(payload)
    const meta = store.metaOf(model)
    if (!Array.isArray(meta.upstreams) || meta.upstreams.length === 0) {
      throw new Error('no known channels yet: probe this model first')
    }
    const outcome = await engine.validate(model)
    return {
      model,
      summary: outcome.summary,
      results: outcome.results.map((result) => ({
        upstream: String(result.upstream),
        status: String(result.status),
        ms: Number(result.ms ?? 0),
        note: firstLine(result.note, 160),
      })),
      ...(await state()),
    }
  }

  /** Try one pin without persisting it, and report what actually served it. */
  async function modelTest(payload) {
    const model = modelOf(payload)
    const result = await engine.test(model, {
      upstreams: Array.isArray(payload?.upstreams) ? payload.upstreams.map(String) : undefined,
      exclude: Array.isArray(payload?.exclude) ? payload.exclude.map(String) : undefined,
    })
    return {
      model,
      ok: result.ok === true,
      error: firstLine(result.error, 300),
      actual: String(result.actual ?? ''),
      pipeline: String(result.pipeline ?? ''),
      ms: Number(result.ms ?? 0),
      content: String(result.content ?? '').slice(0, 120),
      trace: (result.trace ?? []).map((entry) => ({
        upstream: String(entry.upstream ?? '(auto)'),
        status: Number(entry.status ?? 0),
        ms: Number(entry.ms ?? 0),
        note: firstLine(entry.note, 160),
      })),
    }
  }

  /** Rescan the official subscription list and adopt newly published models. */
  async function modelsRefresh() {
    const scan = await control.refreshCatalog()
    return { added: scan.added.map(String), sources: (scan.sources ?? []).map(String), ...(await state()) }
  }

  /**
   * The one-click path: probe, measure every channel, pin the ones that
   * answered in preference order, then verify with a real call. Nothing usable
   * leaves the model on automatic routing rather than pinned to a dead channel.
   */
  async function setupAuto(payload) {
    const model = modelOf(payload)
    // Every return path carries the same keys, so a caller can render one shape
    // without guarding each field.
    const shape = {
      model, ok: false, stage: 'probe', error: '', pipeline: '', channels: [],
      pinned: [], excluded: [], available: [], rateLimited: [], unusable: [],
      verified: false, actual: '', summary: { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 },
    }
    const probe = await engine.probe(model)
    if (probe.ok !== true) {
      return { ...shape, error: firstLine(probe.error, 300) }
    }
    const channels = (store.metaOf(model).upstreams ?? []).map(String).slice(0, AUTO_MAX_CHANNELS)
    if (channels.length === 0) {
      return {
        ...shape,
        stage: 'discover',
        pipeline: String(probe.pipeline ?? ''),
        error: 'the gateway disclosed no channels for this model; it stays on automatic routing',
      }
    }
    const validated = await engine.validate(model)
    const statusOf = new Map(validated.results.map((result) => [String(result.upstream), String(result.status)]))
    const usable = channels.filter((channel) => rankVerdict(statusOf.get(channel)) === VERDICT_RANK.ok)
    const limited = channels.filter((channel) => rankVerdict(statusOf.get(channel)) === VERDICT_RANK.limited)
    const broken = channels.filter((channel) => rankVerdict(statusOf.get(channel)) >= VERDICT_RANK.bad)
    // A measured-fast channel leads; the rest keep the measured availability
    // order so failover walks from healthy to merely busy.
    const bySpeed = (list) => [...list].sort((left, right) => {
      const timeOf = (name) => Number(validated.results.find((result) => String(result.upstream) === name)?.ms ?? Number.MAX_SAFE_INTEGER)
      return timeOf(left) - timeOf(right)
    })
    const preferred = [...bySpeed(usable), ...limited]
    const pin = {
      upstreams: preferred.length > 0 ? preferred : [],
      exclude: broken,
      pinMode: 'preferred',
      sort: preferred.length > 1 ? 'ttft' : '',
    }
    await modelPin({ model, ...pin })
    let verified = { ok: false, error: 'no candidate was tried' }
    if (preferred.length > 0) verified = await engine.test(model)
    const stored = readConfig().perModel?.[model] ?? {}
    return {
      ...shape,
      stage: 'done',
      ok: preferred.length > 0 && verified.ok === true,
      pipeline: String(probe.pipeline ?? ''),
      channels,
      pinned: (stored.upstreams ?? []).map(String),
      excluded: (stored.exclude ?? []).map(String),
      available: usable,
      rateLimited: limited,
      unusable: broken,
      verified: verified.ok === true,
      actual: String(verified.actual ?? ''),
      error: preferred.length > 0 && verified.ok === true ? '' : firstLine(verified.error, 300),
      summary: validated.summary,
    }
  }

  /** Drop one model's pin and return it to automatic routing. */
  async function modelReset(payload) {
    return await modelPin({ model: modelOf(payload), upstreams: [], exclude: [], sort: 'none', pinMode: 'preferred' })
  }

  /** The live request history, newest first. */
  async function history(payload) {
    const limit = Number.isSafeInteger(payload?.limit) && payload.limit > 0 ? Math.min(payload.limit, 100) : 25
    return {
      total: store.historySize(),
      entries: store.readHistory(limit, String(payload?.model ?? '')).map((entry) => ({
        ts: Number(entry.ts ?? 0),
        model: String(entry.model ?? ''),
        provider: String(entry.provider ?? ''),
        account: String(entry.account ?? ''),
        ms: Number(entry.ms ?? 0),
        stream: entry.stream === true,
        error: firstLine(entry.error, 200),
      })),
    }
  }

  return {
    state,
    'key.set': keySet,
    'key.test': keyTest,
    'account.add': accountAdd,
    'account.remove': accountRemove,
    'account.mode': accountMode,
    'model.pin': modelPin,
    'model.probe': modelProbe,
    'model.validate': modelValidate,
    'model.test': modelTest,
    'model.reset': modelReset,
    'models.refresh': modelsRefresh,
    'setup.auto': setupAuto,
    history,
  }
}

/**
 * Publish the panel API inside Connection's authentication fence.
 *
 * An exact Fetch route on the shared `/api` channel is the only way a plugin
 * gets that prefix: Connection owns it, so registering our own would collide.
 * Joining it inherits the same Host/Origin fence and browser-cookie
 * authentication, with no extra port and no unauthenticated surface.
 *
 * @param options - `{ control, engine, store, logger }`.
 * @returns the disposer, or undefined when no route was registered.
 */
export function registerPanel(ctx, { control, engine, store, logger }) {
  const endpoints = createPanel({ control, engine, store })
  const handle = async (endpoint, payload) => {
    const route = endpoints[endpoint]
    if (route === undefined) {
      return { ok: false, error: { code: PANEL_ERROR_CODE, message: `unknown panel action ${JSON.stringify(endpoint)}`, details: {} } }
    }
    try {
      return { ok: true, value: await route(payload ?? {}) }
    } catch (error) {
      return {
        ok: false,
        error: { code: PANEL_ERROR_CODE, message: firstLine(error?.message ?? error, 400), details: {} },
      }
    }
  }

  const dispose = ctx.inject(['connection'], (connectionCtx) => {
    const registered = connectionCtx.connection.fetch.register({
      path: PANEL_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return Response.json(
            { ok: false, error: { code: PANEL_ERROR_CODE, message: 'the request body is not JSON', details: {} } },
            { status: 400, headers: { 'cache-control': 'no-store' } },
          )
        }
        // Every action is one dispatch entry, so one route carries the whole
        // panel and the browser names the action it wants.
        const result = await handle(String(body?.endpoint ?? ''), body?.payload)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
      },
    })
    logger?.info('[cline-pass] setup panel route %s published', PANEL_PATH)
    return registered
  })
  return dispose
}
