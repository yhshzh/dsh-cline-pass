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
    input: ['text', 'image'],
  },
  'cline-pass/deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    input: ['text'],
  },
  'cline-pass/deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
    input: ['text'],
  },
  'cline-pass/glm-5.3': {
    name: 'GLM-5.3',
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    input: ['text'],
  },
  'cline-pass/glm-5.3-flash': {
    name: 'GLM-5.3 Flash',
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    input: ['text', 'image'],
  },
  'cline-pass/glm-5.2': {
    name: 'GLM-5.2',
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoning: true,
    input: ['text'],
  },
  'cline-pass/kimi-k3': {
    name: 'Kimi K3',
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    input: ['text', 'image'],
  },
  'cline-pass/kimi-k2.7-code': {
    name: 'Kimi K2.7 Code',
    contextWindow: 262144,
    maxTokens: 262144,
    reasoning: true,
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
 * The seam's whole `ModelModality` vocabulary. A catalog entry may list more
 * than this (models.dev reports `audio` for mimo-v2.5); the seam would reject
 * the extra value, so the resolver clamps to what it declares.
 */
const SEAM_MODALITIES = new Set(['text', 'image'])

/**
 * Resolve the metadata seam fields for one model.
 *
 * Precedence per field: the configured override, then the published catalog,
 * then the route-wide fallback.
 *
 * @returns a descriptor the seam's `normalizeModelInfo` accepts.
 */
export function resolveModelMetadata(provider, model, override, fallback) {
  const published = catalogEntry(model) ?? {}
  const name = pick(override?.name, published.name, model)
  const contextWindow = pick(override?.contextWindow, published.contextWindow, fallback.contextWindow)
  const maxTokens = pick(override?.maxTokens, published.maxTokens, fallback.maxTokens)
  const modality = pick(override?.input, published.input, undefined)
  const reasoning = override?.reasoning ?? published.reasoning ?? fallback.reasoning
  const offered = (modality ?? ['text']).filter((entry) => SEAM_MODALITIES.has(entry))
  return {
    provider,
    id: model,
    name,
    inputModalities: offered.length > 0 ? offered : ['text'],
    context: { contextWindow },
    defaultMaxTokens: maxTokens,
    ...(reasoning === true ? { reasoning: { efforts: REASONING_EFFORTS } } : {}),
  }
}
