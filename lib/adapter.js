/**
 * The Cline Pass LLM adapter: an OpenAI-compatible `chat/completions` stream
 * with upstream pinning and pre-first-token failover.
 *
 * Transport only. Connection facts, the per-request account, the per-model pin,
 * and the observation callbacks all arrive as thunks from `index.js`, which
 * keeps credential policy, settings layering, and state out of here.
 *
 * @module dsh-cline-pass/adapter
 */
import {
  attributionHeaders,
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  errorChain,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { chatURL } from './cline.js'
import { resolveModelMetadata } from './catalog.js'
import {
  buildAttempts,
  classifyUpstreamError,
  errorText,
  injectPrefs,
  parseRouting,
  pinAdherence,
  pinWarnings,
  unwrapEnvelope,
} from './protocol.js'
import { parseServerSentEvents } from './engine.js'

/** Default maximum idle interval while a stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000
/**
 * Conservative context capacity for a model the catalog does not describe.
 * Shipped models carry their published window, so this only bounds the
 * unknown ones; raise it per model in configuration when a new model ships.
 */
export const DEFAULT_CONTEXT_WINDOW = 128000
/**
 * Conservative per-request output cap for a model the catalog does not
 * describe. It must stay well below the smallest published window, because
 * the default is materialized into requests whose callers omit `maxTokens`.
 */
export const DEFAULT_MAX_TOKENS = 32000
/**
 * Request-image budget applied when the caller names none.
 *
 * Every image in the history is re-encoded into every request body, so an
 * unbounded conversation would eventually exceed the gateway's request-size
 * cap. These match the values the shipped adapters use.
 */
export const DEFAULT_REQUEST_IMAGE_POLICY = { maxPixels: 4194304, maxBytes: 1048576 }

/**
 * Compute aspect-preserving integer dimensions within a total-pixel budget.
 *
 * Local copy of the harness's own projection: it is pure geometry, and this
 * adapter must not add a hard dependency on `@deepseek-ai/dsh-attachment` for
 * one helper. Mirrors `requestImageDimensions`, including the inward rounding
 * and the "never enlarge a small image" rule.
 *
 * @param width - positive source width.
 * @param height - positive source height.
 * @param maxPixels - positive width-times-height cap.
 * @returns projected dimensions.
 */
export function projectImageDimensions(width, height, maxPixels) {
  const safeWidth = Number.isSafeInteger(width) && width > 0 ? width : 1
  const safeHeight = Number.isSafeInteger(height) && height > 0 ? height : 1
  const safeBudget = Number.isSafeInteger(maxPixels) && maxPixels > 0 ? maxPixels : DEFAULT_REQUEST_IMAGE_POLICY.maxPixels
  const scale = Math.min(1, Math.sqrt(safeBudget / (safeWidth * safeHeight)))
  if (scale === 1) return { width: safeWidth, height: safeHeight }
  if (safeWidth >= safeHeight) {
    let projectedWidth = Math.max(1, Math.floor(safeWidth * scale))
    let projectedHeight = Math.max(1, Math.round((projectedWidth * safeHeight) / safeWidth))
    while (projectedWidth * projectedHeight > safeBudget && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round((projectedWidth * safeHeight) / safeWidth))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(safeHeight * scale))
  let projectedWidth = Math.max(1, Math.round((projectedHeight * safeWidth) / safeHeight))
  while (projectedWidth * projectedHeight > safeBudget && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round((projectedHeight * safeWidth) / safeHeight))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/**
 * Build the target object one attachment must be materialized at.
 *
 * The harness changed this contract between releases and the two shapes are
 * mutually exclusive, not additive:
 *
 * - 0.1.2 - 0.1.5 validate `{maxPixels, maxBytes}` and project the dimensions
 *   themselves;
 * - 0.1.6+ validate `{width, height, maxBytes}` and take the dimensions as
 *   given.
 *
 * A caller that sends only one shape fails on the other host — the newer one
 * rejects a missing `width` with `Image request width must be a positive
 * integer.`, which surfaces to the user as a failed turn on every image. Each
 * validator reads only the fields it knows and ignores the rest, so one target
 * carrying both the projected dimensions and the pixel budget satisfies either
 * host. The dimensions are projected here with the same geometry the older
 * host would have applied, so the rendered result is identical on both.
 *
 * @param ref - the durable attachment reference, which carries its own size.
 * @param policy - the configured pixel and byte budget.
 * @returns the request target for `readImageRequest`.
 * @throws {LlmError} UNSUPPORTED_CONTENT when the reference carries no usable size.
 */
export function requestImageTarget(ref, policy) {
  const maxPixels = policy?.maxPixels ?? DEFAULT_REQUEST_IMAGE_POLICY.maxPixels
  const maxBytes = policy?.maxBytes ?? DEFAULT_REQUEST_IMAGE_POLICY.maxBytes
  const width = ref?.width
  const height = ref?.height
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new LlmError('The Cline Pass adapter received an image reference without usable dimensions.', 'UNSUPPORTED_CONTENT')
  }
  const projected = projectImageDimensions(width, height, maxPixels)
  return { width: projected.width, height: projected.height, maxPixels, maxBytes }
}

const STREAM_IDLE_TIMEOUT_CODE = 'CLINE_PASS_STREAM_IDLE_TIMEOUT'

//#region request serialization

/** Join a message's text blocks. */
function flattenText(blocks) {
  return (blocks ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** Encode request image bytes for an inline data URI. */
function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

/**
 * Collect every image reference in a content list, keyed by attachment id.
 *
 * The walk descends into tool-result content, because an image can arrive as
 * the result of a tool call rather than as a direct user attachment.
 *
 * @param blocks - typed content blocks.
 * @param refs - accumulator, keyed by attachment id.
 * @returns the accumulator.
 */
export function collectImageRefs(blocks, refs = new Map()) {
  for (const block of blocks ?? []) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
  return refs
}

/**
 * Read one provider-request version of every image in the history.
 *
 * The harness hands adapters attachment references, never bytes, so the bytes
 * are materialized here at the policy the provider needs. A history with no
 * image resolves nothing and costs no call.
 *
 * @returns attachmentId → prepared version, or undefined when there is no image.
 * @throws {LlmError} UNSUPPORTED_CONTENT when images exist but no store is composed.
 */
export async function prepareRequestImages(messages, attachments, policy, signal) {
  const refs = new Map()
  for (const message of messages ?? []) collectImageRefs(message.content, refs)
  if (refs.size === 0) return undefined
  if (attachments === undefined) {
    throw new LlmError('The Cline Pass adapter needs the durable attachment service to send image input.', 'UNSUPPORTED_CONTENT')
  }
  const ordered = [...refs.values()]
  const prepared = await Promise.all(ordered.map((ref) => attachments.readImageRequest(ref, requestImageTarget(ref, policy), signal)))
  const versions = new Map()
  for (const [index, ref] of ordered.entries()) versions.set(ref.attachmentId, prepared[index])
  return versions
}

/** Convert one assistant message, keeping tool calls and reasoning. */
function serializeAssistant(message) {
  // A structured image in assistant output has no OpenAI wire spelling, so it
  // fails loudly rather than being silently dropped.
  if (contentHasImage(message.content ?? [])) {
    throw new LlmError('The Cline Pass adapter cannot represent structured assistant image output.', 'UNSUPPORTED_CONTENT')
  }
  const text = flattenText(message.content)
  const reasoning = (message.content ?? []).filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
  const toolCalls = (message.content ?? []).filter((block) => block.type === 'tool-call').map((block) => ({
    id: block.id,
    type: 'function',
    function: { name: block.name, arguments: block.arguments },
  }))
  return {
    role: 'assistant',
    content: text,
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/**
 * Convert the harness conversation to wire messages.
 *
 * Tool results become standalone `{ role: 'tool' }` messages. A user message
 * carrying an image switches to the OpenAI content-part array; a text-only one
 * keeps the plain-string form.
 */
function serializeMessages(messages, images) {
  const wire = []
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = (message.content ?? []).filter((block) => block.type === 'tool-result')
    const parts = []
    for (const block of message.content ?? []) {
      if (block.type === 'text' && block.text.length > 0) parts.push({ type: 'text', text: block.text })
      else if (block.type === 'image') {
        const version = images?.get(block.attachment?.attachmentId)
        if (version === undefined) {
          throw new LlmError('The Cline Pass adapter received an image it could not resolve into request bytes.', 'UNSUPPORTED_CONTENT')
        }
        parts.push({ type: 'image_url', image_url: { url: `data:${version.mediaType};base64,${toBase64(version.data)}` } })
      }
    }
    const hasImage = parts.some((part) => part.type === 'image_url')
    const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
    if (hasImage) wire.push({ role: 'user', content: parts })
    else if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the wire request for one harness call, before pinning.
 * @param options - the harness request (model, system, history, tools, sampling).
 * @param connection - resolved connection facts (default token caps).
 * @param images - attachmentId → prepared request version, when the call has images.
 */
export function buildRequestBody(options, connection, images) {
  const messages = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...serializeMessages(options.messages, images))
  const tools = (options.tools ?? []).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }),
  }
}

//#endregion

//#region stream translation

/** Map an OpenAI `finish_reason` to the harness finish reason. */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'tool-calls':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } }
  }
}

/**
 * Map OpenAI usage fields to disjoint harness counts.
 *
 * `prompt_tokens` includes cache hits per the OpenAI convention, and the
 * harness counts are disjoint, so cached tokens are subtracted out of
 * `inputTokens`.
 */
export function mapUsage(usage) {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens
  const input = Number.isSafeInteger(usage?.prompt_tokens) ? usage.prompt_tokens : 0
  const output = Number.isSafeInteger(usage?.completion_tokens) ? usage.completion_tokens : 0
  const combined = input + output
  const hasExactTotal = Number.isSafeInteger(usage?.total_tokens) ? usage.total_tokens === combined : true
  return {
    inputTokens: input - (cacheRead ?? 0),
    outputTokens: output,
    ...(hasExactTotal ? { totalTokens: combined } : {}),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** One streamed identity field: a later empty or null value never clears it. */
function acceptIdentity(current, incoming) {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

/**
 * Read one delta's reasoning text, tolerating both wire spellings.
 *
 * Prefers the string field, and falls back to joining the `reasoning_details`
 * parts, which is where a gateway that omits the flat field puts the same text.
 *
 * @param delta - one OpenAI streaming `delta`.
 * @returns the reasoning fragment, or undefined when this frame carries none.
 */
export function reasoningOf(delta) {
  for (const field of ['reasoning', 'reasoning_content']) {
    const value = delta?.[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  const details = delta?.reasoning_details
  if (Array.isArray(details)) {
    const text = details.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
    if (text.length > 0) return text
  }
  return undefined
}

/** Assemble the terminal content block for one open block. */
function closeBlock(block) {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    default:
      return { type: 'tool-call', id: ToolCallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text }
  }
}

/** Map a gateway error payload to a stable harness code. */
export function streamErrorCode(message, status) {
  const detail = String(message ?? '')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (/unauthorized|re-authenticate|invalid api key|401|403/i.test(detail)) return 'AUTH'
  if (/429|rate limit|rate-?limited/i.test(detail)) return 'RATE_LIMIT'
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (status === 400) return 'INVALID_REQUEST'
  if (status !== undefined && status >= 500) return 'SERVER'
  if (status !== undefined && status >= 400) return `HTTP_${status}`
  return 'UPSTREAM'
}

/**
 * Note the moment the first byte of a response body arrives.
 *
 * A pass-through stream: it reports once, on the first chunk, and forwards every
 * chunk unchanged. A keep-alive comment or an early frame reaches this before it
 * reaches the SSE parser, so the recorded moment is the gateway's first sign of
 * life rather than the caller's first content.
 *
 * @param body - the response body stream.
 * @param onFirst - called once, when the first chunk is seen.
 * @returns a stream equivalent to `body`.
 */
function tapFirstByte(body, onFirst) {
  let seen = false
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (!seen) {
        seen = true
        onFirst()
      }
      controller.enqueue(chunk)
    },
  }))
}

/**
 * Translate decoded SSE payloads into harness stream chunks.
 *
 * Deltas stream through as they arrive; block ends, usage and the finish reason
 * are all deferred to the `[DONE]` sentinel, so no chunk ever follows `finish`.
 * A completion with no content at all becomes an `EMPTY_RESPONSE` error finish
 * rather than a silent empty message.
 *
 * @param payloads - decoded SSE payloads from {@link parseServerSentEvents}, `[DONE]` last.
 */
export async function* translate(payloads) {
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage
  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      }
      return
    }
    const chunk = unwrapEnvelope(payload)
    // A 200 response whose body is an error object must fail the attempt, so a
    // pin that the router refuses still fails over to the next candidate.
    if (chunk?.error !== undefined && chunk?.choices === undefined) {
      throw new LlmError(errorText(chunk.error), streamErrorCode(errorText(chunk.error)))
    }
    for (const choice of chunk?.choices ?? []) {
      const delta = choice?.delta ?? {}
      // Two spellings carry the same thinking. The Cline gateway streams
      // `reasoning` (plus `reasoning_details`); `reasoning_content` is the
      // DeepSeek-native name some OpenAI-compatible backends use instead.
      // Reading only one silently discarded every reasoning token.
      const reasoning = reasoningOf(delta)
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (block === undefined) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        block.callId = acceptIdentity(block.callId, call.id)
        block.name = acceptIdentity(block.name, call.function?.name)
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name === undefined ? {} : { name: block.name }),
          argumentsDelta: fragment,
        }
      }
      if (typeof choice?.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (chunk?.usage !== undefined && chunk.usage !== null) pendingUsage = mapUsage(chunk.usage)
  }
  throw new LlmError('stream ended without [DONE]', 'STREAM_CLOSED')
}

//#endregion

/**
 * Watch a payload stream for routing metadata without disturbing it.
 *
 * The gateway attaches `provider_metadata.gateway.routing` to the message of a
 * non-streaming answer; in a stream it appears on whichever frame carries it,
 * so every frame is inspected and the last non-null reading wins.
 *
 * @param payloads - decoded SSE payloads.
 * @param observed - mutable `{ provider, canonical, pipeline }` filled in place.
 */
async function* tapRouting(payloads, observed) {
  for await (const payload of payloads) {
    if (payload !== '[DONE]') {
      const routing = parseRouting(payload)
      if (routing.finalProvider !== null) {
        observed.provider = routing.finalProvider
        observed.pipeline = routing.pipeline
        if (routing.canonicalSlug !== null) observed.canonical = routing.canonicalSlug
      }
    }
    yield payload
  }
}

/**
 * The Cline Pass adapter. One instance serves the plugin's provider route(s);
 * the harness model id IS the gateway's wire model id.
 */
export class ClinePassAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
  }

  providerInfo(provider) {
    return { id: provider, name: this.config.connection().displayName }
  }

  listModels(provider) {
    return Promise.resolve(this.config.connection().models.map((model) => this.modelInfo(provider, model)))
  }

  resolveModel(provider, model) {
    const connection = this.config.connection()
    const configured = connection.models.find((entry) => entry.id === model)
    const discovered = this.config.discoveredContext?.(model)
    const override = configured ?? { id: model }
    const resolved = resolveModelMetadata(provider, model, override, {
      contextWindow: discovered ?? connection.defaultContextWindow,
      maxTokens: connection.maxTokens,
      reasoning: connection.reasoningModels !== false,
    })
    // A probe that saw this model's real endpoints overrides the published
    // window: it is measured, not documented.
    return Promise.resolve(discovered === undefined
      ? resolved
      : { ...resolved, context: { contextWindow: Math.max(discovered, resolved.context.contextWindow) } })
  }

  /** Advertise one model in the catalog listing. */
  modelInfo(provider, model) {
    const input = Array.isArray(model.input) && model.input.length > 0 ? model.input : ['text']
    return {
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: input,
    }
  }

  stream(options) {
    return this.run(options)
  }

  /**
   * Attempt every pinned candidate in order, yielding the first one that
   * produces content. Failover happens only before the first yielded chunk.
   */
  async *run(options) {
    const connection = this.config.connection()
    const meta = this.config.modelMeta(options.model) ?? {}
    const attempts = buildAttempts(this.config.pin(options.model))
    // Image bytes are materialized once per call, not once per failover
    // candidate: the candidates differ only in where the request is routed.
    const hasImage = (options.messages ?? []).some((message) => contentHasImage(message.content ?? []))
    const images = await prepareRequestImages(
      options.messages,
      // Only the attachment service is resolved here, and only when the
      // history really carries an image, so a text-only call never touches it.
      hasImage ? this.config.resolveAttachments?.() : undefined,
      this.config.requestImagePolicy ?? DEFAULT_REQUEST_IMAGE_POLICY,
      options.signal,
    )
    const startedAt = Date.now()
    const trace = []
    let delivered = false
    let lastError = null
    /**
     * When the caller saw its first chunk, in ms from the request's own start.
     *
     * Measured from `startedAt` rather than from the serving attempt so it can be
     * read next to `ms`, which is also request-scoped: a failover attempt's dead
     * time is part of what the user actually waited through. Zero means no chunk
     * ever arrived, which is a fact worth keeping rather than a missing value.
     */
    let firstChunkMs = 0
    /**
     * When the gateway's first byte arrived, in ms from the request's own start.
     *
     * `ttft` answers "when did the caller see something"; this answers "when did
     * the gateway start talking at all". The pair separates two very different
     * stalls: a gateway that accepted the request and then sent nothing (both
     * late) from one that keeps the socket warm while the model thinks — a
     * keep-alive comment or an early frame produces bytes without producing a
     * chunk, and only having both tells those apart.
     */
    let firstByteMs = 0
    /**
     * Accounts this request has already been refused by.
     *
     * The pool is offered as one account with a combined quota, so a refusal that
     * is about the ACCOUNT — a spent window, a revoked key — moves to the next
     * one instead of ending the request. `resolveAccount` answers `undefined` once
     * nothing is left, which is when the real error is raised below.
     */
    const refused = new Set()
    for (const attempt of attempts) {
      const account = await this.config.resolveAccount({ exclude: [...refused] })
      if (account === undefined) break
      const body = injectPrefs(buildRequestBody(options, connection, images), meta, attempt)
      const attemptStarted = Date.now()
      const consumer = new AbortController()
      const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
      const watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
      try {
        let response
        try {
          response = await fetch(chatURL(account.baseURL), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${account.key}`,
              'content-type': 'application/json',
              accept: 'text/event-stream',
              ...attributionHeaders(),
            },
            body: JSON.stringify(body),
            signal: watchdog.signal,
          })
        } catch (error) {
          if (options.signal?.aborted) throw new LlmError('Cline Pass request aborted by caller', 'ABORTED', { cause: error })
          const note = errorChain(error)
          trace.push({ upstream: attempt.upstream ?? '(auto)', status: 0, ms: Date.now() - attemptStarted, note })
          this.config.learnUpstream(options.model, attempt.upstream, 'unknown', note, Date.now() - attemptStarted)
          lastError = new LlmError(note, 'TRANSPORT', { cause: error })
          continue
        }
        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          let detail = raw.slice(0, 400)
          try {
            const parsed = unwrapEnvelope(JSON.parse(raw))
            detail = errorText(parsed?.error) || detail
          } catch { /* keep the raw text */ }
          const ms = Date.now() - attemptStarted
          trace.push({ upstream: attempt.upstream ?? '(auto)', status: response.status, ms, note: detail.slice(0, 160) })
          this.config.learnUpstream(options.model, attempt.upstream, classifyUpstreamError(detail), detail, ms)
          lastError = new LlmError(`${detail || `HTTP ${response.status}`} [model=${options.model}]`, streamErrorCode(detail, response.status), { status: response.status })
          // A rejected pin or a busy upstream is worth another candidate. An
          // account-level refusal is worth another ACCOUNT: that is the whole
          // point of a pool, and with one account the next attempt simply finds
          // nothing left and this error is raised unchanged.
          if (lastError.code === 'AUTH' || lastError.code === QUOTA_EXCEEDED_CODE) {
            refused.add(account.name)
            this.config.record(options.model, {
              provider: null,
              attempts: trace.map((row) => row.upstream),
              ms: Date.now() - startedAt,
              stream: true,
              error: firstLine(lastError.message, 200),
              code: lastError.code,
              account: account.name,
            })
          }
          continue
        }
        if (response.body === null || response.body === undefined) {
          lastError = new LlmError('gateway returned no response body', 'EMPTY_RESPONSE', { status: response.status })
          continue
        }
        let yielded = false
        const observed = { provider: null, canonical: null, pipeline: null }
        // `body` in this scope is the request payload, so the response stream
        // gets its own name.
        const responseBody = tapFirstByte(response.body, () => {
          if (firstByteMs === 0) firstByteMs = Date.now() - startedAt
        })
        const iterator = translate(tapRouting(parseServerSentEvents(responseBody), observed))[Symbol.asyncIterator]()
        /**
         * The usage frame, captured as it passes through.
         *
         * The gateway sends it in the last frames, after the content, so a record
         * written when the stream ends has it — but only if the chunk was read on
         * its way to the caller. `reasoningTokens` in particular is the number
         * that explains a large time-to-first-chunk: it is thinking the caller
         * cannot see, because this gateway does not stream it.
         */
        let usage = null
        try {
          for (;;) {
            const next = await watchdog.next(iterator)
            if (next.done === true) break
            if (next.value?.type === 'usage') usage = next.value.usage
            if (firstChunkMs === 0) firstChunkMs = Date.now() - startedAt
            yielded = true
            yield next.value
          }
        } catch (error) {
          if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
            throw new LlmError(`Cline Pass stream idle timeout after ${connection.streamIdleTimeoutMs}ms [model=${options.model}]`, 'TIMEOUT', { cause: error })
          }
          if (options.signal?.aborted) throw new LlmError('Cline Pass request aborted by caller', 'ABORTED', { cause: error })
          const note = error instanceof LlmError ? error.message : errorChain(error)
          const ms = Date.now() - attemptStarted
          trace.push({ upstream: attempt.upstream ?? '(auto)', status: 200, ms, note: note.slice(0, 160) })
          this.config.learnUpstream(options.model, attempt.upstream, classifyUpstreamError(note), note, ms)
          // Content already reached the caller: this is the answer's failure, and
          // no retry can un-deliver it. Before any content, an account-level
          // refusal (a spent window, a revoked key) moves to the next account —
          // the pool exists to absorb exactly that.
          const code = error instanceof LlmError ? error.code : 'TRANSPORT'
          if (yielded) {
            this.config.record(options.model, {
              provider: observed.provider,
              canonical: observed.canonical,
              attempts: trace.map((row) => row.upstream),
              ms: Date.now() - startedAt,
              ttfb: firstByteMs,
              ttft: firstChunkMs,
              stream: true,
              error: note.slice(0, 200),
              code,
              account: account.name,
            })
            throw error instanceof LlmError ? error : new LlmError(note, 'TRANSPORT', { cause: error })
          }
          if (code === 'AUTH' || code === QUOTA_EXCEEDED_CODE) {
            refused.add(account.name)
            this.config.record(options.model, {
              provider: observed.provider,
              canonical: observed.canonical,
              attempts: trace.map((row) => row.upstream),
              ms: Date.now() - startedAt,
              ttfb: firstByteMs,
              ttft: firstChunkMs,
              stream: true,
              error: note.slice(0, 200),
              code,
              account: account.name,
            })
          }
          lastError = error instanceof LlmError ? error : new LlmError(note, 'TRANSPORT', { cause: error })
          continue
        } finally {
          consumer.abort('Cline Pass stream consumer stopped')
          if (iterator.return !== undefined) {
            try {
              await iterator.return()
            } catch { /* the consumer controller already owns termination */ }
          }
        }
        delivered = true
        // Which channel answered is read back from the stream, because a 200
        // only proves someone answered. The router drops an unusable `only`
        // without complaining, so "we asked for baseten" and "baseten served it"
        // are different facts and only the second one is evidence.
        const adherence = pinAdherence(attempt, { finalProvider: observed.provider })
        const warnings = pinWarnings(attempt, meta)
        trace.push({
          upstream: attempt.upstream ?? '(auto)',
          status: 200,
          ms: Date.now() - attemptStarted,
          note: adherence === 'not-adopted' || adherence === 'violated'
            ? `pin not adopted: served by ${observed.provider ?? '(unknown)'}`
            : 'ok',
        })
        this.config.record(options.model, {
          provider: observed.provider ?? (attempt.upstream ?? null),
          canonical: observed.canonical,
          attempts: trace.map((row) => row.upstream),
          ms: Date.now() - startedAt,
          ttfb: firstByteMs,
          ttft: firstChunkMs,
          stream: true,
          error: null,
          account: account.name,
          adherence,
          warnings,
          // What the request cost in tokens, and how much of that the model spent
          // thinking invisibly — the two numbers that explain a large `ttft`.
          usage,
          effort: options.reasoningEffort ?? '',
        })
        // Only a pin the router actually honored proves the channel works.
        // Marking it usable no matter who answered is how a false "available"
        // reached the verdict map the exclusion allow-list is built from — the
        // map then vouched for the very channels it was meant to exclude.
        if (attempt.upstream !== null && adherence === 'adopted') this.config.learnUpstream(options.model, attempt.upstream, 'ok', '', Date.now() - attemptStarted)
        return
      } finally {
        watchdog[Symbol.dispose]()
      }
    }
    if (!delivered) {
      const message = lastError?.message ?? 'no pinned upstream could serve the request'
      this.config.record(options.model, {
        provider: null,
        attempts: trace.map((row) => row.upstream),
        ms: Date.now() - startedAt,
        ttfb: firstByteMs,
        ttft: firstChunkMs,
        stream: true,
        error: message.slice(0, 200),
        account: null,
      })
      throw lastError ?? new LlmError(`${message} [model=${options.model}]`, 'UPSTREAM')
    }
  }
}
