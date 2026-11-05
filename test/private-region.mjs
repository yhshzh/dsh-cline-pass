import assert from 'node:assert/strict'
import { buildAttempts, injectPrefs } from '../lib/protocol.js'
import { createEngine } from '../lib/engine.js'
import { createStore } from '../lib/store.js'

const region = { scope: 'global', providers: { 'openai-compatible-private': { scope: 'zone', geoRegion: 'us' } } }
const pin = { upstreams: ['deepseek'], pinMode: 'strict', has: ['vision'], privateProviderRegion: 'us' }
const body = { model: 'cline-pass/deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: 'OK' }] }
const injected = injectPrefs(body, {}, buildAttempts(pin)[0])
assert.deepEqual(injected.providerOptions.gateway.inferenceRegion, region)
assert.deepEqual(injected.providerOptions.gateway.only, ['deepseek'])
assert.deepEqual(injected.providerOptions.gateway.has, ['vision'])
assert.equal(body.providerOptions, undefined, 'Do not mutate caller body')
assert.equal(injectPrefs(body, {}, buildAttempts({ upstreams: ['deepseek'] })[0]).providerOptions.gateway.inferenceRegion, undefined)
assert.deepEqual(injectPrefs(body, {}, buildAttempts({ privateProviderRegion: 'eu' })[0]).providerOptions.gateway.inferenceRegion.providers['openai-compatible-private'], { scope: 'zone', geoRegion: 'eu' })
assert.equal(injectPrefs(body, {}, buildAttempts({ privateProviderRegion: 'invalid' })[0]).providerOptions, undefined)

const previousFetch = globalThis.fetch
const requests = []
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body)
  requests.push(request)
  const gateway = request.providerOptions?.gateway
  if (gateway?.only?.[0] === '__probe__') return Response.json({ error: { message: 'Available providers are: deepseek, fireworks.' } }, { status: 400 })
  if (request.provider?.only?.[0] === '__probe__') return Response.json({ error: { message: 'unavailable' } }, { status: 400 })
  return Response.json({ choices: [{ message: { content: 'OK', provider_metadata: { gateway: { routing: { finalProvider: 'deepseek' } } } } }] })
}
try {
  const engine = createEngine({ resolveAccount: async () => ({ name: 'test', key: 'synthetic', baseURL: 'https://test.invalid' }), store: createStore() })
  engine.setPinReader(() => pin)
  const probed = await engine.probe(body.model)
  assert.deepEqual(probed.upstreams, ['deepseek', 'fireworks'])
  assert.equal(requests[0].providerOptions.gateway.only, undefined, 'Probe must discover beyond saved pin')
  assert.deepEqual(requests[0].providerOptions.gateway.inferenceRegion, region)
  assert.deepEqual(requests[1].providerOptions.gateway.inferenceRegion, region, 'Harvest must preserve region')
  requests.length = 0
  await engine.validate(body.model)
  assert.equal(requests.length, 2)
  for (const request of requests) assert.deepEqual(request.providerOptions.gateway.inferenceRegion, region)
  requests.length = 0
  assert.equal((await engine.test(body.model)).adopted, true)
  assert.deepEqual(requests[0].providerOptions.gateway.inferenceRegion, region)
} finally { globalThis.fetch = previousFetch }
console.log('Private provider region: protocol, probe, harvest, validate and test passed')
