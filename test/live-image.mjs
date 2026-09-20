/**
 * Live check that Cline Pass vision works on a real image.
 *
 * The unit suite proves the adapter emits the right wire shape; only a real
 * call proves the gateway and the model actually LOOK at it. This builds a
 * synthetic image whose content is unambiguous (a red circle on white), sends
 * it in exactly the request form `buildRequestBody` produces, and fails if the
 * reply does not name both the shape and the colour.
 *
 * It also runs a text-only control through the same model, so a reply that
 * merely hallucinates "I see an image" cannot pass.
 *
 * Costs one tiny request per case. Run with: node test/live-image.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const MODEL = process.env.CLINE_PASS_IMAGE_MODEL ?? 'cline-pass/deepseek-v4.1-flash'
const BASE = process.env.CLINE_PASS_BASE_URL ?? 'https://api.cline.bot/api/v1'

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

// ── a real PNG, encoded here so the fixture is not an opaque blob ───────────

/** Standard PNG CRC-32. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** One length-prefixed, CRC-suffixed PNG chunk. */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/** Encode a 24-bit RGB PNG from a pixel function. */
function encodePNG(width, height, pixel) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      offset += 3
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const SIZE = 96
const RADIUS = 34
const image = encodePNG(SIZE, SIZE, (x, y) => {
  const dx = x - SIZE / 2 + 0.5
  const dy = y - SIZE / 2 + 0.5
  return dx * dx + dy * dy <= RADIUS * RADIUS ? [220, 20, 20] : [255, 255, 255]
})
const dataUri = `data:image/png;base64,${image.toString('base64')}`

// ── one real call ───────────────────────────────────────────────────────────

/** Send one chat request and return the assistant text. */
async function ask(key, content) {
  const started = Date.now()
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://github.com/zheng/dsh-cline-pass',
      'X-Title': 'dsh-cline-pass live vision check',
    },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: 2048 }),
  })
  const text = await response.text()
  if (!response.ok) return { status: response.status, ms: Date.now() - started, error: text.slice(0, 300) }
  let json
  try { json = JSON.parse(text) } catch { return { status: response.status, ms: Date.now() - started, error: `unparsable body: ${text.slice(0, 200)}` } }
  const payload = json?.data?.choices === undefined ? json : json.data
  return {
    status: response.status,
    ms: Date.now() - started,
    content: String(payload?.choices?.[0]?.message?.content ?? ''),
    error: payload?.error === undefined ? '' : JSON.stringify(payload.error).slice(0, 300),
  }
}

const key = apiKey()
console.log(`model: ${MODEL}`)
console.log(`image: ${SIZE}×${SIZE} PNG, red circle on white, ${image.length} bytes\n`)

// The control proves the model is not simply answering from the prompt: the
// same question with no image must NOT describe a red circle.
const control = await ask(key, 'What shape is in this image, and what colour is it? Answer in at most four words.')
check('the text-only control call succeeded', control.error === '' && control.status === 200, `${control.status} ${control.error}`)
console.log(`control (no image): ${JSON.stringify(control.content)}`)
const controlClaimsVision = /red/i.test(control.content) && /circle|ball|dot|round/i.test(control.content)
check('without an image the model does not describe one', !controlClaimsVision, control.content)

const vision = await ask(key, [
  { type: 'text', text: 'What shape is in this image, and what colour is it? Answer in at most four words.' },
  { type: 'image_url', image_url: { url: dataUri } },
])
check('the vision call succeeded', vision.error === '' && vision.status === 200, `${vision.status} ${vision.error}`)
console.log(`vision (with image): ${JSON.stringify(vision.content)}  [${vision.ms}ms]`)

check('the reply names the colour', /red/i.test(vision.content), vision.content)
check('the reply names the shape', /circle|ball|dot|round|disc/i.test(vision.content), vision.content)

// A second, different image guards against a lucky phrasing: a blue square must
// read as blue and square.
const square = encodePNG(SIZE, SIZE, (x, y) => (x > 16 && x < 80 && y > 16 && y < 80 ? [20, 60, 220] : [255, 255, 255]))
const squareCall = await ask(key, [
  { type: 'text', text: 'What shape is in this image, and what colour is it? Answer in at most four words.' },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${square.toString('base64')}` } },
])
console.log(`vision (blue square): ${JSON.stringify(squareCall.content)}  [${squareCall.ms}ms]`)
check('a second image is read independently', /blue/i.test(squareCall.content) && /square|rectangle|box/i.test(squareCall.content), squareCall.content)

if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} check(s) failed, ${passed} passed:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\n✔ all ${passed} live vision checks passed`)
