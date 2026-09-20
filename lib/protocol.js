/**
 * Cline Pass wire protocol: pipeline detection, pin injection, failover
 * expansion, and error classification. Every function is pure and synchronous.
 *
 * The two pipelines spell a pin differently:
 * - **direct** (OpenRouter): top-level `provider.only/order/sort`.
 * - **planner** (Vercel AI Gateway): only `providerOptions.gateway.*` survives.
 *
 * Routing behavior reimplements the MIT-licensed cline-pass-switcher findings.
 *
 * @module dsh-cline-pass/protocol
 */
/**
 * The gateway wraps some answers in a `{ data: … }` envelope; unwrap it.
 * @param json - raw decoded response body.
 * @returns the OpenAI-shaped payload.
 */
export function unwrapEnvelope(json) {
  if (json !== null && typeof json === 'object' && json.data !== null && typeof json.data === 'object' && json.data.choices !== undefined) {
    return json.data
  }
  return json
}

/** Turn any error-shaped value into display text. */
export function errorText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && typeof value.message === 'string') return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Read the routing facts out of one completed gateway response.
 * @param json - raw decoded response body (enveloped or not).
 * @returns pipeline, canonical slug, chosen upstream and fallback list.
 */
export function parseRouting(json) {
  const payload = unwrapEnvelope(json)
  const message = payload?.choices?.[0]?.message
  const routing = message?.provider_metadata?.gateway?.routing ?? payload?.provider_metadata?.gateway?.routing ?? {}
  const direct = typeof payload?.provider === 'string' ? payload.provider : null
  return {
    content: typeof message?.content === 'string' ? message.content : null,
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
    usage: payload?.usage ?? null,
    pipeline: routing.finalProvider ? 'planner' : (direct === null ? null : 'direct'),
    canonicalSlug: routing.canonicalSlug ?? (typeof payload?.model === 'string' && payload.model.includes('/') ? payload.model : null),
    finalProvider: routing.finalProvider ?? (direct === null ? null : slugify(direct)),
    finalProviderName: routing.finalProvider ?? direct,
    fallbacks: Array.isArray(routing.fallbacksAvailable) ? routing.fallbacksAvailable.map(String) : [],
    plan: typeof routing.planningReasoning === 'string' ? routing.planningReasoning : '',
  }
}

/** Lowercase a display name into an upstream slug. */
export function slugify(value) {
  return String(value).toLowerCase().replace(/\s+/g, '-')
}

/** OpenRouter's names for the three sort metrics. */
export const OPENROUTER_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' }

/**
 * Normalize a configured sort into a wire value or `null`.
 *
 * Two spellings mean "no sort" and both must be dropped before the request is
 * built: the settings schema stores an empty string, and `none` is the
 * documented "clear it" value the tools and the panel accept. Neither is a
 * metric, and the gateway rejects them with HTTP 400
 * (`Invalid option: expected one of "cost"|"ttft"|"tps"|...`).
 *
 * Any other non-empty value is passed through untouched, so a genuine typo is
 * named by the gateway's own diagnostic instead of being silently ignored.
 *
 * @param value - the configured sort, as stored.
 * @returns the sort, or null when none is set.
 */
export function normalizeSort(value) {
  if (typeof value !== 'string') return null
  const sort = value.trim()
  return sort.length === 0 || sort === 'none' ? null : sort
}

/**
 * Write one attempt's upstream preference into a request body.
 *
 * Excludes are compiled into an `only` allow-list because the gateway ignores
 * the exclude/ignore fields. An unknown pipeline gets both spellings; each
 * pipeline ignores the other.
 *
 * @returns a new body with the pin applied.
 */
export function injectPrefs(body, meta, attempt) {
  const next = { ...body }
  const { upstream = null, orderRest = [], excludeList = [], strict = true } = attempt ?? {}
  // Normalized here as well as in buildAttempts: this function is exported, so
  // a caller can hand it an attempt straight from configuration.
  const sort = normalizeSort(attempt?.sort)
  const excluded = excludeList.filter((name) => name !== upstream)
  const known = Array.isArray(meta?.upstreams) ? meta.upstreams : []
  const allowList = excluded.length > 0 ? known.filter((name) => !excluded.includes(name)) : null
  if (upstream === null && sort === null && (allowList === null || allowList.length === 0)) return next
  const pipeline = meta?.pipeline ?? null
  const useGateway = pipeline === 'planner' || pipeline === null
  const useOpenRouter = pipeline === 'direct' || pipeline === null
  if (useGateway) {
    const gateway = {}
    if (upstream !== null) {
      if (strict) gateway.only = [upstream]
      else {
        gateway.order = [upstream, ...orderRest]
        if (allowList !== null && allowList.length > 0) gateway.only = allowList
      }
    } else if (allowList !== null && allowList.length > 0) {
      gateway.only = allowList
    }
    if (sort !== null) gateway.sort = sort
    next.providerOptions = { ...(next.providerOptions ?? {}), gateway: { ...(next.providerOptions?.gateway ?? {}), ...gateway } }
  }
  if (useOpenRouter) {
    const provider = { ...(next.provider ?? {}) }
    if (upstream !== null) {
      if (strict) provider.only = [upstream]
      else {
        provider.order = [upstream, ...orderRest]
        if (allowList !== null && allowList.length > 0) provider.only = allowList
      }
    } else if (allowList !== null && allowList.length > 0) {
      provider.only = allowList
    }
    if (sort !== null) provider.sort = OPENROUTER_SORT[sort] ?? sort
    next.provider = provider
  }
  return next
}

/**
 * Expand one model's pin configuration into the ordered failover candidates.
 *
 * A model with a non-empty (post-exclusion) pin list is tried upstream by
 * upstream; a model without one is a single automatic candidate whose excludes
 * become an allow-list.
 *
 * @param config - `{ upstreams, exclude, pinMode, sort }` for one model.
 * @returns the candidate attempts, in try order.
 */
export function buildAttempts(config) {
  const listed = (config?.upstreams ?? []).filter((name) => typeof name === 'string' && name.length > 0)
  const exclude = (config?.exclude ?? []).filter((name) => typeof name === 'string' && name.length > 0)
  const excluded = new Set(exclude)
  const wanted = listed.filter((name) => !excluded.has(name))
  const strict = (config?.pinMode ?? 'strict') === 'strict'
  const sort = normalizeSort(config?.sort)
  const base = { strict, sort, excludeList: exclude }
  if (wanted.length > 0) {
    return wanted.map((upstream, index) => ({
      ...base,
      upstream,
      orderRest: strict ? [] : wanted.filter((_, other) => other !== index),
    }))
  }
  return [{ ...base, upstream: null, orderRest: [] }]
}

/**
 * Classify a pinned-request failure into one upstream availability verdict.
 * @param message - the gateway's error text.
 * @returns `ok` (the channel answered), `limited`, `bad`, `auth`, or `unknown`.
 */
export function classifyUpstreamError(message) {
  const text = String(message ?? '')
  if (/empty response content/i.test(text)) return 'ok'
  if (/429|rate-?limited|temporarily rate/i.test(text)) return 'limited'
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(text)) return 'bad'
  if (/unauthorized|re-authenticate|401/i.test(text)) return 'auth'
  return 'unknown'
}

/**
 * Recover the gateway's own upstream list from a routing-layer error.
 *
 * The probe channels an impossible `only` value, so the router fails before
 * spending a token and names every provider it could have used.
 *
 * @returns the upstream slugs, or null when the error carried none.
 */
export function extractAvailableProviders(message, pipeline) {
  const text = String(message ?? '')
  if (pipeline === 'planner') {
    const match = /Available providers are:\s*([^.]+)/.exec(text)
    if (match === null) return null
    const tokens = match[1].split(/,\s*/).map((token) => token.trim()).filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    return tokens.length > 0 ? tokens : null
  }
  if (pipeline === 'direct') {
    const start = text.indexOf('{')
    if (start < 0) return null
    try {
      const parsed = JSON.parse(text.slice(start))
      const list = parsed?.error?.metadata?.available_providers
      return Array.isArray(list) && list.length > 0 ? list.map(String) : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Read the tier-0 channel hint out of a planner's reasoning sentence.
 * @param plan - `provider_metadata.gateway.routing.planningReasoning`.
 * @returns the upstreams the planner considered tier 0.
 */
export function parseTier0(plan) {
  const match = /([\w-]+) won tier 0 over ([^."]+)/.exec(String(plan ?? ''))
  if (match === null) return []
  return [...new Set([match[1], ...match[2].split(/,\s*|\s+and\s+/).map((part) => part.trim()).filter(Boolean)])]
}

/**
 * Merge the upstream channels discovered by several means, keeping order and
 * dropping duplicates.
 * @param lists - candidate lists, highest confidence first.
 * @returns the merged, de-duplicated upstream slugs (capped at 25).
 */
export function mergeUpstreams(...lists) {
  const seen = []
  for (const list of lists) {
    for (const name of list ?? []) {
      const value = String(name)
      if (value.length > 0 && !seen.includes(value)) seen.push(value)
    }
  }
  return seen.slice(0, 25)
}

/**
 * Normalize a model id for fuzzy OpenRouter catalog matching (the gateway's
 * canonical slug and OpenRouter's id disagree on hyphens: `zai/…` vs `z-ai/…`).
 * @param value - either id.
 * @returns the comparable form.
 */
export function normalizeSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
}
