/**
 * Live check that thinking survives the REAL wire.
 *
 * The stub suite cannot catch a wire-shape mistake by construction: a stub that
 * speaks the field the adapter happens to read will always agree with it. This
 * test therefore reads what the gateway actually streams for
 * `cline-pass/deepseek-v4.1-flash`, feeds those exact bytes through the real
 * adapter (via a local replay server), and asserts the harness receives
 * reasoning chunks.
 *
 * It asserts on the observed wire, not on an assumption: if the gateway started
 * spelling its thinking differently, the "the gateway streams a field the
 * adapter reads" check fails first and names the field.
 *
 * Costs one real request. Run with: node test/live-reasoning.mjs
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClinePassAdapter, reasoningOf } from '../lib/adapter.js'
import { createStore } from '../lib/store.js'

const MODEL = 'cline-pass/deepseek-v4.1-flash'
const BASE = 'https://api.cline.bot/api/v1'

let passed = 0
const failures = []
function check(label, condition, detail = '') {
  if (condition) passed += 1
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Resolve the key the same way the plugin does: env first, then credentials. */
function apiKey() {
  if (process.env.CLINE_PASS_API_KEY) return process.env.CLINE_PASS_API_KEY
  const text = readFileSync(join(process.env.HOME, '.dsh', '.credentials.yaml'), 'utf8')
  const match = text.match(/^\s*CLINE_PASS_API_KEY:\s*(\S+)\s*$/m)
  if (!match) throw new Error('no CLINE_PASS_API_KEY in env or credentials')
  return match[1].replace(/^["']|["']$/g, '')
}

// ── 1. observe the real wire ────────────────────────────────────────────────

const response = await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey()}`,
    'HTTP-Referer': 'https://github.com/zheng/dsh-cline-pass',
    'X-Title': 'dsh-cline-pass live reasoning check',
  },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'What is 17*23? Think it through step by step.' }],
    stream: true,
    max_tokens: 2048,
    reasoning_effort: 'high',
  }),
})

check('the live request succeeded', response.ok, `HTTP ${response.status}`)
const sse = await response.text()
const frames = sse.split('\n').filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
check('the gateway streamed frames', frames.length > 0, String(frames.length))

/** Every delta field name the gateway actually used. */
const deltaFields = new Set()
/** Reasoning text as the gateway sent it, read through the adapter's own reader. */
let wireReasoning = ''
for (const line of frames) {
  let frame
  try { frame = JSON.parse(line.slice(6)) } catch { continue }
  for (const choice of frame?.choices ?? []) {
    const delta = choice?.delta ?? {}
    for (const key of Object.keys(delta)) deltaFields.add(key)
    wireReasoning += reasoningOf(delta) ?? ''
  }
}
console.log(`live delta fields: ${[...deltaFields].join(', ')}`)
console.log(`adapter read ${wireReasoning.length} reasoning char(s) from the live wire\n`)

check('the gateway streams some reasoning field', wireReasoning.length > 0, `fields: ${[...deltaFields].join(', ')}`)
check('the adapter reads the field the gateway actually uses', wireReasoning.length > 0, [...deltaFields].join(','))

// ── 2. replay those exact bytes through the real adapter ────────────────────

const replay = createServer((request, respond) => {
  respond.writeHead(200, { 'Content-Type': 'text/event-stream' })
  respond.write(sse)
  respond.end()
})
await new Promise((resolve) => replay.listen(0, '127.0.0.1', resolve))
const replayed = `http://127.0.0.1:${replay.address().port}/api/v1`

const store = createStore({ historyLimit: 5 })
const adapter = new ClinePassAdapter({
  connection: () => ({
    baseURL: replayed,
    displayName: 'Cline Pass',
    models: [{ id: MODEL, name: MODEL }],
    defaultContextWindow: 1000000,
    maxTokens: 32000,
    reasoningModels: true,
    streamIdleTimeoutMs: 60000,
  }),
  modelMeta: () => ({}),
  pin: () => ({}),
  resolveAccount: async () => ({ name: 'live', key: 'sk_live', baseURL: replayed }),
  discoveredContext: () => undefined,
  record: () => {},
  learnUpstream: () => {},
})

const chunks = []
try {
  for await (const chunk of adapter.stream({
    provider: 'cline-pass',
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 17*23? Think it through step by step.' }] }],
    signal: new AbortController().signal,
  })) chunks.push(chunk)
} catch (error) {
  failures.push(`the replay stream threw — ${error?.message ?? error}`)
} finally {
  replay.close()
}

const reasoningText = chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('')
const answerText = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
const reasoningBlock = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')?.block

console.log(`harness received ${reasoningText.length} reasoning char(s) and ${answerText.length} answer char(s)`)
console.log(`reasoning preview: ${JSON.stringify(reasoningText.slice(0, 90))}`)
console.log(`answer preview:    ${JSON.stringify(answerText.slice(0, 90))}\n`)

check('a reasoning block is opened', chunks.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'reasoning'))
check('the reasoning text reaches the harness', reasoningText.length > 0, String(reasoningText.length))
check('the reasoning text matches the wire byte for byte', reasoningText === wireReasoning, `${reasoningText.length} vs ${wireReasoning.length}`)
check('the reasoning block closes with the same text', reasoningBlock?.text === reasoningText, JSON.stringify(reasoningBlock?.text?.slice(0, 60)))
check('the visible answer still arrives', answerText.length > 0, String(answerText.length))
check('the reasoning block precedes the answer block', chunks.findIndex((chunk) => chunk.type === 'block-start' && chunk.blockType === 'reasoning') < chunks.findIndex((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text'))
check('the stream finishes cleanly', chunks.at(-1)?.type === 'finish', JSON.stringify(chunks.at(-1)))

if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} check(s) failed, ${passed} passed:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✔ all ${passed} live reasoning checks passed — thinking survives the real wire`)
