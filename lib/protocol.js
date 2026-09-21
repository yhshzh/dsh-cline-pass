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
 * Identity of this build.
 *
 * The package version cannot carry it: the profile pins `^0.1.1`, so a bumped
 * version would stop satisfying that range and the next install would silently
 * revert the fix. The tag is surfaced by `cline_pass_status` and the startup
 * log instead, which turns "did the patched code actually load?" into a
 * question with an answer.
 */
export const BUILD_TAG = 'dshfix-1'

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
 * Normalize a configured pin mode to the one value the router compares against.
 *
 * The settings schema accepts any string and the panel and the tools write
 * different spellings, so `"strict "` used to display as strict (see
 * `projectModel`) while `buildAttempts` compared the untouched value and ran it
 * as preferred. One rule, shared by both, is what keeps the shown mode and the
 * executed mode the same thing.
 *
 * @param value - the configured pin mode, as stored.
 * @returns `'strict'` or `'preferred'`.
 */
export function normalizePinMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'preferred' ? 'preferred' : 'strict'
}

/**
 * The channel vocabulary one spelling should be resolved against.
 *
 * The two pipelines sit behind different routers (OpenRouter vs the Vercel AI
 * Gateway) and publish different channel lists, so the merged list is the wrong
 * basis for an allow-list: it can miss the channel that actually serves the
 * request, which is exactly how an exclusion leaks.
 *
 * @param meta - discovered model metadata.
 * @param pipeline - which pipeline's list to prefer.
 * @returns that pipeline's channel names, falling back to the merged list.
 */
function knownChannels(meta, pipeline) {
  const scoped = meta?.channels?.[pipeline]
  if (Array.isArray(scoped) && scoped.length > 0) return scoped
  return Array.isArray(meta?.upstreams) ? meta.upstreams : []
}

/**
 * Write one attempt's upstream preference into a request body.
 *
 * Excludes are compiled into an `only` allow-list because the gateway ignores
 * the exclude/ignore fields.
 *
 * Both spellings are written by default. A pin is honored only by the pipeline
 * that owns the spelling, and the pipeline a model runs on is decided by the
 * gateway and can differ between calls, so writing just the spelling the last
 * probe observed means the pin silently evaporates the moment that changes.
 * Each pipeline ignores the other's field, which is what makes writing both
 * safe — the same hedge the original code applied to an *unknown* pipeline,
 * now applied to every pipeline. `spelling: 'detected'` restores the old
 * single-spelling behavior.
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
  const gatewayAllow = excluded.length > 0 ? knownChannels(meta, 'planner').filter((name) => !excluded.includes(name)) : null
  const openRouterAllow = excluded.length > 0 ? knownChannels(meta, 'direct').filter((name) => !excluded.includes(name)) : null
  const pipeline = meta?.pipeline ?? null
  const both = attempt?.spelling !== 'detected'
  const useGateway = both || pipeline === 'planner' || pipeline === null
  const useOpenRouter = both || pipeline === 'direct' || pipeline === null
  const gatewayUsable = useGateway && (upstream !== null || sort !== null || (gatewayAllow !== null && gatewayAllow.length > 0))
  // `ignore` is OpenRouter's own exclusion field: written alongside the
  // allow-list so an exclusion still bites when the allow-list cannot be
  // computed (no channel list yet) or has gone stale.
  const openRouterUsable = useOpenRouter && (upstream !== null || sort !== null || excluded.length > 0 || (openRouterAllow !== null && openRouterAllow.length > 0))
  if (!gatewayUsable && !openRouterUsable) return next
  if (gatewayUsable) {
    const gateway = {}
    if (upstream !== null) {
      if (strict) gateway.only = [upstream]
      else {
        gateway.order = [upstream, ...orderRest]
        if (gatewayAllow !== null && gatewayAllow.length > 0) gateway.only = gatewayAllow
      }
    } else if (gatewayAllow !== null && gatewayAllow.length > 0) {
      gateway.only = gatewayAllow
    }
    if (sort !== null) gateway.sort = sort
    next.providerOptions = { ...(next.providerOptions ?? {}), gateway: { ...(next.providerOptions?.gateway ?? {}), ...gateway } }
  }
  if (openRouterUsable) {
    const provider = { ...(next.provider ?? {}) }
    if (upstream !== null) {
      if (strict) provider.only = [upstream]
      else {
        provider.order = [upstream, ...orderRest]
        if (openRouterAllow !== null && openRouterAllow.length > 0) provider.only = openRouterAllow
      }
    } else if (openRouterAllow !== null && openRouterAllow.length > 0) {
      provider.only = openRouterAllow
    }
    if (sort !== null) provider.sort = OPENROUTER_SORT[sort] ?? sort
    if (excluded.length > 0) provider.ignore = excluded
    next.provider = provider
  }
  return next
}

/**
 * Read back whether the router honored one attempt's pin.
 *
 * A 200 is not evidence that the pin was applied: an unknown or unavailable
 * `only` value is dropped by the router, which then serves the request from any
 * channel it likes. The only honest test is the channel the response reports.
 *
 * Both sides are compared through {@link normalizeSlug} because the two
 * pipelines spell one channel differently (`"Together AI"` vs `togetherai`).
 *
 * @param attempt - the attempt that was sent.
 * @param routing - the routing facts read out of the response.
 * @returns `adopted`, `fallback`, `not-adopted`, `violated`, or `unresolved`.
 */
export function pinAdherence(attempt, routing) {
  const expected = attempt?.upstream ?? null
  const excluded = (attempt?.excludeList ?? [])
    .filter((name) => normalizeSlug(name) !== normalizeSlug(expected ?? ''))
    .map(normalizeSlug)
  const raw = routing?.finalProvider ?? null
  const actual = raw === null || raw === undefined || String(raw).length === 0 ? null : normalizeSlug(raw)
  // An excluded channel serving the request is a breach in every mode, and it
  // is the one failure nothing else can reveal: the response is a clean 200.
  if (actual !== null && excluded.includes(actual)) return 'violated'
  if (expected === null || expected === undefined || String(expected).length === 0) return 'unresolved'
  if (actual === null) return 'unresolved'
  if (actual === normalizeSlug(expected)) return 'adopted'
  if ((attempt?.orderRest ?? []).map(normalizeSlug).includes(actual)) return 'fallback'
  return 'not-adopted'
}

/** Whether an adherence reading means the pin was honored, or cannot be judged. */
export function isAdherenceOk(adherence) {
  return adherence === 'adopted' || adherence === 'fallback' || adherence === 'unresolved'
}

/**
 * Name the configuration problems that make a pin impossible to honor.
 *
 * These are the cases the original code swallowed: an exclusion that cannot be
 * compiled into an allow-list because no channel list exists yet, and an
 * exclusion list that covers every known channel. Both produced a request with
 * no pin fields at all — that is, "excluded" channels still in play, silently.
 *
 * @param attempt - the attempt about to be sent.
 * @param meta - discovered model metadata.
 * @returns human-readable warnings, empty when the pin is expressible.
 */
export function pinWarnings(attempt, meta) {
  const upstream = attempt?.upstream ?? null
  const excluded = (attempt?.excludeList ?? []).filter((name) => name !== upstream)
  if (excluded.length === 0) return []
  const known = Array.isArray(meta?.upstreams) ? meta.upstreams : []
  if (known.length === 0) {
    return [`excludeUnresolved: this model has no channel list yet, so ${excluded.join(', ')} could not be compiled into an allow-list — run cline_pass_probe for it`]
  }
  const remaining = known.filter((name) => !excluded.includes(name))
  if (remaining.length === 0 && upstream === null) {
    return [`PIN_UNRESOLVED: every known channel is excluded (${known.join(', ')}), so the request falls back to the gateway's own routing`]
  }
  return []
}

/**
 * Expand one model's pin configuration into the ordered failover candidates.
 *
 * A model with a non-empty (post-exclusion) pin list is tried upstream by
 * upstream; a model without one is a single automatic candidate whose excludes
 * become an allow-list.
 *
 * @param config - `{ upstreams, exclude, pinMode, sort, spelling? }` for one model.
 * @returns the candidate attempts, in try order.
 */
export function buildAttempts(config) {
  const listed = (config?.upstreams ?? []).filter((name) => typeof name === 'string' && name.length > 0)
  const exclude = (config?.exclude ?? []).filter((name) => typeof name === 'string' && name.length > 0)
  const excluded = new Set(exclude)
  const wanted = listed.filter((name) => !excluded.has(name))
  const strict = normalizePinMode(config?.pinMode) === 'strict'
  const sort = normalizeSort(config?.sort)
  const base = { strict, sort, excludeList: exclude }
  // Carried through only when the caller configured it, so an attempt built from
  // a bare pin profile keeps its historical shape.
  if (typeof config?.spelling === 'string' && config.spelling.length > 0) base.spelling = config.spelling
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
