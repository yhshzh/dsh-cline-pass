/**
 * Live check that the gateway accepts every effort the plugin advertises.
 *
 * The plugin's whole point is that the picker's options are the gateway's
 * options; an offered value the gateway rejects with HTTP 400 is worse than
 * offering nothing. This asks the real gateway for each effort in
 * REASONING_EFFORTS and reports the HTTP status plus reasoning-token count,
 * which also shows the levels actually differ in behaviour.
 *
 * Costs one tiny request per effort. Run with: node test/live-efforts.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REASONING_EFFORTS } from '../lib/catalog.js'

const MODEL = 'cline-pass/deepseek-v4.1-flash'
const BASE = 'https://api.cline.bot/api/v1'

/** Resolve the key the same way the plugin does: env first, then credentials. */
function apiKey() {
  if (process.env.CLINE_PASS_API_KEY) return process.env.CLINE_PASS_API_KEY
  const text = readFileSync(join(process.env.HOME, '.dsh', '.credentials.yaml'), 'utf8')
  const match = text.match(/^\s*CLINE_PASS_API_KEY:\s*(\S+)\s*$/m)
  if (!match) throw new Error('no CLINE_PASS_API_KEY in env or credentials')
  return match[1].replace(/^["']|["']$/g, '')
}

/** One streaming call; returns status, reasoning tokens and completion tokens. */
async function ask(key, effort) {
  const started = Date.now()
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://github.com/zheng/dsh-cline-pass',
      'X-Title': 'dsh-cline-pass live effort check',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 2048,
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
      providerOptions: { gateway: { order: ['deepseek'] } },
    }),
  })
  if (!response.ok) {
    const body = await response.text()
    return { status: response.status, ms: Date.now() - started, error: body.slice(0, 200) }
  }
  const text = await response.text()
  let reasoning = 0
  let completion = 0
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
    let frame
    try {
      frame = JSON.parse(line.slice(6))
    } catch {
      continue
    }
    const usage = frame.usage
    if (usage) {
      reasoning = usage.completion_tokens_details?.reasoning_tokens ?? reasoning
      completion = usage.completion_tokens ?? completion
    }
  }
  return { status: response.status, ms: Date.now() - started, reasoning, completion }
}

const key = apiKey()
console.log(`live effort check — ${MODEL} (key ${key.slice(0, 5)}…${key.slice(-4)})\n`)

let failures = 0
// The omitted case must also be exercised: it proves the plugin's "no default"
// behaviour leaves the request valid instead of sending an empty field.
for (const effort of [undefined, ...REASONING_EFFORTS.map((entry) => entry.id)]) {
  const label = effort === undefined ? '(omitted)' : effort
  try {
    const result = await ask(key, effort)
    if (result.error !== undefined) {
      failures += 1
      console.log(`  ✘ ${label.padEnd(9)} HTTP ${result.status}  ${result.error}`)
    } else {
      console.log(`  ✔ ${label.padEnd(9)} HTTP ${result.status}  ${String(result.ms).padStart(5)} ms  reasoning=${String(result.reasoning).padStart(3)}  completion=${result.completion}`)
    }
  } catch (error) {
    failures += 1
    console.log(`  ✘ ${label.padEnd(9)} threw ${error.message}`)
  }
}

console.log(failures === 0 ? `\n✔ the gateway accepted every advertised effort` : `\n✘ ${failures} effort(s) failed`)
process.exit(failures === 0 ? 0 : 1)
