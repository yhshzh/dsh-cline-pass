/**
 * Published model metadata, plus the merge that turns a caller's overrides into
 * the exact descriptor the LLM seam validates.
 *
 * Context window and output cap are provider facts, not preferences: the
 * harness sizes its prompt budget against `context.contextWindow`, so an
 * understated window silently truncates history. Values come from the public
 * catalog (models.dev), which agrees with the gateway's own `/v1/models`.
 *
 * The reasoning vocabulary is gateway-wide rather than per model: anything
 * outside `none|minimal|low|medium|high|xhigh|max` is rejected with HTTP 400,
 * so `off` is deliberately absent.
 *
 * @module dsh-cline-pass/catalog
 */
/** Selectable reasoning efforts offered for a reasoning-capable model. */
export const REASONING_EFFORTS = [
  { id: 'none', name: 'None', description: 'No extra thinking; fastest and cheapest.' },
  { id: 'minimal', name: 'Minimal', description: 'A bare minimum of reasoning.' },
  { id: 'low', name: 'Low', description: 'Prefer for routine or latency-sensitive work.' },
  { id: 'medium', name: 'Medium', description: 'A balanced amount of reasoning.' },
  { id: 'high', name: 'High', description: 'More thorough reasoning for multi-step work.' },
  { id: 'xhigh', name: 'Extra high', description: 'For difficult work that rewards more thinking.' },
  { id: 'max', name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
]

/**
 * Published metadata for the shipped Cline Pass models.
 *
 * `name` mirrors the provider's own display name where it publishes one, and
 * falls back to the model id when the catalog has no separate label.
 */
export const MODEL_CATALOG = {
  'cline-pass/deepseek-v4.1-flash': {
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    efforts: ['none', 'low', 'high', 'max'],
    input: ['text', 'image'],
  },
  'cline-pass/deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    efforts: ['none', 'low', 'medium', 'high'],
    input: ['text'],
  },
  'cline-pass/deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    efforts: ['none', 'low', 'high', 'max'],
    input: ['text'],
  },
  'cline-pass/glm-5.3': {
    name: 'GLM-5.3',
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    efforts: ['low', 'high', 'max'],
    input: ['text'],
  },
  'cline-pass/glm-5.3-flash': {
    name: 'GLM-5.3 Flash',
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    efforts: ['low', 'high', 'max'],
    input: ['text', 'image'],
  },
  'cline-pass/glm-5.2': {
    name: 'GLM-5.2',
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    efforts: ['none', 'high', 'max'],
    input: ['text'],
  },
  'cline-pass/kimi-k3': {
    name: 'Kimi K3',
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    efforts: ['low', 'high', 'max'],
    input: ['text', 'image'],
  },
  'cline-pass/kimi-k2.7-code': {
    name: 'Kimi K2.7 Code',
    contextWindow: 262144,
    maxTokens: 262144,
    reasoning: true,
    efforts: ['none', 'low', 'medium', 'high'],
    input: ['text', 'image'],
  },
  'cline-pass/kimi-k2.6': {
    name: 'Kimi K2.6',
    contextWindow: 262144,
    maxTokens: 262144,
    reasoning: true,
    input: ['text', 'image'],
  },
  'cline-pass/minimax-m3': {
    name: 'MiniMax-M3',
    contextWindow: 1048576,
    maxTokens: 512000,
    reasoning: true,
    input: ['text', 'image'],
  },
  'cline-pass/qwen3.8-max': {
    name: 'Qwen3.8 Max',
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    efforts: ['none', 'low', 'medium', 'xhigh'],
    input: ['text', 'image'],
  },
  'cline-pass/qwen3.7-max': {
    name: 'Qwen3.7 Max',
    contextWindow: 1000000,
    maxTokens: 65536,
    reasoning: true,
    input: ['text'],
  },
  'cline-pass/qwen3.7-plus': {
    name: 'Qwen3.7 Plus',
    contextWindow: 1000000,
    maxTokens: 64000,
    reasoning: true,
    input: ['text', 'image'],
  },
  'cline-pass/mimo-v2.5-pro': {
    name: 'MiMo-V2.5-Pro',
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    input: ['text'],
  },
  'cline-pass/mimo-v2.5': {
    name: 'MiMo-V2.5',
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    input: ['text', 'image', 'audio'],
  },
}

/** Published entry for one model id, or undefined when the catalog lacks it. */
export function catalogEntry(model) {
  return MODEL_CATALOG[model]
}

/**
 * Resolve one field as: configured value, then published value, then fallback.
 * Configuration schemas default absent optional fields to `0`, `''` or `[]`,
 * so an empty configured value must read as "not set" — otherwise the default
 * would shadow the catalog and understate a real window to zero.
 */
function pick(configured, published, fallback) {
  const set = Array.isArray(configured)
    ? configured.length > 0
    : configured !== undefined && configured !== null && configured !== '' && configured !== 0
  if (set) return configured
  if (published !== undefined && published !== null) return published
  return fallback
}

/**
 * Per-request output budget used when nothing else names one.
 *
 * A budget, not a ceiling: the harness materializes it into requests that omit
 * `maxTokens`, and reserves the same number as completion room before it compacts, so
 * this is the number that decides how much of the window stays available to the
 * conversation.
 *
 * 128k doubles the room a long reasoning pass gets without moving that point on a 1M
 * window: the 80% rule stays the binding one until the reserve passes ~144k. It is
 * not applied flat, though — a 128k reserve on a 256k window would leave almost
 * nothing to compact into — so the shipped default scales to the window while a
 * configured value does not, because that one is a choice rather than a default.
 */
export const DEFAULT_MAX_TOKENS = 131072

/**
 * The seam's whole `ModelModality` vocabulary. A catalog entry may list more
 * than this (models.dev reports `audio` for mimo-v2.5); the seam would reject
 * the extra value, so the resolver clamps to what it declares.
 */
const SEAM_MODALITIES = new Set(['text', 'image'])

/**
 * The reasoning levels one model actually offers, as the seam wants them.
 *
 * Every reasoning model used to advertise the whole vocabulary, which the picker
 * then showed — seven levels for a model that answers to four. The levels are a
 * per-model fact, and the gateway publishes them (see `cline.js`), so an entry
 * carries the list it was published with.
 *
 * An absent or empty list keeps the whole vocabulary, which is the honest answer
 * for the sources that name none: a model published with only an on/off toggle, or
 * with only a token budget, has no levels to narrow to.
 */
function reasonEfforts(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return REASONING_EFFORTS
  const byId = new Map(REASONING_EFFORTS.map((effort) => [effort.id, effort]))
  return ids.map((id) => byId.get(id) ?? { id, name: id, description: '' })
}

/**
 * The output budget to advertise for one model.
 *
 * `defaultMaxTokens` is what a request asks for, not what the model can emit, and
 * the harness spends it twice: it fills a request's `max_tokens` from it, and it
 * reserves the same number as completion room before deciding to compact. So the
 * published output ceiling clamps the configured budget rather than becoming it.
 * Reporting the ceiling instead reserves that much of every window — at the
 * shipped 384k ceiling compaction moves from 80% of a 1M window down to 55% — and
 * a ceiling equal to the window leaves the compaction policy no message budget at
 * all, which it answers with an error rather than a reading.
 *
 * A budget is also never taken past half the window: reserving more than half of it
 * leaves the conversation less room than a single response, which is the state the
 * policy refuses. Every shipped model still clears the harness's headroom at that
 * bound, so the guard only ever catches a hand-set value.
 *
 * @param budget - the configured per-request budget, when one is set.
 * @param ceiling - the model's published output ceiling, when one is known.
 * @param contextWindow - the resolved window, when one is known.
 * @returns the tokens to advertise, or undefined when nothing constrains it.
 */
function resolveOutputBudget(budget, ceiling, contextWindow) {
  const wanted = Number.isFinite(budget) && budget > 0 ? budget : undefined
  const most = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : undefined
  const chosen = wanted === undefined ? most : most === undefined ? wanted : Math.min(wanted, most)
  if (chosen === undefined) return undefined
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return chosen
  // The shipped default follows the window; a configured value is the user's choice
  // and is only held back from reserving the window outright.
  const share = wanted === DEFAULT_MAX_TOKENS ? 8 : 2
  return Math.min(chosen, Math.floor(contextWindow / share))
}

/**
 * Resolve the metadata seam fields for one model.
 *
 * Precedence per field: the configured override, then the shipped catalog, then
 * what the last official scan published, then the route-wide fallback. The output
 * budget is the exception — there the published figure is a ceiling that bounds the
 * configured budget, which is why it goes through {@link resolveOutputBudget}.
 *
 * The live scan sits below the shipped table rather than above it because the
 * shipped entry is curated: models.dev reports `audio`/`video`/`pdf`, and the
 * underscore-free spelling of a display name, neither of which the seam or the
 * provider's own label wants. It exists to cover what the table cannot know —
 * a model published after this release — so a multimodal model is never adopted
 * as text-only just because it is new.
 *
 * @param discovered - metadata for this model from the last catalog scan.
 * @returns a descriptor the seam's `normalizeModelInfo` accepts.
 */
export function resolveModelMetadata(provider, model, override, fallback, discovered = {}) {
  const published = { ...(discovered ?? {}), ...(catalogEntry(model) ?? {}) }
  const name = pick(override?.name, published.name, model)
  const contextWindow = pick(override?.contextWindow, published.contextWindow, fallback.contextWindow)
  const maxTokens = resolveOutputBudget(
    fallback.maxTokens,
    pick(override?.maxTokens, published.maxTokens, undefined),
    contextWindow,
  )
  const modality = pick(override?.input, published.input ?? published.inputModalities, undefined)
  const reasoning = override?.reasoning ?? published.reasoning ?? fallback.reasoning
  const offered = (modality ?? ['text']).filter((entry) => SEAM_MODALITIES.has(entry))
  return {
    provider,
    id: model,
    name,
    inputModalities: offered.length > 0 ? offered : ['text'],
    context: { contextWindow },
    defaultMaxTokens: maxTokens,
    ...(reasoning === true ? { reasoning: { efforts: reasonEfforts(published.efforts) } } : {}),
  }
}
