/**
 * Transport for the Cline gateway and its public catalogs. Transport only: no
 * pinning, retry, or failover policy lives here (see `adapter.js`).
 *
 * - `POST {baseURL}/chat/completions` — the gateway
 * - `GET  {baseURL}/models` — the gateway's own catalog
 * - `GET  api.cline.bot/.../recommended-models` — official subscription list
 * - `GET  models.dev/api.json` — community registry, a backstop
 * - `GET  openrouter.ai/api/v1/...` — endpoint detail for direct-pipeline models
 *
 * @module dsh-cline-pass/cline
 */
/** The public Cline endpoint that lists subscription models without auth. */
export const RECOMMENDED_MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'
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
