/**
 * The engine: account selection, pinned request chains with failover, probing,
 * validation, and request recording. It owns every network call, so the adapter
 * and the management tools apply identical pinning semantics.
 *
 * Failover contract: a candidate is abandoned only while nothing has been
 * delivered yet. A non-2xx, a transport failure, or an error payload before the
 * first content delta moves to the next candidate; once a chunk has been
 * produced the stream is the answer, and a later failure is reported as such.
 *
 * @module dsh-cline-pass/engine
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  chatCompletion,
  fetchGatewayCatalog,
  fetchOfficialModels,
  openChatStream,
  openRouterEndpoints,
} from './cline.js'
import {
  buildAttempts,
  classifyUpstreamError,
  errorText,
  extractAvailableProviders,
  injectPrefs,
  mergeUpstreams,
  parseRouting,
  parseTier0,
  unwrapEnvelope,
} from './protocol.js'

/** How many upstreams are validated concurrently. */
const VALIDATE_CONCURRENCY = 5

/**
 * Parse an SSE body into decoded JSON frames.
 * @param body - a web ReadableStream of UTF-8 bytes.
 * @returns every `data:` payload up to `[DONE]`.
 */
export async function* parseServerSentEvents(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line.length === 0 || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        yield '[DONE]'
        return
      }
      try {
        yield JSON.parse(payload)
      } catch { /* an unparseable frame carries nothing to deliver */ }
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload === '[DONE]') {
      yield '[DONE]'
      return
    }
    if (payload.length > 0) {
      try {
        yield JSON.parse(payload)
      } catch { /* see above */ }
    }
  }
  throw new LlmError('stream ended without [DONE]', 'STREAM_CLOSED')
}

/**
 * Create the engine.
 *
 * @param options.resolveAccount - async `() => { name, key, baseURL }`; called
 *   once per attempt, so round-robin pools rotate per attempt.
 * @param options.store - the observation store (probe results, history).
 * @param options.logger - optional Cordis logger.
 * @param options.attemptTimeoutMs - per-attempt budget for a chat request.
 * @param options.probeTimeoutMs - budget for probe/validate requests.
 */
export function createEngine({
  resolveAccount,
  store,
  logger,
  attemptTimeoutMs = 180000,
  probeTimeoutMs = 60000,
}) {
  /**
   * One pinned request, non-streaming.
   * @returns `{ status, ok, json, text, routing, attempt, account }`.
   */
  async function attemptChat(model, body, attempt, { signal, timeoutMs = attemptTimeoutMs } = {}) {
    const account = await resolveAccount()
    const pinned = injectPrefs(body, store.metaOf(model), attempt)
    const started = Date.now()
    const result = await chatCompletion({
      baseURL: account.baseURL,
      apiKey: account.key,
      body: pinned,
      signal,
      timeoutMs,
    })
    const payload = unwrapEnvelope(result.json)
    const failed = result.ok !== true || (payload?.error !== undefined && payload?.choices === undefined)
    return {
      attempt,
      account,
      status: failed ? (payload?.error === undefined ? result.status : 502) : 200,
      ok: !failed,
      json: payload,
      text: result.text,
      ms: Date.now() - started,
      routing: failed ? {} : parseRouting(payload),
      error: failed ? (errorText(payload?.error) || result.text.slice(0, 400) || `HTTP ${result.status}`) : '',
    }
  }

  /**
   * Run one model's ordered candidate chain until an attempt succeeds.
   * @returns `{ ok, result?, trace, error }` — `result` is the winning attempt.
   */
  async function runChain(model, body, pinConfig, { signal, timeoutMs } = {}) {
    const trace = []
    let last = null
    for (const attempt of buildAttempts(pinConfig)) {
      const outcome = await attemptChat(model, body, attempt, { signal, timeoutMs })
      trace.push({ upstream: attempt.upstream ?? '(auto)', status: outcome.status, ms: outcome.ms, note: outcome.error === '' ? 'ok' : outcome.error.slice(0, 160) })
      last = outcome
      if (outcome.ok) return { ok: true, result: outcome, trace, error: '' }
      // A channel that refuses a strict pin is learned as unusable for it.
      if (attempt.upstream !== null && outcome.error !== '') store.learnUpstream(model, attempt.upstream, classifyUpstreamError(outcome.error), outcome.error, outcome.ms)
      if (attempt.upstream === null && (attempt.excludeList ?? []).length > 0 && outcome.error !== '') learnFromError(model, outcome.error)
    }
    return { ok: false, result: last, trace, error: last?.error ?? 'no candidate succeeded' }
  }

  /** Merge a gateway error's own provider list into the model's channel list. */
  function learnFromError(model, message) {
    const match = /Available providers are:\s*([^.]+)/.exec(String(message ?? ''))
    if (match === null) return
    const tokens = match[1].split(/,\s*/).map((token) => token.trim()).filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    if (tokens.length === 0) return
    const meta = store.metaOf(model)
    const merged = mergeUpstreams(meta.upstreams ?? [], tokens)
    if (merged.length !== (meta.upstreams ?? []).length) store.learn(model, { upstreams: merged })
  }

  /**
   * Probe one model: detect its pipeline, read back the upstream it used, and
   * harvest the precise channel list for that pipeline. Costs one tiny request.
   */
  async function probe(model, { signal, timeoutMs = attemptTimeoutMs } = {}) {
    const account = await resolveAccount()
    const started = Date.now()
    const result = await chatCompletion({
      baseURL: account.baseURL,
      apiKey: account.key,
      body: { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 },
      signal,
      timeoutMs,
    })
    const payload = unwrapEnvelope(result.json)
    const ms = Date.now() - started
    if (payload?.error !== undefined && payload?.choices === undefined) {
      const message = errorText(payload.error)
      store.learn(model, { ok: false, lastError: message, lastMs: ms })
      return { ok: false, ms, model, error: message }
    }
    const routing = parseRouting(payload)
    const pipeline = routing.pipeline
    let harvested = null
    if (pipeline !== null) harvested = await harvest(model, pipeline, account, { signal, timeoutMs: probeTimeoutMs })
    let endpoints = []
    let openrouterSlug = null
    if (pipeline !== 'planner' && typeof routing.canonicalSlug === 'string') {
      const detail = await openRouterEndpoints(routing.canonicalSlug, { signal, timeoutMs: probeTimeoutMs })
      endpoints = detail.endpoints
      openrouterSlug = detail.slug
    }
    const previous = store.metaOf(model)
    const upstreamDetail = { ...(previous.upstreamDetail ?? {}) }
    for (const entry of endpoints) upstreamDetail[entry.slug] = entry
    const upstreams = pipeline === 'planner'
      ? mergeUpstreams(harvested, routing.fallbacks)
      : mergeUpstreams(routing.fallbacks, harvested, Object.keys(upstreamDetail))
    const tier0 = [...new Set([...(previous.tier0 ?? []), ...parseTier0(routing.plan)])]
    const meta = store.learn(model, {
      ok: true,
      pipeline,
      pinnable: pipeline !== null,
      availableProviders: harvested ?? previous.availableProviders ?? [],
      canonicalSlug: routing.canonicalSlug ?? previous.canonicalSlug ?? null,
      openrouterSlug: openrouterSlug ?? previous.openrouterSlug ?? null,
      upstreamDetail,
      upstreams,
      tier0,
      lastProvider: routing.finalProvider ?? previous.lastProvider ?? null,
      lastMs: ms,
      probedAt: Date.now(),
      lastError: '',
    })
    return {
      ok: true,
      ms,
      model,
      error: '',
      pipeline: meta.pipeline,
      pinnable: meta.pinnable === true,
      canonicalSlug: meta.canonicalSlug ?? '',
      lastProvider: meta.lastProvider ?? '',
      upstreams: meta.upstreams ?? [],
      availableProviders: meta.availableProviders ?? [],
      tier0: meta.tier0 ?? [],
    }
  }

  /**
   * Harvest the exact channel list for one pipeline by pinning a channel that
   * cannot exist: the router fails before spending a token and names every
   * provider it could have used.
   */
  async function harvest(model, pipeline, account, { signal, timeoutMs = probeTimeoutMs } = {}) {
    const base = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }
    const body = pipeline === 'planner'
      ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
      : { ...base, provider: { only: ['__probe__'] } }
    try {
      const result = await chatCompletion({ baseURL: account.baseURL, apiKey: account.key, body, signal, timeoutMs })
      const payload = unwrapEnvelope(result.json)
      const message = errorText(payload?.error) || result.text
      return extractAvailableProviders(message, pipeline)
    } catch {
      return null
    }
  }

  /**
   * Test every known channel of a model once and record the verdicts.
   * @returns `{ results: [{ upstream, status, ms, note }], summary }`.
   */
  async function validate(model, { signal, timeoutMs = probeTimeoutMs } = {}) {
    const meta = store.metaOf(model)
    const list = Array.isArray(meta.upstreams) ? meta.upstreams : []
    const pipeline = meta.pipeline ?? null
    const results = []
    for (let index = 0; index < list.length; index += VALIDATE_CONCURRENCY) {
      const batch = list.slice(index, index + VALIDATE_CONCURRENCY)
      const settled = await Promise.all(batch.map(async (upstream) => {
        const started = Date.now()
        const base = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }
        const body = pipeline === 'planner'
          ? { ...base, providerOptions: { gateway: { only: [upstream] } } }
          : { ...base, provider: { only: [upstream] } }
        try {
          const account = await resolveAccount()
          const result = await chatCompletion({ baseURL: account.baseURL, apiKey: account.key, body, signal, timeoutMs })
          const payload = unwrapEnvelope(result.json)
          const ms = Date.now() - started
          let status = 'unknown'
          let note = ''
          if (payload?.error !== undefined && payload?.choices === undefined) {
            note = errorText(payload.error)
            status = classifyUpstreamError(note)
          } else if (payload?.choices !== undefined) {
            status = 'ok'
          }
          return { upstream, status, ms, note: note.slice(0, 160) }
        } catch (error) {
          return { upstream, status: 'unknown', ms: Date.now() - started, note: errorText(error).slice(0, 160) }
        }
      }))
      for (const result of settled) {
        store.learnUpstream(model, result.upstream, result.status, result.note, result.ms)
        results.push(result)
      }
    }
    const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 }
    for (const result of results) summary[result.status] = (summary[result.status] ?? 0) + 1
    store.learn(model, { validatedAt: Date.now() })
    return { results, summary }
  }

  /**
   * Send one small chat through a (possibly temporary) pin configuration and
   * report what served it. Nothing is persisted.
   */
  async function test(model, { upstreams, exclude, signal } = {}) {
    const pin = currentPin(model, { upstreams, exclude })
    const started = Date.now()
    const outcome = await runChain(model, { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 }, pin, { signal, timeoutMs: attemptTimeoutMs })
    const ms = Date.now() - started
    if (!outcome.ok) {
      record(model, { provider: null, attempts: outcome.trace.map((row) => row.upstream), ms, stream: false, error: outcome.error, account: outcome.result?.account?.name ?? null })
      return { ok: false, ms, model, error: outcome.error, targets: pin.upstreams ?? [], excluded: pin.exclude ?? [], trace: outcome.trace, actual: '', content: '', account: outcome.result?.account?.name ?? '' }
    }
    const routing = outcome.result.routing
    record(model, { provider: routing.finalProvider, canonical: routing.canonicalSlug, attempts: outcome.trace.map((row) => row.upstream), ms, stream: false, error: null, account: outcome.result.account?.name ?? null })
    return {
      ok: true,
      ms,
      model,
      error: '',
      targets: pin.upstreams ?? [],
      excluded: pin.exclude ?? [],
      trace: outcome.trace,
      actual: routing.finalProvider ?? '',
      actualName: routing.finalProviderName ?? '',
      pipeline: routing.pipeline ?? '',
      pinnable: routing.pipeline !== null,
      canonicalSlug: routing.canonicalSlug ?? '',
      account: outcome.result.account?.name ?? '',
      content: String(routing.content ?? '').slice(0, 120),
    }
  }

  /**
   * Check one account key against the gateway with a single small request.
   *
   * A key that authenticates but whose model still errors (a reasoning model
   * burning `max_tokens` into an empty completion, for example) counts as
   * authorized: only a real authentication failure is reported as one.
   */
  async function testAccount({ key, baseURL, model, signal, timeoutMs = probeTimeoutMs }) {
    const started = Date.now()
    try {
      const result = await chatCompletion({
        baseURL,
        apiKey: key,
        body: { model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 },
        signal,
        timeoutMs,
      })
      const payload = unwrapEnvelope(result.json)
      const ms = Date.now() - started
      if (payload?.error !== undefined && payload?.choices === undefined) {
        const message = errorText(payload.error)
        const authFailed = /unauthorized|re-authenticate|invalid\s*api|401/i.test(message)
        return { ok: !authFailed, authorized: !authFailed, ms, model, error: message }
      }
      return { ok: true, authorized: true, ms, model, error: '' }
    } catch (error) {
      return { ok: false, authorized: false, ms: Date.now() - started, model, error: errorText(error) }
    }
  }

  /** Resolve a per-call pin override against the stored configuration. */
  function currentPin(model, override = {}) {
    const stored = pinOf(model)
    return {
      upstreams: Array.isArray(override.upstreams) ? override.upstreams.map(String) : stored.upstreams,
      exclude: Array.isArray(override.exclude) ? override.exclude.map(String) : stored.exclude,
      pinMode: stored.pinMode,
      sort: stored.sort,
    }
  }

  /** The configured pin for one model, read through the plugin's live config. */
  let pinReader = () => ({ upstreams: [], exclude: [], pinMode: 'strict', sort: null })
  const pinOf = (model) => pinReader(model)

  /** Record one request in the observation store. */
  function record(model, info) {
    store.record({ model, ...info })
  }

  return {
    /** Replace the function that reads a model's configured pin. */
    setPinReader(reader) {
      pinReader = reader
    },
    /** Refresh the gateway's own catalog ids. */
    async gatewayCatalog(options = {}) {
      const account = await resolveAccount()
      return await fetchGatewayCatalog({ baseURL: account.baseURL, apiKey: account.key, ...options })
    },
    /** Refresh the official subscription model list. */
    async officialModels(options = {}) {
      return await fetchOfficialModels(options)
    },
    /** The resolved account for the next request (round-robin aware). */
    resolveAccount,
    attemptChat,
    runChain,
    probe,
    validate,
    test,
    testAccount,
    currentPin,
    record,
    learnFromError,
    chatCompletion,
    openChatStream,
    parseServerSentEvents,
    buildAttempts,
    injectPrefs,
  }
}
