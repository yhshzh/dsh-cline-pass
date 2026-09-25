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
import { fetchUsageLimits } from './cline.js'
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
 * Project one model from the live configuration plus what the store observed.
 *
 * `hidden` is the one field that is configuration rather than observation: the
 * route does not advertise a hidden model, so no picker offers it.
 */
export function projectModel(model, pin, meta, hidden = false) {
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
    hidden: hidden === true,
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

  /**
   * One account as the panel shows it: never the key itself.
   *
   * `declared` says whether an explicit `accounts` entry stands behind the row.
   * A lone implicit account is the top-level key and its `apiKeyEnv`, so there is
   * no entry to delete and the panel disables that button. The check is made
   * against the configuration in hand rather than trusting a flag from the host
   * half, so the two cannot disagree.
   */
  const accountView = (account, declared) => ({
    key: String(account.key),
    displayName: String(account.displayName ?? account.key),
    apiKeyEnv: String(account.apiKeyEnv ?? ''),
    enabled: account.enabled !== false,
    declared,
    keyConfigured: account.keyConfigured === true,
    keyHint: String(account.keyHint ?? ''),
  })

  /** The whole panel snapshot in one round trip. */
  async function state() {
    const config = readConfig()
    const declaredNames = new Set(Object.keys(config.accounts ?? {}))
    const accounts = (await control.accountsWithKeys()).map((account) => accountView(account, declaredNames.has(String(account.key))))
    const hidden = new Set((config.hiddenModels ?? []).map(String))
    const models = (config.knownModels ?? []).map((id) => projectModel(id, config.perModel?.[id] ?? {}, store.metaOf(id), hidden.has(String(id))))
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
      hiddenModels: models.filter((model) => model.hidden).length,
      // The last reading, never a request: refreshing quota is its own action.
      usage: store.usage(),
      catalogCount: Number(store.catalog()?.ids?.length ?? 0),
      historySize: store.historySize(),
    }
  }

  /**
   * Read every enabled account's official quota windows.
   *
   * One reading per account, because the windows belong to the account: a pool in
   * round-robin mode has no single "current" quota, and showing one account's
   * figure was the thing that made this card wrong with more than one account
   * configured. Keys are resolved on this side and never cross the wire.
   */
  async function usage() {
    const config = readConfig()
    const accounts = await control.usageAccounts()
    if (accounts.length === 0) throw new Error('every configured Cline Pass account is disabled; enable one first')
    const readings = await Promise.all(accounts.map(async (account) => {
      // The reading is keyed by the configuration name, but the panel's switcher
      // shows the name the accounts card shows, so both travel together.
      const label = {
        account: account.name,
        displayName: String(account.displayName ?? '') || String(account.name),
      }
      if (account.keyConfigured !== true) return { ...label, ok: false, limits: [], error: `no API key stored for ${account.name}` }
      const result = await fetchUsageLimits({
        baseURL: account.baseURL || String(config.baseURL ?? ''),
        apiKey: account.key,
      })
      return { ...label, ...result }
    }))
    const reading = store.setUsage({ accounts: readings })
    return { ...(await state()), usage: reading }
  }



  /**
   * Show or hide one model in every picker this route feeds.
   *
   * The subscription list is never edited here: a hidden model stays known, so
   * un-hiding it is one click instead of a catalog refresh.
   */
  async function modelVisibility(payload) {
    const model = modelOf(payload)
    const config = readConfig()
    if (!(config.knownModels ?? []).map(String).includes(model)) {
      throw new Error(`${JSON.stringify(model)} is not one of this route's subscription models`)
    }
    const hidden = new Set((config.hiddenModels ?? []).map(String))
    if (payload?.visible === false) hidden.add(model)
    else hidden.delete(model)
    await control.updateConfig({ hiddenModels: [...hidden] })
    return { model, visible: !hidden.has(model), ...(await state()) }
  }

  /**
   * Show, hide or swap every subscription model at once.
   *
   * `all` clears the hidden set, `none` hides everything, and `invert` swaps the
   * two — which is what "check all / invert" means to a user looking at a column
   * of checkboxes. Every mode writes the set once, so no per-model round trip can
   * half-apply a bulk change.
   *
   * Ids the route no longer lists are dropped on the way out: a model removed
   * from the subscription would otherwise sit in `hiddenModels` forever, ready to
   * hide a model that comes back under the same id.
   */
  async function modelsVisibility(payload) {
    const mode = String(payload?.mode ?? '')
    if (mode !== 'all' && mode !== 'none' && mode !== 'invert') {
      throw new Error('mode must be one of "all", "none" or "invert"')
    }
    const config = readConfig()
    const known = (config.knownModels ?? []).map(String)
    const hidden = new Set((config.hiddenModels ?? []).map(String))
    const next = []
    for (const id of known) {
      const wasHidden = hidden.has(id)
      if (mode === 'all' ? false : mode === 'none' ? true : !wasHidden) next.push(id)
    }
    await control.updateConfig({ hiddenModels: next })
    return { mode, hiddenModels: next.length, visibleModels: known.length - next.length, ...(await state()) }
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
    // The removal is named explicitly: the settings service merges a patch
    // recursively, so an `accounts` object that merely omits this key would
    // merge the account straight back and the delete would be a no-op.
    await control.updateConfig({ accounts, activeAccount }, [['accounts', name]])
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
   * Take one account in or out of the pool.
   *
   * `enabled` is what decides whether an account can serve a request at all — the
   * router filters on it before choosing — so this is the control that answers
   * "which accounts is this route allowed to use", and it does so without
   * deleting anything (the key stays stored for the day it is turned back on).
   *
   * Disabling the last enabled account is allowed and reports itself: every
   * request then fails with the router's own "every configured account is
   * disabled" message, and the panel falls back to the unconfigured state where
   * this very toggle is the thing on screen.
   */
  async function accountEnable(payload) {
    const name = String(payload?.name ?? '').trim()
    const enabled = payload?.enabled !== false
    const config = readConfig()
    const accounts = { ...(config.accounts ?? {}) }
    // The default account is implicit until something edits it, so materialize it
    // first — otherwise this toggle would write an empty dictionary and drop it.
    if (accounts[name] === undefined && Object.keys(accounts).length === 0 && name === 'default') {
      accounts.default = {
        displayName: String(config.displayName ?? 'default'),
        apiKeyEnv: String(config.apiKeyEnv ?? ''),
        enabled: true,
        baseURL: '',
      }
    }
    if (accounts[name] === undefined) throw new Error(`no account named ${JSON.stringify(name)}`)
    accounts[name] = { ...accounts[name], enabled }
    await control.updateConfig({ accounts })
    return { name, enabled, ...(await state()) }
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
        // Time from the request's start to the gateway's first byte, and to the
        // first chunk the caller actually saw; 0 means that moment never came.
        ttfb: Number(entry.ttfb ?? 0),
        ttft: Number(entry.ttft ?? 0),
        // What the call cost in tokens. `null` means the gateway sent no usage
        // frame, which is not the same as a call that cost nothing.
        usageReported: entry.usage !== null && entry.usage !== undefined,
        usage: {
          inputTokens: Number(entry.usage?.inputTokens ?? 0),
          outputTokens: Number(entry.usage?.outputTokens ?? 0),
          cacheReadTokens: Number(entry.usage?.cacheReadTokens ?? 0),
          reasoningTokens: Number(entry.usage?.reasoningTokens ?? 0),
        },
        effort: String(entry.effort ?? ''),
        stream: entry.stream === true,
        error: firstLine(entry.error, 200),
      })),
    }
  }

  return {
    state,
    usage,
    'key.set': keySet,
    'key.test': keyTest,
    'account.add': accountAdd,
    'account.remove': accountRemove,
    'account.mode': accountMode,
    'account.enable': accountEnable,
    'model.pin': modelPin,
    'model.visibility': modelVisibility,
    'models.visibility': modelsVisibility,
    'model.probe': modelProbe,
    'model.validate': modelValidate,
    'model.test': modelTest,
    'model.reset': modelReset,
    'models.refresh': modelsRefresh,
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
