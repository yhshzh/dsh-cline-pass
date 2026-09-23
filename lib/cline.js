/**
 * Transport for the Cline gateway and its public catalogs. Transport only: no
 * pinning, retry, or failover policy lives here (see `adapter.js`).
 *
 * - `POST {baseURL}/chat/completions` — the gateway
 * - `GET  {baseURL}/models` — the gateway's own catalog
 * - `GET  {baseURL}/users/me/plan/usage-limits` — the account's quota windows
 * - `GET  {baseURL}/users/{id}/usages` — the per-request usage history behind them
 * - `GET  api.cline.bot/.../recommended-models` — official subscription list
 * - `GET  models.dev/api.json` — community registry, a backstop
 * - `GET  openrouter.ai/api/v1/...` — endpoint detail for direct-pipeline models
 *
 * @module dsh-cline-pass/cline
 */
/** The public Cline endpoint that lists subscription models without auth. */
export const RECOMMENDED_MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'
/** The authenticated sub-path that reports quota consumption for the account. */
export const USAGE_LIMITS_PATH = '/users/me/plan/usage-limits'
/** The authenticated sub-path naming the account the usage history belongs to. */
export const PROFILE_PATH = '/users/me'
/** The authenticated sub-path carrying the account's plan and its quota caps. */
export const PLAN_PATH = '/users/me/plan'
/**
 * How many usage rows one history page returns.
 *
 * 200 is what the gateway actually hands back: asking for more is accepted and
 * silently capped, which is how a "6 page" walk can cover far less history than
 * the arithmetic suggests.
 */
export const USAGE_PAGE_SIZE = 200
/** How many history pages one row-level walk reads before it reports partial data. */
export const USAGE_MAX_PAGES = 12
/** One day in milliseconds; the line between a window read row by row and per day. */
const DAY_MS = 86_400_000
/** How many models one window reports before the tail is summarised by count. */
export const MODEL_ROWS_MAX = 8
/** The community model registry. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'
/** OpenRouter's public API, used only for direct-pipeline endpoint detail. */
export const OPENROUTER_API = 'https://openrouter.ai/api/v1'

/** Combine a caller signal with a timeout signal. */
function withTimeout(signal, timeoutMs) {
  const signals = []
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signal !== undefined && signal !== null) signals.push(signal)
  if (signals.length === 0) return undefined
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

/** Strip a trailing slash so paths can be appended literally. */
export function trimBase(baseURL) {
  return String(baseURL ?? '').trim().replace(/\/+$/, '')
}

/**
 * The gateway's own chat-completions endpoint for one base URL.
 * @param baseURL - e.g. `https://api.cline.bot/api/v1`.
 */
export function chatURL(baseURL) {
  return `${trimBase(baseURL)}/chat/completions`
}

/**
 * Send one JSON request and decode whatever comes back.
 * @returns `{ status, ok, json, text }`; never throws for an HTTP error status.
 */
export async function sendJSON(url, { method = 'GET', apiKey = '', body, signal, timeoutMs = 60000, headers = {} } = {}) {
  const outgoing = {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: withTimeout(signal, timeoutMs),
  }
  const response = await fetch(url, outgoing)
  const text = await response.text()
  let json = null
  if (text.length > 0) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: response.status, ok: response.ok, json, text }
}

/**
 * Send one chat completion, non-streaming.
 * @returns `{ status, ok, json, text }` with the gateway envelope already unwrapped by the caller.
 */
export function chatCompletion(options) {
  const { baseURL, apiKey, body, signal, timeoutMs = 180000 } = options
  return sendJSON(chatURL(baseURL), { method: 'POST', apiKey, body, signal, timeoutMs })
}

/**
 * Open a streaming chat completion and hand back the live response.
 * @returns the raw `fetch` Response so the caller owns SSE iteration and abort.
 */
export async function openChatStream({ baseURL, apiKey, body, signal, headers = {} }) {
  return await fetch(chatURL(baseURL), {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * List the gateway's own catalog ids.
 * @returns the model ids; an empty array when the call fails or returns nothing.
 */
export async function fetchGatewayCatalog({ baseURL, apiKey, signal, timeoutMs = 30000 }) {
  try {
    const result = await sendJSON(`${trimBase(baseURL)}/models`, { apiKey, signal, timeoutMs })
    const ids = (result.json?.data ?? []).map((model) => model?.id).filter((id) => typeof id === 'string')
    return ids
  } catch {
    return []
  }
}

/**
 * Read the account's official quota consumption.
 *
 * The gateway answers with `{ success, data: { limits: [{ type, percentUsed,
 * resetsAt }] } }`, where `type` is `five_hour`, `weekly` or `monthly`. The
 * window list is passed through in the order the gateway sends it rather than
 * mapped onto a fixed shape here, so a window Cline adds later reaches the panel
 * as an extra row instead of needing a release of this plugin.
 *
 * A refusal is reported as data, never thrown: the panel shows quota beside
 * controls that keep working without it.
 *
 * @returns `{ ok, limits, error }`.
 */
export async function fetchUsageLimits({ baseURL, apiKey, signal, timeoutMs = 30000 }) {
  const refusal = { ok: false, limits: [], error: 'the usage endpoint is unavailable' }
  try {
    const result = await sendJSON(`${trimBase(baseURL)}${USAGE_LIMITS_PATH}`, { apiKey, signal, timeoutMs })
    const envelope = result.json
    if (!result.ok) {
      const detail = firstMessage(envelope) ?? result.text.slice(0, 120)
      return { ...refusal, error: `the usage endpoint answered HTTP ${result.status}${detail === '' ? '' : `: ${detail}`}` }
    }
    // The envelope wrapper is not contractual: read the payload whether the
    // gateway nests it under `data` or answers with the window list itself.
    const payload = envelope?.data ?? envelope
    const limits = (Array.isArray(payload?.limits) ? payload.limits : [])
      .map((limit) => ({
        type: String(limit?.type ?? ''),
        percentUsed: Number(limit?.percentUsed ?? 0),
        resetsAt: String(limit?.resetsAt ?? ''),
      }))
      .filter((limit) => limit.type.length > 0)
    return { ok: true, limits, error: firstMessage(envelope) ?? '' }
  } catch (error) {
    return { ...refusal, error: String(error?.message ?? error) }
  }
}

/** The gateway's own one-line explanation, when it sent one. */
function firstMessage(envelope) {
  const message = envelope?.error ?? envelope?.message ?? envelope?.error?.message
  return typeof message === 'string' ? message.slice(0, 200) : ''
}

/** A `YYYY-MM-DD` day, in UTC, as the daily endpoint expects it. */
function dayStamp(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Read the account's plan and the money cap behind each quota window.
 *
 * This is what makes a percentage mean something. Cline measures a window in
 * COST — the cap fields are literally `last5HoursUsageCostUSDPerUser`,
 * `last7daysUsageCostUSDPerUser`, `last30daysUsageCostUSDPerUser` — so "10%" is
 * a share of a dollar figure that only the plan can name. Token counts are a
 * proxy at best: the same tokens on a cheaper model move the quota less.
 *
 * @returns `{ ok, caps, planName, error }` — caps in USD per window type.
 */
export async function fetchPlan({ baseURL, apiKey, signal, timeoutMs = 30000 }) {
  const refusal = { ok: false, caps: {}, planName: '', error: 'the plan endpoint is unavailable' }
  try {
    const result = await sendJSON(`${trimBase(baseURL)}${PLAN_PATH}`, { apiKey, signal, timeoutMs })
    const envelope = result.json
    if (!result.ok) {
      const detail = firstMessage(envelope)
      return { ...refusal, error: `the plan endpoint answered HTTP ${result.status}${detail === '' ? '' : `: ${detail}`}` }
    }
    const payload = envelope?.data ?? envelope
    const plan = payload?.plan ?? payload
    // The cap can hang off the plan or the entitlement, depending on how the
    // gateway wrapped it; both spellings are read rather than guessed.
    const entitlement = plan?.entitlements?.cline_pass ?? payload?.entitlements?.cline_pass ?? {}
    const threshold = entitlement?.inferenceCapThreshold ?? {}
    const caps = {
      five_hour: Number(threshold?.last5HoursUsageCostUSDPerUser ?? 0),
      weekly: Number(threshold?.last7daysUsageCostUSDPerUser ?? 0),
      monthly: Number(threshold?.last30daysUsageCostUSDPerUser ?? 0),
    }
    const planName = String(plan?.displayName ?? plan?.name ?? '')
    const known = Object.values(caps).some((cap) => cap > 0)
    return { ok: known, caps, planName, error: known ? '' : 'the plan names no quota cap' }
  } catch (error) {
    return { ...refusal, error: String(error?.message ?? error) }
  }
}

/**
 * One range of per-day usage, from the gateway's own aggregation.
 *
 * One request covers the whole range, which is the only way a complete reading
 * exists at all: the detailed history pages at 200 rows, so a busy account's
 * month cannot be walked row by row — an earlier version tried and stopped at
 * 1200 rows, reporting the same figure for "this week" and "this month".
 *
 * Rows are per day AND per model, so they sum along either axis. The model is
 * kept here rather than flattened away: which models a window's spend went to is
 * the question a quota figure cannot answer, and it is the one that decides where
 * to change behaviour.
 *
 * @returns `{ ok, rows, error }` — `rows` carries `{ date, model, tokens, costUsd }`.
 */
export async function fetchDailyUsage({ baseURL, apiKey, userId, startDate, endDate, signal, timeoutMs = 45000 }) {
  const refusal = { ok: false, rows: [], error: 'the daily usage endpoint is unavailable' }
  try {
    const query = `${trimBase(baseURL)}/users/${encodeURIComponent(userId)}/usages/daily?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    const result = await sendJSON(query, { apiKey, signal, timeoutMs })
    const envelope = result.json
    if (!result.ok) {
      const detail = firstMessage(envelope)
      return { ...refusal, error: `the daily usage endpoint answered HTTP ${result.status}${detail === '' ? '' : `: ${detail}`}` }
    }
    const payload = envelope?.data ?? envelope
    const rows = (Array.isArray(payload?.items) ? payload.items : []).map((row) => ({
      date: String(row?.date ?? ''),
      // `aiModelName` is the wire spelling; the type name is the fallback so a
      // row still lands somewhere named rather than in an anonymous bucket.
      model: String(row?.aiModelName ?? row?.aiModelTypeName ?? ''),
      tokens: Number(row?.promptTokens ?? 0) + Number(row?.completionTokens ?? 0),
      costUsd: Number(row?.costUsd ?? 0),
    }))
    return { ok: true, rows, error: '' }
  } catch (error) {
    return { ...refusal, error: String(error?.message ?? error) }
  }
}

/**
 * What each quota window cost and consumed.
 *
 * Two readings, chosen per window by whether a day can resolve it:
 *
 * - A window SHORTER than a day (the five-hour one) starts mid-day, and the
 *   daily aggregation cannot tell that day's in-window share from its total, so
 *   it is walked row by row through the detailed history. Those rows carry exact
 *   timestamps and a cost, so this reading is exact.
 * - A window of a day or more is summed from the daily aggregation, one request
 *   each. Its first day is included whole whenever the window does not begin at
 *   midnight — the gateway's windows are aligned to the subscription period, not
 *   to the calendar — so those readings are upper bounds, reported as `exact:
 *   false` rather than quietly rounded.
 *
 * A failure is reported as data, never thrown.
 *
 * @param options - `{ baseURL, apiKey, windows }`, each window
 * `{ type, startMs, endMs }`.
 * @returns `{ ok, windows, pages, partial, error }`.
 */
export async function fetchUsageWindows({
  baseURL,
  apiKey,
  windows,
  pageSize = USAGE_PAGE_SIZE,
  maxPages = USAGE_MAX_PAGES,
  signal,
  timeoutMs = 60000,
}) {
  const readings = windows.map((window) => ({
    type: String(window.type),
    tokens: 0,
    costUsd: 0,
    requests: 0,
    days: 0,
    exact: false,
    error: '',
    startMs: Number(window.startMs),
    /** Per-model totals, keyed by model name; converted to a list by `finish`. */
    models: new Map(),
  }))
  const byType = new Map(readings.map((reading) => [reading.type, reading]))

  /**
   * Add one row's usage to a window, under the model that produced it.
   *
   * Both readings below call this, so the per-model split stays consistent with
   * the window total by construction — a window's models always add up to it.
   */
  const addUsage = (reading, model, tokens, costUsd, kind) => {
    reading.tokens += tokens
    reading.costUsd += costUsd
    if (kind === 'request') reading.requests += 1
    const name = String(model ?? '')
    const bucket = reading.models.get(name) ?? { model: name, tokens: 0, costUsd: 0, requests: 0, days: 0 }
    bucket.tokens += tokens
    bucket.costUsd += costUsd
    if (kind === 'request') bucket.requests += 1
    else bucket.days += 1
    reading.models.set(name, bucket)
  }

  const finish = (extra) => ({
    ok: extra.ok === true,
    // A model list is only useful ranked, and only the leaders change a decision.
    windows: readings.map(({ models, ...reading }) => ({
      ...reading,
      models: [...models.values()]
        .sort((left, right) => right.costUsd - left.costUsd || right.tokens - left.tokens)
        .slice(0, MODEL_ROWS_MAX),
      modelCount: models.size,
    })),
    pages: Number(extra.pages ?? 0),
    partial: extra.partial === true,
    error: extra.error ?? '',
  })
  try {
    const base = trimBase(baseURL)
    const profile = await sendJSON(`${base}${PROFILE_PATH}`, { apiKey, signal, timeoutMs: 20000 })
    const profileBody = profile.json?.data ?? profile.json
    const userId = typeof profileBody?.id === 'string' ? profileBody.id : ''
    if (!profile.ok || userId === '') {
      return finish({ error: `the profile endpoint answered HTTP ${profile.status}${profile.ok ? ' without an account id' : ''}` })
    }

    let pages = 0
    let partial = false
    const rowWindows = windows.filter((window) => Number(window.endMs) - Number(window.startMs) < DAY_MS)
    if (rowWindows.length > 0) {
      const widest = Math.min(...rowWindows.map((window) => Number(window.startMs)))
      let cursor = ''
      let order = ''
      for (;;) {
        const query = `${base}/users/${encodeURIComponent(userId)}/usages?limit=${pageSize}${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
        const page = await sendJSON(query, { apiKey, signal, timeoutMs })
        if (!page.ok) {
          const detail = firstMessage(page.json)
          const message = `the usage history answered HTTP ${page.status}${detail === '' ? '' : `: ${detail}`}`
          for (const window of rowWindows) byType.get(String(window.type)).error = message
          break
        }
        const body = page.json?.data ?? page.json
        const items = Array.isArray(body?.items) ? body.items : []
        let oldestOnPage = Infinity
        for (const item of items) {
          const at = Date.parse(String(item?.createdAt ?? ''))
          if (!Number.isFinite(at)) continue
          oldestOnPage = Math.min(oldestOnPage, at)
          const tokens = Number(item?.totalTokens ?? 0) || Number(item?.promptTokens ?? 0) + Number(item?.completionTokens ?? 0)
          const cost = Number(item?.costUsd ?? 0)
          // The same two spellings the daily endpoint uses, plus the request
          // metadata's id as a last resort, so a row is never bucketed as blank
          // when the gateway did name the model somewhere.
          const model = String(item?.aiModelName ?? item?.aiModelTypeName ?? item?.metadata?.model_id ?? '')
          for (const window of rowWindows) {
            if (at < Number(window.startMs)) continue
            addUsage(byType.get(String(window.type)), model, tokens, cost, 'request')
          }
        }
        pages += 1
        if (order === '' && items.length > 1) {
          order = Date.parse(String(items[0]?.createdAt ?? '')) >= Date.parse(String(items[items.length - 1]?.createdAt ?? ''))
            ? 'newest-first'
            : 'oldest-first'
        }
        const next = String(body?.nextToken ?? '')
        const capped = pages >= maxPages
        if (next === '' || capped || (order === 'newest-first' && oldestOnPage < widest)) {
          // Every row of these windows was read unless the page cap stopped it.
          const truncated = capped && next !== ''
          partial = partial || truncated
          for (const window of rowWindows) byType.get(String(window.type)).exact = truncated === false
          if (truncated) {
            for (const window of rowWindows) {
              byType.get(String(window.type)).error = `read the newest ${pages * pageSize} rows only; this window is larger`
            }
          }
          break
        }
        cursor = next
      }
    }

    for (const window of windows.filter((entry) => Number(entry.endMs) - Number(entry.startMs) >= DAY_MS)) {
      const reading = byType.get(String(window.type))
      const startDate = dayStamp(Number(window.startMs))
      const endDate = dayStamp(Number(window.endMs) > Number(window.startMs) ? Number(window.endMs) : Date.now())
      const daily = await fetchDailyUsage({ baseURL, apiKey, userId, startDate, endDate, signal, timeoutMs })
      if (!daily.ok) {
        reading.error = daily.error
        continue
      }
      for (const row of daily.rows) {
        addUsage(reading, row.model, row.tokens, row.costUsd, 'day')
      }
      // Distinct days, not rows: the endpoint answers one row per day AND model,
      // so counting rows would report a model count as a day count.
      reading.days = new Set(daily.rows.map((row) => row.date)).size
      // The first day counts whole unless the window starts at midnight UTC.
      const start = new Date(Number(window.startMs))
      reading.exact = start.getUTCHours() === 0 && start.getUTCMinutes() === 0 && start.getUTCSeconds() === 0
    }
    return finish({ ok: true, pages, partial })
  } catch (error) {
    return finish({ pages: 0, error: String(error?.message ?? error) })
  }
}

/**
 * Collect `cline-pass/*` ids from the official endpoints and the community registry.
 *
 * Additive by design: every source that answers contributes, and a source that
 * fails is skipped rather than failing the scan.
 *
 * @returns `{ models, sources }` — deduplicated ids plus the sources that answered.
 */
export async function fetchOfficialModels({ signal, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const found = new Set()
  const sources = []
  const add = (value) => {
    const id = typeof value === 'string' ? value : value?.id
    if (typeof id !== 'string') return
    const normalized = id.trim().toLowerCase()
    if (normalized.startsWith('cline-pass/')) found.add(normalized)
  }
  try {
    const response = await fetchImpl(RECOMMENDED_MODELS_URL, { signal: withTimeout(signal, timeoutMs) })
    if (response.ok) {
      const json = await response.json()
      const list = json?.clinePass ?? json?.data?.clinePass
      if (Array.isArray(list) && list.length > 0) {
        list.forEach(add)
        sources.push('cline.api')
      }
    }
  } catch { /* source unavailable */ }
  try {
    const response = await fetchImpl(MODELS_DEV_URL, { signal: withTimeout(signal, timeoutMs) })
    if (response.ok) {
      const json = await response.json()
      const provider = json?.providers?.['cline-pass'] ?? json?.['cline-pass']
      if (provider?.models !== undefined && provider.models !== null) {
        Object.keys(provider.models).forEach((id) => add(id.startsWith('cline-pass/') ? id : `cline-pass/${id}`))
        sources.push('models.dev')
      }
    }
  } catch { /* source unavailable */ }
  return { models: [...found].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id)), sources }
}

/**
 * Resolve a canonical slug against OpenRouter's public catalog, tolerating the
 * hyphen differences between the gateway's slug and OpenRouter's id.
 * @returns the real OpenRouter id, or null.
 */
export async function resolveOpenRouterSlug(slug, { signal, timeoutMs = 30000 } = {}) {
  try {
    const result = await sendJSON(`${OPENROUTER_API}/models`, { signal, timeoutMs })
    const ids = (result.json?.data ?? []).map((model) => model?.id).filter((id) => typeof id === 'string')
    const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
    return ids.find((id) => id === slug) ?? ids.find((id) => normalize(id) === normalize(slug)) ?? null
  } catch {
    return null
  }
}

/**
 * Per-upstream endpoint detail (context length, recent uptime) for one
 * OpenRouter model. Only meaningful for direct-pipeline models.
 * @returns `{ slug, endpoints }`, where endpoints is `[{ slug, name, endpoints, context, uptime }]`.
 */
export async function openRouterEndpoints(slug, { signal, timeoutMs = 30000 } = {}) {
  const real = await resolveOpenRouterSlug(slug, { signal, timeoutMs })
  if (real === null) return { slug, endpoints: [] }
  try {
    const result = await sendJSON(`${OPENROUTER_API}/models/${real}/endpoints`, { signal, timeoutMs })
    const detail = new Map()
    for (const entry of result.json?.data?.endpoints ?? []) {
      const providerSlug = String(entry?.tag ?? '').split('/')[0] || String(entry?.provider_name ?? '').toLowerCase().replace(/\s+/g, '-')
      if (providerSlug === '') continue
      const current = detail.get(providerSlug) ?? { slug: providerSlug, name: String(entry?.provider_name ?? providerSlug), endpoints: 0, context: 0, uptime: 0 }
      current.endpoints += 1
      current.context = Math.max(current.context, Number(entry?.context_length ?? 0))
      current.uptime = Math.max(current.uptime, Math.round(Number(entry?.uptime_last_30m ?? 0)))
      detail.set(providerSlug, current)
    }
    return { slug: real, endpoints: [...detail.values()] }
  } catch {
    return { slug: real, endpoints: [] }
  }
}
