/**
 * Self-contained smoke test for dsh-cline-pass.
 *
 * A stub gateway speaks the Cline Pass wire protocol (OpenAI-compatible SSE
 * plus the planner/direct routing metadata), records every request body, and
 * can refuse specific pinned upstreams. Against it the test drives:
 *
 * - the pure protocol layer (pin injection, failover expansion, error parsing),
 * - the LLM adapter, asserting the exact harness chunk sequence,
 * - pre-first-token failover across pinned candidates,
 * - every registered tool, validating each returned value against that tool's
 *   own declared output schema.
 *
 * No network and no dsh process are involved. Run with: node test/smoke.mjs
 */

import { createServer } from 'node:http'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { ClinePassAdapter, Config, DEFAULT_REQUEST_IMAGE_POLICY, apply, inject, name } from '../lib/index.js'
import { buildRequestBody, prepareRequestImages, projectImageDimensions, reasoningOf, requestImageTarget } from '../lib/adapter.js'
import { createEngine } from '../lib/engine.js'
import { createPanel, PANEL_ERROR_CODE, PANEL_PATH, registerPanel } from '../lib/panel.js'
import {
  buildAttempts,
  classifyUpstreamError,
  extractAvailableProviders,
  injectPrefs,
  mergeUpstreams,
  normalizeSort,
  parseRouting,
  parseTier0,
} from '../lib/protocol.js'
import { createStore } from '../lib/store.js'
import { MODEL_CATALOG, REASONING_EFFORTS, resolveModelMetadata } from '../lib/catalog.js'

// ── stub gateway ────────────────────────────────────────────────────────────

const PIPELINES = {
  'cline-pass/glm-5.2': { pipeline: 'planner', upstreams: ['alibaba', 'baseten'] },
  'cline-pass/kimi-k3': { pipeline: 'direct', upstreams: ['gmicloud', 'novita'] },
}

const stub = {
  /** upstream slugs that refuse a strict pin */
  broken: [],
  /** every request body received, in order */
  requests: [],
  /** which content the next successful stream carries */
  stream: 'tool-call',
  /** when true the gateway drops the pin and serves `servedBy` instead */
  ignorePins: false,
  /** the channel a pin-ignoring gateway routes to */
  servedBy: 'deepseek',
}

/** The pin a request carries, read back per pipeline. */
function readPin(body, pipeline) {
  if (pipeline === 'planner') {
    const gateway = body?.providerOptions?.gateway ?? {}
    return { only: gateway.only ?? null, order: gateway.order ?? null, sort: gateway.sort ?? null }
  }
  const provider = body?.provider ?? {}
  return { only: provider.only ?? null, order: provider.order ?? null, sort: provider.sort ?? null }
}

/** The upstream a request would reach under this pin. */
function effectiveUpstream(pin, fallback) {
  return pin.only?.[0] ?? pin.order?.[0] ?? fallback
}

/** A planner-style routing-layer rejection that names every usable upstream. */
function routingError(upstreams) {
  return {
    error: `invalid_request_error: No allowed providers available. Available providers are: ${upstreams.join(', ')}.`,
  }
}

/** The SSE frames of one successful stream. */
function streamFrames(upstream, pipeline, variant) {
  const routing = pipeline === 'planner'
    ? { provider_metadata: { gateway: { routing: { finalProvider: upstream, canonicalSlug: 'z-ai/glm-5.2', fallbacksAvailable: ['baseten'], planningReasoning: 'alibaba won tier 0 over baseten' } } } }
    : { provider: upstream, model: 'z-ai/glm-5.2' }
  const frames = []
  if (variant === 'tool-call') {
    frames.push({ choices: [{ index: 0, delta: { content: 'Hel' } }] })
    frames.push({ choices: [{ index: 0, delta: { content: 'lo' } }] })
    frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"a"' } }] } }] })
    frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] })
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else if (variant === 'reasoning') {
    // This variant deliberately carries ONLY the flat `reasoning` field, so the
    // test fails if the adapter ignores it. Supplying `reasoning_details` too
    // would let the details fallback mask a dropped flat field, which is
    // exactly how this bug survived the earlier suite.
    frames.push({ choices: [{ index: 0, delta: { reasoning: 'Think' } }] })
    frames.push({ choices: [{ index: 0, delta: { reasoning: 'ing' } }] })
    frames.push({ choices: [{ index: 0, delta: { content: 'Done' } }] })
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  } else if (variant === 'reasoning-both') {
    // The exact live wire shape: both fields present and agreeing.
    frames.push({ choices: [{ index: 0, delta: { reasoning: 'Think', reasoning_details: [{ type: 'reasoning.text', text: 'Think', format: 'unknown', index: 0 }] } }] })
    frames.push({ choices: [{ index: 0, delta: { reasoning: 'ing', reasoning_details: [{ type: 'reasoning.text', text: 'ing', format: 'unknown', index: 0 }] } }] })
    frames.push({ choices: [{ index: 0, delta: { content: 'Done' } }] })
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  } else if (variant === 'reasoning-native') {
    // The DeepSeek-native spelling some OpenAI-compatible backends use instead.
    frames.push({ choices: [{ index: 0, delta: { reasoning_content: 'Think' } }] })
    frames.push({ choices: [{ index: 0, delta: { reasoning_content: 'ing' } }] })
    frames.push({ choices: [{ index: 0, delta: { content: 'Done' } }] })
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  } else if (variant === 'reasoning-details-only') {
    // A gateway that omits the flat field entirely and nests the text in parts.
    frames.push({ choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Think', format: 'unknown', index: 0 }] } }] })
    frames.push({ choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', text: 'ing', format: 'unknown', index: 0 }] } }] })
    frames.push({ choices: [{ index: 0, delta: { content: 'Done' } }] })
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  } else if (variant === 'empty') {
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  } else {
    frames.push({ choices: [{ index: 0, delta: { content: 'OK' } }] })
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  }
  frames.push({ ...routing, choices: [] })
  frames.push({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } }, choices: [] })
  return frames
}

const gateway = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  stub.requests.push(body)
  const model = String(body?.model ?? '')
  const entry = PIPELINES[model] ?? { pipeline: 'planner', upstreams: ['alibaba', 'baseten'] }
  const pin = readPin(body, entry.pipeline)

  // The harvest probe pins an impossible channel to make the router list reality.
  if (pin.only?.includes('__probe__')) {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    return response.end(JSON.stringify(routingError(entry.upstreams)))
  }
  const upstream = stub.ignorePins === true
    ? (stub.servedBy ?? 'deepseek')
    : effectiveUpstream(pin, entry.upstreams[0])
  if (stub.broken.includes(upstream)) {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    return response.end(JSON.stringify({ error: `invalid_request_error: upstream ${upstream} refused the pin` }))
  }

  if (body?.stream !== true) {
    const routing = entry.pipeline === 'planner'
      ? { provider_metadata: { gateway: { routing: { finalProvider: upstream, canonicalSlug: 'z-ai/glm-5.2', fallbacksAvailable: ['baseten'], planningReasoning: 'alibaba won tier 0 over baseten' } } } }
      : { provider: upstream, model: 'z-ai/glm-5.2' }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    return response.end(JSON.stringify({
      ...routing,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }))
  }

  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const frame of streamFrames(upstream, entry.pipeline, stub.stream)) {
    response.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  response.write('data: [DONE]\n\n')
  response.end()
})

await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${gateway.address().port}/api/v1`

// ── harness ─────────────────────────────────────────────────────────────────

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) passed += 1
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/** Redact a secret the way the plugin reports one (mirrors `lib/index.js`). */
function maskKey(value) {
  const key = String(value ?? '')
  if (key.length === 0) return ''
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/** Resolve a settings section's account pool, including the implicit default. */
function accountProfilesOf(section) {
  const declared = Object.entries(section.accounts ?? {})
  if (declared.length === 0) {
    return [{
      key: 'default',
      displayName: section.displayName,
      apiKeyEnv: section.apiKeyEnv,
      enabled: true,
      baseURL: section.baseURL,
    }]
  }
  return declared.map(([key, profile]) => ({
    key,
    displayName: String(profile?.displayName ?? '') || key,
    apiKeyEnv: String(profile?.apiKeyEnv ?? section.apiKeyEnv),
    enabled: profile?.enabled !== false,
    baseURL: String(profile?.baseURL ?? '') || section.baseURL,
  }))
}

/** Collect every chunk one adapter stream yields. */
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function adapterFor({ store, pin = () => ({}), records = [], learned = [], attachments }) {
  return {
    adapter: new ClinePassAdapter({
      connection: () => ({
        baseURL,
        displayName: 'Cline Pass',
        models: Object.keys(PIPELINES).map((id) => ({ id, name: id })),
        defaultContextWindow: 128000,
        maxTokens: 32000,
        reasoningModels: true,
        streamIdleTimeoutMs: 30000,
      }),
      modelMeta: (model) => store.metaOf(model),
      pin,
      resolveAccount: async () => ({ name: 'default', key: 'sk_test', baseURL }),
      discoveredContext: () => undefined,
      resolveAttachments: () => attachments,
      record: (model, info) => records.push({ model, ...info }),
      learnUpstream: (model, upstream, status, note, ms) => learned.push({ model, upstream, status, note, ms }),
    }),
    records,
    learned,
  }
}

try {
  // ── protocol ──────────────────────────────────────────────────────────────

  check('plugin identity', name === 'cline-pass' && same(inject, ['llm', 'tools']))
  check('config schema compiles', typeof Config === 'object' || typeof Config === 'function')
  // From dsh 0.1.6 the settings service refuses EVERY write to an entry whose
  // schema declares no volatile field (`volatileForm` returns undefined), which
  // makes the panel's saves fail while its reads still work — exactly the
  // "buttons do nothing" failure. The whole section is live: every consumer
  // reads through the plugin's `current()` source thunk.
  // Marking the writable fields is what the shipped packages do (ui-theme,
  // agent-default-model, bash-local, llm-pi-ai): a whole-object `.volatile()`
  // instead collapses the schema to `{}`, dropping every default with it.
  // This mirrors `volatileForm()` in dsh-settings, which walks the schema and
  // returns undefined when no field is live.
  const hasLiveField = (schema) => {
    if (schema?.meta?.volatile === true) return true
    if (schema?.type !== 'object') return false
    return Object.values(schema.dict ?? {}).some(hasLiveField)
  }
  // Only the newer line has the concept at all: schemastery 3.18.2 (0.1.5) has
  // no `.volatile()`, and its settings service accepts writes without the
  // declaration. Where the line does support it, at least one field must be
  // marked or every save is rejected with "has no volatile fields".
  const lineSupportsVolatile = typeof Config.volatile === 'function' || Config.meta?.volatile !== undefined
  check('the config writes into live fields where the line requires it', !lineSupportsVolatile || hasLiveField(Config) === true, `${JSON.stringify(Config.meta)} volatile=${String(Config.meta?.volatile)}`)

  const plannerPin = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: ['alibaba', 'baseten'] }, { upstream: 'alibaba', strict: true, sort: 'cost' })
  check('strict pin on the planner pipeline uses providerOptions.gateway.only', same(plannerPin.providerOptions, { gateway: { only: ['alibaba'], sort: 'cost' } }), JSON.stringify(plannerPin))
  const directPin = injectPrefs({ model: 'm' }, { pipeline: 'direct', upstreams: ['gmicloud'] }, { upstream: 'gmicloud', strict: true, sort: 'ttft' })
  check('strict pin on the direct pipeline uses provider.only and OpenRouter sort names', same(directPin.provider, { only: ['gmicloud'], sort: 'latency' }), JSON.stringify(directPin))
  const unknownPin = injectPrefs({ model: 'm' }, { pipeline: null, upstreams: ['a'] }, { upstream: 'a', strict: true })
  check('an unknown pipeline gets both spellings', same(unknownPin.provider, { only: ['a'] }) && same(unknownPin.providerOptions, { gateway: { only: ['a'] } }), JSON.stringify(unknownPin))
  const preferred = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: ['a', 'b', 'c'] }, { upstream: 'a', strict: false, orderRest: ['b', 'c'], excludeList: ['c'] })
  check('preferred pin orders candidates and allow-lists the exclusions', same(preferred.providerOptions.gateway, { order: ['a', 'b', 'c'], only: ['a', 'b'] }), JSON.stringify(preferred))
  const autoExclude = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: ['a', 'b'] }, { upstream: null, excludeList: ['b'] })
  check('automatic routing turns excludes into an allow-list', same(autoExclude.providerOptions.gateway, { only: ['a'] }), JSON.stringify(autoExclude))
  check('no pin and no exclusion leaves the body untouched', same(injectPrefs({ model: 'm' }, {}, {}), { model: 'm' }))

  check('strict candidates expand in order', same(buildAttempts({ upstreams: ['a', 'b'], pinMode: 'strict' }).map((attempt) => attempt.upstream), ['a', 'b']))
  check('excluded candidates are dropped from the chain', same(buildAttempts({ upstreams: ['a', 'b'], exclude: ['a'] }).map((attempt) => attempt.upstream), ['b']))
  check('an empty pin is one automatic candidate', same(buildAttempts({ upstreams: [], exclude: ['a'] }), [{ strict: true, sort: null, excludeList: ['a'], upstream: null, orderRest: [] }]))
  check('preferred candidates carry the rest as fallback order', same(buildAttempts({ upstreams: ['a', 'b'], pinMode: 'preferred' })[0].orderRest, ['b']))

  // ── an empty sort must never reach the wire ────────────────────────────────
  // The settings schema spells "no sort" as `''`, and the gateway rejects it:
  // `providerOptions.gateway.sort: ""` is an HTTP 400 ("expected one of
  // cost|ttft|tps|..."). Every config shape the panel or auto-configure can
  // write is exercised here, because a single unnormalized empty string makes
  // the whole model unusable.
  check('normalizeSort maps an empty string to null', normalizeSort('') === null && normalizeSort(undefined) === null && normalizeSort(null) === null)
  check('normalizeSort treats the documented "none" as no sort', normalizeSort('none') === null && normalizeSort('  ') === null)
  check('normalizeSort keeps a real metric', normalizeSort('ttft') === 'ttft' && normalizeSort('cost') === 'cost')
  check('an empty sort normalizes away in buildAttempts', buildAttempts({ upstreams: ['a'], pinMode: 'strict', sort: '' })[0].sort === null)
  check('an empty sort injects no gateway sort', !('sort' in (injectPrefs({ model: 'm' }, { pipeline: 'planner' }, { upstream: 'a', strict: true, sort: '' }).providerOptions.gateway)))
  check('an empty sort injects no direct sort', !('sort' in injectPrefs({ model: 'm' }, { pipeline: 'direct' }, { upstream: 'a', strict: true, sort: '' }).provider))
  check('a "none" sort injects no sort either', !('sort' in (injectPrefs({ model: 'm' }, { pipeline: 'planner' }, buildAttempts({ upstreams: ['a'], pinMode: 'strict', sort: 'none' })[0]).providerOptions.gateway)))
  check('a config with no channel and no sort injects nothing at all', injectPrefs({ model: 'm' }, { pipeline: 'planner' }, buildAttempts({ upstreams: [], exclude: [], pinMode: 'strict', sort: '' })[0]).providerOptions === undefined)

  // Whatever a configuration says, the emitted sort is one the gateway accepts.
  const SORT_VOCABULARY = new Set(['cost', 'ttft', 'tps', 'price', 'latency', 'throughput'])
  const sortProblems = []
  for (const sort of ['', undefined, null, 'none', 'ttft', 'cost', 'tps']) {
    for (const pinMode of ['strict', 'preferred']) {
      for (const upstreams of [[], ['a'], ['a', 'b']]) {
        for (const pipeline of ['planner', 'direct', null]) {
          const attempt = buildAttempts({ upstreams, exclude: [], pinMode, sort })[0]
          const body = injectPrefs({ model: 'm' }, { pipeline, upstreams: ['a', 'b'] }, attempt)
          const emitted = [body.provider?.sort, body.providerOptions?.gateway?.sort].filter((value) => value !== undefined)
          for (const value of emitted) {
            if (typeof value !== 'string' || value.length === 0 || !SORT_VOCABULARY.has(value)) {
              sortProblems.push(`${JSON.stringify({ sort, pinMode, upstreams, pipeline })} -> ${JSON.stringify(value)}`)
            }
          }
        }
      }
    }
  }
  check('no configuration can put an invalid sort on the wire', sortProblems.length === 0, sortProblems.slice(0, 3).join(' | '))

  // An invalid-but-non-empty sort is the user's explicit choice and is passed
  // through, so the gateway's own diagnostic names the value.
  check('a real sort still reaches both spellings', (() => {
    const attempt = buildAttempts({ upstreams: ['a'], pinMode: 'strict', sort: 'ttft' })[0]
    const planner = injectPrefs({ model: 'm' }, { pipeline: 'planner' }, attempt)
    const direct = injectPrefs({ model: 'm' }, { pipeline: 'direct' }, attempt)
    return planner.providerOptions.gateway.sort === 'ttft' && direct.provider.sort === 'latency'
  })())

  check('routing is read from planner metadata', parseRouting({ provider_metadata: { gateway: { routing: { finalProvider: 'alibaba', canonicalSlug: 'z-ai/glm-5.2' } } } }).pipeline === 'planner')
  check('routing is read from a direct provider field', parseRouting({ provider: 'GMICloud', model: 'z-ai/glm-5.2', choices: [{ message: { content: 'hi' } }] }).pipeline === 'direct')
  check('an enveloped answer is unwrapped', parseRouting({ data: { provider: 'GMICloud', choices: [{ message: { content: 'hi' } }] } }).finalProvider === 'gmicloud')
  check('classify: rate limit', classifyUpstreamError('429 Too Many Requests') === 'limited')
  check('classify: not pinnable', classifyUpstreamError('invalid_request_error: no allowed providers') === 'bad')
  check('classify: empty reasoning response still means the channel answered', classifyUpstreamError('empty response content') === 'ok')
  check('harvest reads the planner sentence', same(extractAvailableProviders('Available providers are: alibaba, baseten.', 'planner'), ['alibaba', 'baseten']))
  check('harvest ignores JSON fragments in the sentence', same(extractAvailableProviders('Available providers are: alibaba, ","type":"invalid_request_error".', 'planner'), ['alibaba']))
  check('harvest reads OpenRouter metadata', same(extractAvailableProviders('nope {"error":{"metadata":{"available_providers":["gmicloud"]}}}', 'direct'), ['gmicloud']))
  check('tier-0 parsing', same(parseTier0('alibaba won tier 0 over baseten and novita'), ['alibaba', 'baseten', 'novita']))
  check('upstream merge keeps order and drops duplicates', same(mergeUpstreams(['b', 'a'], ['a', 'c']), ['b', 'a', 'c']))

  // ── adapter stream ────────────────────────────────────────────────────────

  const store = createStore({ historyLimit: 10 })
  store.learn('cline-pass/glm-5.2', { pipeline: 'planner', upstreams: ['alibaba', 'baseten'], pinnable: true })

  const plain = adapterFor({ store })
  const chunks = await collect(plain.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    system: 'be brief',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
    signal: new AbortController().signal,
  })
  const types = chunks.map((chunk) => chunk.type)
  check('a text stream opens a block, emits deltas, and closes it', same(types.slice(0, 3), ['block-start', 'text-delta', 'text-delta']), types.join(','))
  check('the text block closes with the accumulated text', same(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')?.block, { type: 'text', text: 'Hello' }), JSON.stringify(chunks.filter((chunk) => chunk.type === 'block-end')))
  check('the tool call opens its own block', chunks.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'tool-call'))
  check('tool arguments accumulate across deltas', same(chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block, { type: 'tool-call', id: 'call_1', name: 'echo', arguments: '{"a":1}' }), JSON.stringify(chunks.filter((chunk) => chunk.type === 'block-end')))
  check('usage subtracts cached tokens from the input count', same(chunks.find((chunk) => chunk.type === 'usage')?.usage, { inputTokens: 8, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2 }), JSON.stringify(chunks.find((chunk) => chunk.type === 'usage')))
  check('finish reports the tool-call reason', same(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } }), JSON.stringify(chunks.at(-1)))
  check('the finish chunk is last', types.at(-1) === 'finish')
  check('history recorded the serving upstream', plain.records.length === 1 && plain.records[0].provider === 'alibaba', JSON.stringify(plain.records))
  // First-chunk time is what a user waits before anything appears, and it is
  // measured from the request's start so it can be read next to `ms`.
  check('the successful call records when its first chunk arrived', Number.isSafeInteger(plain.records[0].ttft) && plain.records[0].ttft > 0, JSON.stringify(plain.records[0].ttft))
  check('the first chunk never arrives after the request ends', plain.records[0].ttft <= plain.records[0].ms, `${plain.records[0].ttft} vs ${plain.records[0].ms}`)
  // The first byte is the gateway starting to talk at all; the pair is what tells
  // "the socket is warm while the model thinks" from "the gateway said nothing".
  check('the successful call records when its first byte arrived', Number.isSafeInteger(plain.records[0].ttfb) && plain.records[0].ttfb > 0, JSON.stringify(plain.records[0].ttfb))
  check('the first byte never follows the first chunk', plain.records[0].ttfb <= plain.records[0].ttft, `${plain.records[0].ttfb} vs ${plain.records[0].ttft}`)
  // Token counts come from the usage frame, which the gateway sends last, so
  // capturing it means reading the chunk on its way to the caller. The reasoning
  // count is what explains a long first-chunk wait: it is thinking the caller
  // cannot see, because this gateway does not stream it.
  check('the successful call records its token usage', plain.records[0].usage?.inputTokens === 8 && plain.records[0].usage?.outputTokens === 5, JSON.stringify(plain.records[0].usage))
  // The cache count is present in this frame; the reasoning count is optional —
  // `mapUsage` only carries it when the gateway reported it, so absent is a legal
  // state and must not be read as zero reasoning.
  check('the recorded usage carries the cache count', plain.records[0].usage?.cacheReadTokens === 2, JSON.stringify(plain.records[0].usage))
  check('the reasoning count is either reported or absent', plain.records[0].usage?.reasoningTokens === undefined || Number.isSafeInteger(plain.records[0].usage.reasoningTokens), JSON.stringify(plain.records[0].usage))
  check('the call records the reasoning effort it ran at', typeof plain.records[0].effort === 'string', JSON.stringify(plain.records[0].effort))
  check('the request carried the pinned model and stream flag', stub.requests.at(-1).model === 'cline-pass/glm-5.2' && stub.requests.at(-1).stream === true)
  check('the system prompt and tool schema reached the wire', stub.requests.at(-1).messages[0].role === 'system' && stub.requests.at(-1).tools[0].function.name === 'echo')

  stub.stream = 'reasoning'
  const reasoning = await collect(plain.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: new AbortController().signal,
  })
  check('reasoning deltas open a reasoning block', reasoning.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'reasoning'))
  check('reasoning text is accumulated', reasoning.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')?.block.text === 'Thinking')
  check('a plain completion finishes with stop', same(reasoning.at(-1).reason, { kind: 'stop' }))
  check('the reasoning block is emitted as reasoning-delta chunks', reasoning.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('') === 'Thinking', JSON.stringify(reasoning.filter((chunk) => chunk.type === 'reasoning-delta')))
  check('the visible answer still streams after the thinking', reasoning.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('') === 'Done', JSON.stringify(reasoning.filter((chunk) => chunk.type === 'text-delta')))

  // Every wire spelling must produce identical harness chunks: the gateway
  // streams `reasoning`, some OpenAI-compatible backends use the DeepSeek-native
  // `reasoning_content`, and a third shape nests the text in parts only.
  const shapes = {}
  for (const variant of ['reasoning', 'reasoning-both', 'reasoning-native', 'reasoning-details-only']) {
    stub.stream = variant
    const stream = await collect(plain.adapter, {
      provider: 'cline-pass',
      model: 'cline-pass/glm-5.2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: new AbortController().signal,
    })
    shapes[variant] = {
      reasoning: stream.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''),
      text: stream.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''),
      block: stream.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')?.block.text,
    }
  }
  check('the gateway spelling (delta.reasoning alone) yields the thinking', shapes['reasoning']?.reasoning === 'Thinking', JSON.stringify(shapes['reasoning']))
  check('the live wire shape (reasoning + details) yields the thinking', shapes['reasoning-both']?.reasoning === 'Thinking', JSON.stringify(shapes['reasoning-both']))
  check('the native spelling (delta.reasoning_content) yields the thinking', shapes['reasoning-native']?.reasoning === 'Thinking', JSON.stringify(shapes['reasoning-native']))
  check('a details-only gateway still yields the thinking', shapes['reasoning-details-only']?.reasoning === 'Thinking', JSON.stringify(shapes['reasoning-details-only']))
  check('every spelling produces the same closed block', Object.values(shapes).every((shape) => shape.block === 'Thinking'), JSON.stringify(shapes))
  check('every spelling still delivers the answer', Object.values(shapes).every((shape) => shape.text === 'Done'), JSON.stringify(shapes))
  check('reasoningOf prefers the flat field over the parts', reasoningOf({ reasoning: 'flat', reasoning_details: [{ text: 'nested' }] }) === 'flat')
  check('reasoningOf ignores an empty flat field', reasoningOf({ reasoning: '', reasoning_details: [{ text: 'nested' }] }) === 'nested')
  check('reasoningOf reports nothing for a content-only frame', reasoningOf({ content: 'x' }) === undefined)
  stub.stream = 'tool-call'

  stub.stream = 'empty'
  const empty = await collect(plain.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: new AbortController().signal,
  })
  check('an empty completion is an EMPTY_RESPONSE error finish', empty.at(-1).reason.kind === 'error' && empty.at(-1).reason.failure.code === 'EMPTY_RESPONSE', JSON.stringify(empty.at(-1)))
  stub.stream = 'tool-call'

  // ── failover ──────────────────────────────────────────────────────────────

  stub.broken = ['baseten']
  const before = stub.requests.length
  const failover = adapterFor({ store, pin: () => ({ upstreams: ['baseten', 'alibaba'], pinMode: 'strict', sort: '', exclude: [] }) })
  const served = await collect(failover.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: new AbortController().signal,
  })
  const attempts = stub.requests.slice(before)
  check('a refused first candidate fails over to the next', attempts.length === 2 && same(attempts[0].providerOptions.gateway.only, ['baseten']) && same(attempts[1].providerOptions.gateway.only, ['alibaba']), JSON.stringify(attempts.map((body) => body.providerOptions)))
  check('the failover stream still delivers content', served.some((chunk) => chunk.type === 'text-delta'))
  check('the recorded trace lists both attempts', same(failover.records[0]?.attempts, ['baseten', 'alibaba']), JSON.stringify(failover.records))
  check('the refused channel was learned as not-pinnable', failover.learned.some((entry) => entry.upstream === 'baseten' && entry.status === 'bad'), JSON.stringify(failover.learned))

  stub.broken = ['baseten', 'alibaba']
  const exhausted = adapterFor({ store, pin: () => ({ upstreams: ['baseten', 'alibaba'], pinMode: 'strict', sort: '', exclude: [] }) })
  let exhaustedError = ''
  try {
    await collect(exhausted.adapter, {
      provider: 'cline-pass',
      model: 'cline-pass/glm-5.2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: new AbortController().signal,
    })
  } catch (error) {
    exhaustedError = String(error?.message ?? error)
  }
  check('every candidate failing raises one clear error', /refused the pin/.test(exhaustedError), exhaustedError)
  check('the failed call is recorded with its whole trace', exhausted.records.length === 1 && same(exhausted.records[0].attempts, ['baseten', 'alibaba']), JSON.stringify(exhausted.records))
  // Zero is the fact "nothing ever arrived", not a missing measurement: the
  // panel renders it as a dash rather than as an instant answer.
  check('a call that streamed nothing records a zero first-chunk time', exhausted.records[0].ttft === 0, JSON.stringify(exhausted.records[0].ttft))
  check('a call that never got a byte records a zero first-byte time', exhausted.records[0].ttfb === 0, JSON.stringify(exhausted.records[0].ttfb))
  stub.broken = []

  // ── tools through the plugin ──────────────────────────────────────────────

  const tools = new Map()
  const credentials = new Map([['CLINE_PASS_API_KEY', 'sk_live_test_key_123456']])
  let section = {
    provider: 'cline-pass',
    displayName: 'Cline Pass',
    baseURL,
    apiKeyEnv: 'CLINE_PASS_API_KEY',
    accounts: {},
    accountMode: 'single',
    activeAccount: '',
    knownModels: Object.keys(PIPELINES),
    perModel: {},
    defaultContextWindow: 128000,
    defaultMaxTokens: 32000,
    streamIdleTimeoutMs: 30000,
    exposeCatalog: false,
    historyLimit: 20,
  }
  const settingsService = {
    installSection(_owner, _ns, _schema, entry, hooks) {
      hooks.setSource(() => section)
      void entry
    },
    async update(_ns, patch) {
      section = { ...section, ...patch }
    },
  }
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: settingsService,
    credentials: {
      async resolve(ref) {
        const value = credentials.get(String(ref))
        return value === undefined ? undefined : { value, source: 'test' }
      },
      async set(ref, value) {
        credentials.set(String(ref), value)
      },
    },
    get(serviceName) {
      return this[serviceName]
    },
    inject(names, callback) {
      if (names.includes('settings')) callback(this)
      if (names.includes('credentials')) callback(this)
    },
    llm: {
      registered: null,
      registerAdapter(routes, adapter) {
        this.registered = { routes, adapter }
        return Object.assign(() => {}, { replace() {} })
      },
      registerConfigurableProviders(entries) {
        this.directory = entries
        return Object.assign(() => {}, { replace() {} })
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }

  apply(fakeCtx, { ...section })
  await new Promise((resolve) => setTimeout(resolve, 10))

  // The panel drives the same engine and control surface the tools use, so it
  // is exercised against the live section and credential map the tools wrote.
  const panelControl = {
    providerName: 'cline-pass',
    displayName: 'Cline Pass',
    settingsAvailable: () => true,
    routeRegistered: () => true,
    readConfig: () => section,
    updateConfig: async (patch) => { section = { ...section, ...patch } },
    accounts: () => accountProfilesOf(section),
    accountsWithKeys: async () => await Promise.all(accountProfilesOf(section).map(async (account) => {
      const value = credentials.get(String(account.apiKeyEnv))
      return {
        key: account.key,
        displayName: account.displayName,
        apiKeyEnv: String(account.apiKeyEnv),
        enabled: account.enabled,
        keyConfigured: value !== undefined,
        keyHint: maskKey(value),
      }
    })),
    readCredential: async (ref) => credentials.get(String(ref)) ?? '',
    setCredential: async (ref, value) => { credentials.set(String(ref), String(value)) },
    refreshCatalog: async () => ({ added: [], models: section.knownModels, sources: ['test'] }),
  }
  const panelEngine = createEngine({
    resolveAccount: async () => ({ name: 'default', key: credentials.get('CLINE_PASS_API_KEY'), baseURL }),
    store,
    logger: fakeCtx.logger,
  })
  panelEngine.setPinReader((model) => section.perModel?.[model] ?? {})

  check('the provider route is registered', same(fakeCtx.llm.registered?.routes, ['cline-pass']))
  check('the configurable-provider directory entry is registered', fakeCtx.llm.directory?.[0]?.provider === 'cline-pass' && fakeCtx.llm.directory[0].settingsNs === 'cline-pass')
  const expectedTools = ['cline_pass_status', 'cline_pass_models', 'cline_pass_probe', 'cline_pass_validate', 'cline_pass_test', 'cline_pass_pin', 'cline_pass_accounts', 'cline_pass_history']
  check('every tool is registered', expectedTools.every((toolName) => tools.has(toolName)), [...tools.keys()].join(','))
  check('no extra tools', tools.size === expectedTools.length, [...tools.keys()].join(','))

  async function call(toolName, args = {}) {
    const tool = tools.get(toolName)
    if (tool === undefined) throw new Error(`tool ${toolName} is not registered`)
    const value = await tool.execute(args, { signal: new AbortController().signal })
    const violations = validateJsonSchemaValue(tool.output.schema, value, 'output')
    check(`${toolName} output matches its schema`, violations.length === 0, violations.join('; '))
    const blocks = tool.output.render(args, value)
    check(`${toolName} renders`, Array.isArray(blocks) && blocks.length > 0 && typeof blocks[0].text === 'string')
    return value
  }

  const status = await call('cline_pass_status')
  check('status sees the implicit default account and its key', status.accounts.length === 1 && status.accounts[0].keyConfigured === true, JSON.stringify(status.accounts))
  check('status masks the key', status.accounts[0].keyHint === 'sk_liv…3456', status.accounts[0].keyHint)
  check('status never echoes the key', !JSON.stringify(status).includes('sk_live_test_key_123456'))
  check('status reports the registered route and live settings', status.routeRegistered === true && status.settingsAvailable === true)
  check('status counts the model catalog', status.knownModels === 2, String(status.knownModels))

  const models = await call('cline_pass_models')
  check('models lists the configured catalog', models.models.length === 2, String(models.models.length))
  check('models starts unprobed', models.models.every((model) => model.pipeline === '' ))

  const probed = await call('cline_pass_probe', { model: 'cline-pass/glm-5.2' })
  check('probe detects the pipeline', probed.ok === true && probed.pipeline === 'planner', JSON.stringify(probed))
  check('probe harvests the channel list', same(probed.upstreams, ['alibaba', 'baseten']), JSON.stringify(probed.upstreams))
  check('probe adopted the tier-0 hint', same(probed.tier0, ['alibaba', 'baseten']), JSON.stringify(probed.tier0))

  const afterProbe = await call('cline_pass_models', { model: 'glm-5.2' })
  check('models reports the probed pipeline', afterProbe.models[0].pipeline === 'planner' && afterProbe.models[0].pinnable === true, JSON.stringify(afterProbe.models[0]))
  check('a substring filter still matches one model', afterProbe.models.length === 1)

  const validated = await call('cline_pass_validate', { model: 'cline-pass/glm-5.2' })
  check('validate tests every channel', validated.ok === true && validated.results.length === 2 && validated.summary.ok === 2, JSON.stringify(validated.summary))

  const tested = await call('cline_pass_test', { model: 'cline-pass/glm-5.2', upstreams: ['alibaba'] })
  check('test reports the serving upstream', tested.ok === true && tested.actual === 'alibaba', JSON.stringify(tested))
  check('test reports a single attempt', tested.trace.length === 1, JSON.stringify(tested.trace))
  check("test surfaces the router's own account of the decision", /won tier 0/.test(tested.plan), tested.plan)

  const pinned = await call('cline_pass_pin', { model: 'cline-pass/glm-5.2', upstreams: ['baseten', 'alibaba'], pinMode: 'preferred', sort: 'cost' })
  check('pin persists into the settings section', same(section.perModel['cline-pass/glm-5.2'], { upstreams: ['baseten', 'alibaba'], exclude: [], pinMode: 'preferred', sort: 'cost' }), JSON.stringify(section.perModel))
  check('pin reports what it stored', pinned.pinned.join() === 'baseten,alibaba' && pinned.sort === 'cost', JSON.stringify(pinned))
  const repinned = await call('cline_pass_pin', { model: 'cline-pass/glm-5.2', exclude: ['baseten'] })
  check('pin keeps fields it was not given', repinned.pinned.join() === 'baseten,alibaba' && repinned.excluded.join() === 'baseten', JSON.stringify(repinned))

  // ── a gateway that drops the pin ──────────────────────────────────────────
  // The live behavior this fork exists to expose: the router ignores an `only`
  // it cannot use and answers from a channel nobody asked for, with a clean 200.
  // Every check below fails against the unfixed code, which read that 200 as
  // success and recorded the pinned channel as verified-available — a verdict
  // that then fed the exclusion allow-list and hid the leak it described.

  stub.ignorePins = true

  const ignored = await call('cline_pass_test', { model: 'cline-pass/glm-5.2', upstreams: ['alibaba'] })
  check('an ignored pin fails the test instead of reporting success', ignored.ok === false, JSON.stringify(ignored))
  check('the ignored pin names the channel that actually served it', ignored.actual === 'deepseek' && ignored.adopted === false, JSON.stringify(ignored))
  check('the ignored pin says so in the error', /ignored the pin/.test(ignored.error), ignored.error)

  const violated = await call('cline_pass_test', { model: 'cline-pass/glm-5.2', upstreams: ['alibaba'], exclude: ['deepseek'] })
  check('an excluded channel serving the request is reported as a violation', violated.ok === false && /excluded channel/.test(violated.error), violated.error)

  const ignoredValidate = await call('cline_pass_validate', { model: 'cline-pass/glm-5.2' })
  check('no channel is called available while the pin is ignored', ignoredValidate.summary.ok === 0 && ignoredValidate.summary.bad === 2, JSON.stringify(ignoredValidate.summary))
  check('every channel carries the not-adopted verdict', ignoredValidate.results.every((row) => row.status === 'not-adopted'), JSON.stringify(ignoredValidate.results))

  const ignoredStore = createStore({ historyLimit: 5 })
  ignoredStore.learn('cline-pass/glm-5.2', { pipeline: 'planner', upstreams: ['alibaba', 'baseten'], pinnable: true })
  const ignoredRun = adapterFor({ store: ignoredStore, pin: () => ({ upstreams: ['alibaba'], pinMode: 'strict', sort: '', exclude: [] }) })
  stub.stream = 'tool-call'
  await collect(ignoredRun.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: new AbortController().signal,
  })
  check('a stream served elsewhere does not mark the pinned channel available', !ignoredRun.learned.some((entry) => entry.status === 'ok'), JSON.stringify(ignoredRun.learned))
  check('the stream records which channel really served it', ignoredRun.records[0]?.adherence === 'not-adopted' && ignoredRun.records[0]?.provider === 'deepseek', JSON.stringify(ignoredRun.records[0]))

  // The channel that answered is a real channel even when the router's own pool
  // omits it. That omission is how a model's official upstream stays invisible —
  // and it is why an exclusion built from the pool could never cover it.
  const ignoredProbe = await call('cline_pass_probe', { model: 'cline-pass/glm-5.2' })
  check('a probe learns the channel that actually served it', ignoredProbe.upstreams.includes('deepseek'), JSON.stringify(ignoredProbe.upstreams))
  check('the serving channel leads the list, out of reach of any bound', ignoredProbe.upstreams[0] === 'deepseek', JSON.stringify(ignoredProbe.upstreams))
  check('the router pool survives alongside it', ignoredProbe.upstreams.includes('alibaba') && ignoredProbe.upstreams.includes('baseten'), JSON.stringify(ignoredProbe.upstreams))

  stub.ignorePins = false

  const restoredProbe = await call('cline_pass_probe', { model: 'cline-pass/glm-5.2' })
  check('an ordinary probe goes back to the router pool alone', same(restoredProbe.upstreams, ['alibaba', 'baseten']), JSON.stringify(restoredProbe.upstreams))

  const cleared = await call('cline_pass_pin', { model: 'cline-pass/glm-5.2', upstreams: [], exclude: [], sort: 'none' })
  check('pin can clear back to automatic', cleared.pinned.length === 0 && cleared.excluded.length === 0 && cleared.sort === '')

  // With no pin there is nothing to confirm, so the render must not imply a pin
  // failed to take effect.
  const autoTool = tools.get('cline_pass_test')
  const autoValue = await autoTool.execute({ model: 'cline-pass/glm-5.2' }, { signal: new AbortController().signal })
  const autoText = autoTool.output.render({}, autoValue).map((block) => block.text).join('\n')
  check('automatic routing does not claim a pin could not be confirmed', autoValue.targets.length === 0 && !/could not be confirmed/.test(autoText), autoText)

  const added = await call('cline_pass_accounts', { action: 'add', name: 'backup', key: 'sk_backup_account_9876' })
  check('add registers the account', added.accounts.length === 2 && added.accounts.some((account) => account.key === 'backup'), JSON.stringify(added.accounts))
  check('add stores the key in the credential store', credentials.get('CLINE_PASS_BACKUP_KEY') === 'sk_backup_account_9876', String(credentials.get('CLINE_PASS_BACKUP_KEY')))
  check('the stored key is reported as configured', added.accounts.find((account) => account.key === 'backup').keyConfigured === true)
  const mode = await call('cline_pass_accounts', { action: 'mode', mode: 'roundrobin' })
  check('mode switches the pool to round-robin', mode.accountMode === 'roundrobin' && section.accountMode === 'roundrobin')
  const tested2 = await call('cline_pass_accounts', { action: 'test', name: 'backup' })
  check('account test authorizes a working key', tested2.note.includes('authorized'), tested2.note)
  const removed = await call('cline_pass_accounts', { action: 'remove', name: 'backup' })
  check('remove drops the account', removed.accounts.length === 1 && section.accounts.backup === undefined)
  let removeMissing = ''
  try {
    await call('cline_pass_accounts', { action: 'remove', name: 'nope' })
  } catch (error) {
    removeMissing = String(error.message)
  }
  check('removing an unknown account fails loudly', /no account named/.test(removeMissing), removeMissing)

  const history = await call('cline_pass_history', { limit: 5 })
  check('history records the probe, validate and test calls', history.total > 0, String(history.total))
  check('history rows carry the model and latency', history.entries.every((entry) => entry.model !== '' && Number.isSafeInteger(entry.ms)))
  // The tool hands the same latency pair the panel shows, and the render
  // spells it as `first/total`.
  check('history rows carry the first-chunk time', history.entries.every((entry) => Number.isSafeInteger(entry.ttft) && entry.ttft >= 0), JSON.stringify(history.entries.map((entry) => entry.ttft)))
  const historyText = tools.get('cline_pass_history').output.render({ limit: 5 }, history).map((block) => block.text).join('\n')
  check('the history render spells out first-chunk over total', /\d+ms\/\d+ms|—\/\d+ms/.test(historyText), historyText.slice(0, 200))

  // ── image input ───────────────────────────────────────────────────────────
  // The harness hands adapters durable attachment REFERENCES, never bytes, so
  // the adapter must resolve them through the attachment service and emit the
  // OpenAI content-part form. A model that advertises image input gets the
  // blocks; the harness projects them to text for one that does not.
  const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  // Every durable image reference carries its own intrinsic size; the request
  // target is derived from it, so the fixture must carry it too.
  const IMAGE_REF = { attachmentId: 'att-image-1', bytes: PNG_BYTES.length, mediaType: 'image/png', width: 2, height: 2 }
  const attachmentStore = {
    reads: [],
    async readImageRequest(ref, target) {
      this.reads.push({ ref, target })
      return { variantId: 'v1', attachment: ref, data: PNG_BYTES, mediaType: 'image/png', bytes: PNG_BYTES.length, width: 2, height: 2, depth: 'uchar', space: 'srgb', hasAlpha: false }
    },
  }

  const imageHistory = [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', attachment: IMAGE_REF },
    ],
  }]

  const imageRun = adapterFor({ store, attachments: attachmentStore })
  stub.stream = 'tool-call'
  stub.requests.length = 0
  await collect(imageRun.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: imageHistory,
    signal: new AbortController().signal,
  })
  const imageBody = stub.requests.at(-1)
  const userParts = imageBody?.messages?.find((message) => message.role === 'user')?.content
  check('an image message becomes a content-part array', Array.isArray(userParts), JSON.stringify(userParts).slice(0, 120))
  check('the text part survives beside the image', userParts?.[0]?.type === 'text' && userParts[0].text === 'what is in this image?', JSON.stringify(userParts?.[0]))
  check('the image becomes an inline image_url data URI', userParts?.[1]?.type === 'image_url' && userParts[1].image_url.url.startsWith('data:image/png;base64,'), JSON.stringify(userParts?.[1]).slice(0, 80))
  check('the base64 payload is the resolved request bytes', userParts?.[1]?.image_url.url === `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`, String(userParts?.[1]?.image_url.url))
  check('the attachment service was asked for one request version', attachmentStore.reads.length === 1 && attachmentStore.reads[0].ref.attachmentId === 'att-image-1', JSON.stringify(attachmentStore.reads.length))
  check('the request version was read with target dimensions and maxBytes', Number.isSafeInteger(attachmentStore.reads[0]?.target?.width) && attachmentStore.reads[0]?.target?.width > 0 && Number.isSafeInteger(attachmentStore.reads[0]?.target?.height) && attachmentStore.reads[0]?.target?.height > 0 && attachmentStore.reads[0]?.target?.maxBytes === DEFAULT_REQUEST_IMAGE_POLICY.maxBytes, JSON.stringify(attachmentStore.reads[0]?.target))
  // The two host lines validate opposite shapes, so the target must carry both
  // or every image fails on one of them: 0.1.2-0.1.5 check `maxPixels`/`maxBytes`,
  // 0.1.6+ check `width`/`height`/`maxBytes` and reject a missing `width`.
  const imageTarget = attachmentStore.reads[0]?.target
  check('the request target satisfies the 0.1.2-0.1.5 contract', Number.isSafeInteger(imageTarget?.maxPixels) && imageTarget?.maxPixels > 0, JSON.stringify(imageTarget))
  check('the request target satisfies the 0.1.6+ contract', Number.isSafeInteger(imageTarget?.width) && imageTarget?.width > 0 && Number.isSafeInteger(imageTarget?.height) && imageTarget?.height > 0, JSON.stringify(imageTarget))
  check('the projected dimensions respect the pixel budget', imageTarget.width * imageTarget.height <= imageTarget.maxPixels, `${imageTarget.width}x${imageTarget.height} > ${imageTarget.maxPixels}`)

  // A text-only call must never touch the attachment service.
  attachmentStore.reads.length = 0
  await collect(imageRun.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/glm-5.2',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }],
    signal: new AbortController().signal,
  })
  check('a text-only call resolves no images', attachmentStore.reads.length === 0, String(attachmentStore.reads.length))
  check('a text-only message keeps the plain string form', typeof stub.requests.at(-1)?.messages?.find((message) => message.role === 'user')?.content === 'string')

  // Images with no attachment service must fail loudly, not silently drop.
  const noStore = adapterFor({ store })
  let imageError = ''
  try {
    await collect(noStore.adapter, {
      provider: 'cline-pass',
      model: 'cline-pass/glm-5.2',
      messages: imageHistory,
      signal: new AbortController().signal,
    })
  } catch (error) {
    imageError = `${error?.code ?? ''} ${error?.message ?? error}`
  }
  check('an image with no attachment service is an explicit failure', /UNSUPPORTED_CONTENT/.test(imageError), imageError)

  // An image the map cannot resolve must not be silently dropped either.
  let unresolvedError = ''
  try {
    const partial = adapterFor({ store, attachments: { async readImageRequest() { return { data: PNG_BYTES, mediaType: 'image/png' } } } })
    buildRequestBody({ model: 'm', messages: imageHistory }, { defaultMaxTokens: 1 }, new Map())
    await collect(partial.adapter, { provider: 'cline-pass', model: 'cline-pass/glm-5.2', messages: imageHistory, signal: new AbortController().signal })
  } catch (error) {
    unresolvedError = String(error?.message ?? error)
  }
  check('an unresolved image reference is an explicit failure', /could not resolve|cannot read properties/i.test(unresolvedError), unresolvedError)

  // ── request-image geometry ──────────────────────────────────────────────────
  // The projection must be the harness's own geometry, because the older host
  // applies exactly this and the newer one takes the value as given: if the two
  // disagreed, the same image would render at different sizes per host.
  const small = projectImageDimensions(800, 600, 4194304)
  check('an image inside the budget is not resized', small.width === 800 && small.height === 600, JSON.stringify(small))
  const huge = projectImageDimensions(6000, 4000, 4194304)
  check('an oversized image is projected inside the budget', huge.width * huge.height <= 4194304 && huge.width > 0 && huge.height > 0, JSON.stringify(huge))
  check('the projection preserves the aspect ratio', Math.abs((huge.width / huge.height) - 1.5) < 0.01, JSON.stringify(huge))
  const tall = projectImageDimensions(1000, 10000, 1000000)
  check('a tall image is projected inside the budget too', tall.width * tall.height <= 1000000 && tall.width > 0 && tall.height > 0, JSON.stringify(tall))
  // A reference without usable dimensions cannot be turned into a target, and
  // must fail loudly rather than sending `undefined` as a width.
  let noSizeError = ''
  try {
    requestImageTarget({ attachmentId: 'att-x', mediaType: 'image/png', bytes: 4 }, DEFAULT_REQUEST_IMAGE_POLICY)
  } catch (error) { noSizeError = String(error?.code ?? error?.message ?? error) }
  check('a reference without dimensions is refused', /UNSUPPORTED_CONTENT/.test(noSizeError), noSizeError)

  check('assistant image output is refused, not dropped', (() => {
    try {
      buildRequestBody({ model: 'm', messages: [{ role: 'assistant', content: [{ type: 'image', attachment: IMAGE_REF }] }] }, { defaultMaxTokens: 1 })
      return false
    } catch (error) { return error.code === 'UNSUPPORTED_CONTENT' }
  })())

  // ── model metadata on the seam ────────────────────────────────────────────
  const resolved = await plain.adapter.resolveModel('cline-pass', 'cline-pass/deepseek-v4.1-flash')
  check('published context window is advertised, not the route default', resolved.context.contextWindow === 1000000, String(resolved.context.contextWindow))
  check('published output cap is advertised', resolved.defaultMaxTokens === 384000, String(resolved.defaultMaxTokens))
  check('the model name is its display name', resolved.name === 'DeepSeek V4.1 Flash', resolved.name)
  check('reasoning capability is advertised', resolved.reasoning !== undefined && resolved.reasoning.efforts.length > 0)
  const effortIds = resolved.reasoning.efforts.map((effort) => effort.id)
  check('every gateway-accepted effort is offered', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].every((id) => effortIds.includes(id)), effortIds.join(','))
  check('"off" is never offered — the gateway rejects it with HTTP 400', !effortIds.includes('off'), effortIds.join(','))
  check('no effort is forced when the caller omits one', resolved.reasoning.defaultEffort === undefined, String(resolved.reasoning.defaultEffort))
  const unknown = await plain.adapter.resolveModel('cline-pass', 'cline-pass/not-in-catalog')
  check('an unknown model falls back to the route-wide window', unknown.context.contextWindow === 128000, String(unknown.context.contextWindow))
  check('an unknown model still advertises the effort list', unknown.reasoning?.efforts.length === 7, String(unknown.reasoning?.efforts.length))
  // The config schema defaults an absent `input` to [], which must read as
  // "not set" — otherwise every model would advertise zero modalities.
  check('published modalities survive an empty config default', JSON.stringify(resolved.inputModalities) === JSON.stringify(['text', 'image']), JSON.stringify(resolved.inputModalities))
  check('an unknown model still advertises text', JSON.stringify(unknown.inputModalities) === JSON.stringify(['text']), JSON.stringify(unknown.inputModalities))

  // The seam validates every descriptor an adapter returns; a rejected one
  // would surface as INVALID_MODEL_INFO / INVALID_MODEL_REASONING at runtime.
  const seenEfforts = new Set()
  let metadataValid = true
  for (const id of Object.keys(PIPELINES)) {
    for (const model of [id, 'cline-pass/deepseek-v4.1-flash']) {
      const info = await plain.adapter.resolveModel('cline-pass', model)
      const okShape = info.provider === 'cline-pass' && info.id === model && typeof info.name === 'string' && info.name.length > 0
      // Uniqueness is required within one descriptor, so the set resets per model.
      seenEfforts.clear()
      const okEfforts = info.reasoning === undefined || (info.reasoning.efforts.length > 0 && info.reasoning.efforts.every((effort) => {
        const unique = !seenEfforts.has(effort.id)
        seenEfforts.add(effort.id)
        return typeof effort.id === 'string' && effort.id.length > 0 && typeof effort.name === 'string' && effort.name.length > 0 && unique
      }))
      if (!okShape || !okEfforts || !Number.isInteger(info.context.contextWindow) || info.context.contextWindow <= 0) metadataValid = false
    }
  }
  check('every descriptor satisfies the seam metadata contract', metadataValid)

  // ── the published catalog is internally consistent ────────────────────────
  // A single bad entry would make one model unusable, so every entry is run
  // through the same resolver the adapter uses, with the config schema's own
  // empty-value defaults standing in for "not configured".
  const emptyOverride = { name: '', contextWindow: 0, maxTokens: 0, input: [], reasoning: undefined }
  const fallback = { contextWindow: 128000, maxTokens: 32000, reasoning: true }
  const catalogProblems = []
  for (const id of Object.keys(MODEL_CATALOG)) {
    const entry = resolveModelMetadata('cline-pass', id, emptyOverride, fallback)
    if (entry.provider !== 'cline-pass' || entry.id !== id) catalogProblems.push(`${id}: identity`)
    if (!Number.isInteger(entry.context.contextWindow) || entry.context.contextWindow <= 0) catalogProblems.push(`${id}: context`)
    if (!Number.isSafeInteger(entry.defaultMaxTokens) || entry.defaultMaxTokens <= 0) catalogProblems.push(`${id}: maxTokens`)
    if (entry.name.length === 0) catalogProblems.push(`${id}: name`)
    // The seam only knows text and image; a catalog listing more (models.dev
    // reports audio for mimo-v2.5) must be clamped, not passed through.
    if (!entry.inputModalities.every((modality) => modality === 'text' || modality === 'image')) catalogProblems.push(`${id}: modality ${entry.inputModalities.join('+')}`)
    if (entry.inputModalities.length === 0) catalogProblems.push(`${id}: no modality`)
    const expectedEfforts = MODEL_CATALOG[id].reasoning === true
    if (expectedEfforts && entry.reasoning?.efforts.length !== 7) catalogProblems.push(`${id}: efforts`)
    if (!expectedEfforts && entry.reasoning !== undefined) catalogProblems.push(`${id}: unexpected efforts`)
  }
  check(`all ${Object.keys(MODEL_CATALOG).length} catalog entries resolve to valid seam metadata`, catalogProblems.length === 0, catalogProblems.join(', '))
  check('the effort list matches the gateway vocabulary exactly', REASONING_EFFORTS.map((effort) => effort.id).join(',') === 'none,minimal,low,medium,high,xhigh,max', REASONING_EFFORTS.map((effort) => effort.id).join(','))
  check('an explicit per-model effort override hides the picker', resolveModelMetadata('cline-pass', 'cline-pass/deepseek-v4.1-flash', { reasoning: false }, fallback).reasoning === undefined)

  // ── reasoning effort reaches the wire ─────────────────────────────────────
  stub.requests.length = 0
  await collect(plain.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    reasoningEffort: 'max',
  })
  check('the selected reasoning effort is sent as reasoning_effort', stub.requests.at(-1)?.reasoning_effort === 'max', String(stub.requests.at(-1)?.reasoning_effort))
  stub.requests.length = 0
  await collect(plain.adapter, {
    provider: 'cline-pass',
    model: 'cline-pass/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  check('an omitted effort sends no reasoning_effort field', stub.requests.at(-1)?.reasoning_effort === undefined, String(stub.requests.at(-1)?.reasoning_effort))

  let rejected = false
  try {
    await tools.get('cline_pass_pin').execute({}, { signal: new AbortController().signal })
  } catch (error) {
    rejected = error?.name === 'ToolArgsError'
  }
  check('missing required arguments are rejected before execution', rejected)

  // ── the browser setup panel ───────────────────────────────────────────────
  // The panel and the tools share one control surface, so these drive the same
  // live config the tool checks above just exercised.
  const panel = createPanel({ control: panelControl, engine: panelEngine, store })

  // A fresh install has no `accounts` entry at all: the single account is the
  // top-level key and its `apiKeyEnv`. There is nothing to delete, so the panel
  // must say so rather than offering a button that cannot work.
  {
    const saved = section.accounts
    section = { ...section, accounts: {} }
    const fresh = createPanel({ control: panelControl, engine: panelEngine, store })
    const freshState = await fresh.state({})
    check('an implicit account is reported as undeclared', freshState.accounts.length === 1 && freshState.accounts[0].declared === false, JSON.stringify(freshState.accounts.map((account) => [account.key, account.declared])))
    section = { ...section, accounts: saved }
  }

  const panelState = await panel.state({})
  check('panel state exposes the route and the masked account', panelState.provider === 'cline-pass' && panelState.accounts[0].keyHint === 'sk_liv…3456', JSON.stringify(panelState.accounts))
  check('panel state reports readiness from the stored key', panelState.ready === true)
  check('panel state reports the model list', panelState.models.length === 2, String(panelState.models.length))
  check('panel state never echoes a key', !JSON.stringify(panelState).includes('sk_live_test_key_123456'))

  const panelTested = await panel['key.test']({ value: 'sk_typed_key_abcdef123' })
  check('key.test verifies a typed key without storing it', panelTested.ok === true && credentials.get('CLINE_PASS_TYPED') === undefined, JSON.stringify(panelTested))
  const panelBad = await panel['key.test']({ value: 'sk_wrong' })
  check('a key is checked against the gateway, not assumed', typeof panelBad.ok === 'boolean', JSON.stringify(panelBad))

  const panelPrimary = panelState.accounts[0].apiKeyEnv
  await panel['key.set']({ ref: panelPrimary, value: 'sk_replaced_key_000000' })
  check('key.set stores the literal in the credential store', credentials.get(panelPrimary) === 'sk_replaced_key_000000', String(credentials.get(panelPrimary)))

  // `declared` is what the delete button is gated on, and it has to be true for
  // every account the pool materialized: gating on the pool size instead left
  // the button dead for the common single-account case.
  check('a materialized account reports itself as removable', panelState.accounts.length === 1 && panelState.accounts[0].declared === true, JSON.stringify(panelState.accounts.map((account) => [account.key, account.declared])))
  const panelAdded = await panel['account.add']({ name: 'panel', key: 'sk_panel_account_1111' })
  check('account.add registers the account and stores its key', panelAdded.accounts.some((account) => account.key === 'panel') && credentials.get('CLINE_PASS_PANEL_KEY') === 'sk_panel_account_1111')
  check('every account written into the pool is removable', panelAdded.accounts.every((account) => account.declared === true), JSON.stringify(panelAdded.accounts.map((account) => [account.key, account.declared])))
  const panelMode = await panel['account.mode']({ mode: 'roundrobin' })
  check('account.mode switches the pool', panelMode.accountMode === 'roundrobin' && section.accountMode === 'roundrobin')
  const panelRemoved = await panel['account.remove']({ name: 'panel' })
  check('account.remove drops the account', panelRemoved.accounts.every((account) => account.key !== 'panel'))
  await panel['account.mode']({ mode: 'single' })

  const panelPinned = await panel['model.pin']({ model: 'cline-pass/glm-5.2', upstreams: ['alibaba', 'baseten'], pinMode: 'preferred', sort: 'ttft' })
  check('model.pin persists the pin', same(section.perModel['cline-pass/glm-5.2'], { upstreams: ['alibaba', 'baseten'], exclude: [], pinMode: 'preferred', sort: 'ttft' }), JSON.stringify(section.perModel))
  const panelRepinned = await panel['model.pin']({ model: 'cline-pass/glm-5.2', exclude: ['baseten'] })
  check('model.pin keeps the fields it was not given', same(panelRepinned.pin.upstreams, ['alibaba', 'baseten']) && same(panelRepinned.pin.exclude, ['baseten']), JSON.stringify(panelRepinned.pin))

  const panelProbe = await panel['model.probe']({ model: 'cline-pass/glm-5.2' })
  check('model.probe reports the pipeline and channels', panelProbe.result.ok === true && panelProbe.result.pipeline === 'planner' && panelProbe.result.upstreams.length === 2, JSON.stringify(panelProbe.result.upstreams))
  const panelValidated = await panel['model.validate']({ model: 'cline-pass/glm-5.2' })
  check('model.validate reports a verdict per channel', panelValidated.results.length === 2 && panelValidated.summary.ok === 2, JSON.stringify(panelValidated.summary))
  const panelTest = await panel['model.test']({ model: 'cline-pass/glm-5.2', upstreams: ['alibaba'] })
  check('model.test reports what actually served the call', panelTest.ok === true && panelTest.actual === 'alibaba', JSON.stringify(panelTest))

  const panelReset = await panel['model.reset']({ model: 'cline-pass/glm-5.2' })
  check('model.reset returns the model to automatic routing', panelReset.pin.upstreams.length === 0 && panelReset.pin.exclude.length === 0, JSON.stringify(panelReset.pin))

  const panelRefreshed = await panel['models.refresh']({})
  check('models.refresh reports the official catalog scan', Array.isArray(panelRefreshed.added) && panelRefreshed.models.length === 2, JSON.stringify(panelRefreshed.added))
  const panelHistory = await panel.history({ limit: 3 })
  check('history returns the most recent rows only', panelHistory.entries.length <= 3 && panelHistory.total > 0, JSON.stringify(panelHistory.total))
  check('history rows carry the model and latency', panelHistory.entries.every((entry) => entry.model !== '' && Number.isSafeInteger(entry.ms)))
  // The panel projects the same rows the tool returns, both timing marks
  // included; the two lists must not disagree about what a request cost.
  check('the panel history carries the first-chunk time too', panelHistory.entries.every((entry) => Number.isSafeInteger(entry.ttft) && entry.ttft >= 0), JSON.stringify(panelHistory.entries.map((entry) => entry.ttft)))
  check('the panel history carries the first-byte time too', panelHistory.entries.every((entry) => Number.isSafeInteger(entry.ttfb) && entry.ttfb >= 0), JSON.stringify(panelHistory.entries.map((entry) => entry.ttfb)))
  // The token counts and the "was usage reported" flag have to survive the
  // projection too, or the panel renders a dash for a call that reported usage.
  check('the panel history carries the token counts too', panelHistory.entries.every((entry) => typeof entry.usageReported === 'boolean' && Number.isSafeInteger(entry.usage?.inputTokens ?? NaN)), JSON.stringify(panelHistory.entries.map((entry) => entry.usage)))
  check('the panel history carries the reasoning effort too', panelHistory.entries.every((entry) => typeof entry.effort === 'string'))
  check('a panel row never reports a later first chunk than its total', panelHistory.entries.every((entry) => entry.ttft === 0 || entry.ttft <= entry.ms))

  let panelRejected = ''
  try {
    await panel['model.pin']({})
  } catch (error) {
    panelRejected = String(error.message)
  }
  check('a panel action without its model fails loudly', /needs a `model`/.test(panelRejected), panelRejected)

  // ── the route the panel publishes ─────────────────────────────────────────
  // It must be an exact Fetch route under `/api`: that prefix belongs to
  // Connection, whose handler is the only thing applying the trust fence and
  // browser authentication. A route on the bare webserver would be unguarded.
  const fetchRoutes = new Map()
  const rpcCtx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return this[name] },
    connection: {
      fetch: {
        register(route) {
          fetchRoutes.set(route.path, route)
          return () => fetchRoutes.delete(route.path)
        },
      },
    },
    inject(names, callback) {
      if (names.includes('connection')) callback(this)
      return () => {}
    },
  }
  registerPanel(rpcCtx, { control: panelControl, engine: panelEngine, store, logger: rpcCtx.logger })
  check('the panel registers exactly one route', fetchRoutes.size === 1, [...fetchRoutes.keys()].join(','))
  const route = fetchRoutes.get(PANEL_PATH)
  check('the route is the documented path', route !== undefined && PANEL_PATH === '/api/cline-pass', PANEL_PATH)
  check('the route lives inside the authenticated /api prefix', PANEL_PATH.startsWith('/api/'), PANEL_PATH)
  check('the route accepts only POST', JSON.stringify(route?.methods) === JSON.stringify(['POST']), JSON.stringify(route?.methods))
  check('the route buffers its JSON body', route?.requestBody === 'buffered', String(route?.requestBody))

  /** POST one action the way the browser does, through the registered route. */
  const post = async (endpoint, payload) => {
    const request = new Request(`http://localhost${PANEL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    })
    const response = await route.fetch(request)
    return { status: response.status, json: await response.json() }
  }

  const rpcOk = await post('state', {})
  check('a known action answers 200 with ok/value', rpcOk.status === 200 && rpcOk.json.ok === true && rpcOk.json.value.provider === 'cline-pass', JSON.stringify(rpcOk.json).slice(0, 120))
  const rpcUnknown = await post('nope', {})
  check('an unknown action is a typed failure, not a throw', rpcUnknown.json.ok === false && rpcUnknown.json.error.code === PANEL_ERROR_CODE, JSON.stringify(rpcUnknown))
  const rpcBadArgs = await post('model.pin', {})
  check('a rejected action becomes a typed failure', rpcBadArgs.json.ok === false && /needs a `model`/.test(rpcBadArgs.json.error.message), JSON.stringify(rpcBadArgs))
  check('a failure carries no Host object', rpcBadArgs.json.error.details !== undefined && JSON.stringify(rpcBadArgs.json.error.details) === '{}', JSON.stringify(rpcBadArgs.json.error.details))
  const malformed = await route.fetch(new Request(`http://localhost${PANEL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }))
  check('a malformed body is a 400, not a crash', malformed.status === 400, String(malformed.status))

  // ── request image preparation & tool-result images ──────────────────────
  let targetReceived = null
  const dummyRef = { attachmentId: 'att-smoke-1', mediaType: 'image/png', bytes: 100, width: 1080, height: 2400 }
  const mockAttachments = {
    readImageRequest: async (ref, target) => {
      targetReceived = target
      return { attachment: ref, variantId: 'v1', mediaType: 'image/png', bytes: 20, data: Uint8Array.of(1, 2) }
    },
  }
  const imgMessages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: dummyRef }] },
  ]
  const prepared = await prepareRequestImages(imgMessages, mockAttachments, DEFAULT_REQUEST_IMAGE_POLICY)
  check('prepareRequestImages projects positive integer width', Number.isSafeInteger(targetReceived?.width) && targetReceived.width > 0, String(targetReceived?.width))
  check('prepareRequestImages projects positive integer height', Number.isSafeInteger(targetReceived?.height) && targetReceived.height > 0, String(targetReceived?.height))
  check('prepareRequestImages includes positive integer maxBytes', Number.isSafeInteger(targetReceived?.maxBytes) && targetReceived.maxBytes > 0, String(targetReceived?.maxBytes))

  const toolMessages = [
    { role: 'user', content: [{ type: 'text', text: 'run' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read_image', arguments: '{}' }] },
    {
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'read ok' }, { type: 'image', attachment: dummyRef }],
      }],
    },
  ]
  const toolPrepared = await prepareRequestImages(toolMessages, mockAttachments, DEFAULT_REQUEST_IMAGE_POLICY)
  const toolBody = buildRequestBody({ model: 'cline-pass/deepseek-v4.1-flash', messages: toolMessages }, {}, toolPrepared)
  const toolWire = toolBody.messages
  const toolIndex = toolWire.findIndex(m => m.role === 'tool')
  const imgUserIndex = toolWire.findIndex(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'))
  check('tool message is emitted', toolIndex !== -1, JSON.stringify(toolWire))
  check('tool-result image rides a following user message', imgUserIndex > toolIndex, `tool=${toolIndex} imgUser=${imgUserIndex}`)
  check('tool-result image has data URI url', toolWire[imgUserIndex]?.content?.some(p => p.type === 'image_url' && p.image_url?.url?.startsWith('data:image/png;base64,')), JSON.stringify(toolWire[imgUserIndex]))
} catch (error) {
  failures.push(`unexpected failure — ${error?.stack ?? error}`)
}

gateway.close()

if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} check(s) failed, ${passed} passed:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✔ all ${passed} checks passed`)
