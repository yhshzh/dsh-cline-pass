/**
 * Pin-adherence checks: the protocol behavior that stops a pin from silently
 * evaporating.
 *
 * The bug these cover: the plugin injected only the spelling belonging to the
 * pipeline its last probe observed, and treated any HTTP 200 as proof the pin
 * was applied. A gateway that drops the field therefore served the request from
 * an arbitrary channel while the plugin reported success — and, worse, recorded
 * the pinned channel as verified-available, which then fed the exclusion
 * allow-list and hid the leak.
 *
 * Pure functions only: this file imports `lib/protocol.js` and nothing else.
 */
import {
  BUILD_TAG,
  buildAttempts,
  injectPrefs,
  isAdherenceOk,
  normalizePinMode,
  pinAdherence,
  pinWarnings,
} from '../lib/protocol.js'

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) passed += 1
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

// ── build identity ───────────────────────────────────────────────────────────

check('the build carries an identity tag', typeof BUILD_TAG === 'string' && BUILD_TAG.length > 0, BUILD_TAG)

// ── both spellings, always ───────────────────────────────────────────────────

const plannerBody = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: ['alibaba', 'baseten'] }, { upstream: 'baseten', strict: true, sort: null })
check('a planner model still gets gateway.only', same(plannerBody.providerOptions?.gateway?.only, ['baseten']), JSON.stringify(plannerBody))
check('a planner model ALSO gets the top-level spelling', same(plannerBody.provider?.only, ['baseten']), JSON.stringify(plannerBody))

const directBody = injectPrefs({ model: 'm' }, { pipeline: 'direct', upstreams: ['gmicloud'] }, { upstream: 'gmicloud', strict: true, sort: null })
check('a direct model still gets provider.only', same(directBody.provider?.only, ['gmicloud']), JSON.stringify(directBody))
check('a direct model ALSO gets the gateway spelling', same(directBody.providerOptions?.gateway?.only, ['gmicloud']), JSON.stringify(directBody))

const detectedPlanner = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: ['a'] }, { upstream: 'a', strict: true, spelling: 'detected' })
check("spelling 'detected' restores the single-spelling behavior", detectedPlanner.provider === undefined && same(detectedPlanner.providerOptions.gateway.only, ['a']), JSON.stringify(detectedPlanner))

const detectedDirect = injectPrefs({ model: 'm' }, { pipeline: 'direct', upstreams: ['a'] }, { upstream: 'a', strict: true, spelling: 'detected' })
check("spelling 'detected' emits nothing for the other pipeline", detectedDirect.providerOptions === undefined && same(detectedDirect.provider.only, ['a']), JSON.stringify(detectedDirect))

check('a body with no pin and no exclusion is still left untouched', same(injectPrefs({ model: 'm' }, {}, {}), { model: 'm' }))

// ── per-pipeline channel lists ───────────────────────────────────────────────

// The two pipelines publish different channel lists, and only the pipeline that
// serves the request can be allow-listed against its own vocabulary.
const split = { pipeline: 'planner', upstreams: ['a', 'b', 'z'], channels: { planner: ['a', 'b'], direct: ['a', 'z'] } }
const splitBody = injectPrefs({ model: 'm' }, split, { upstream: null, excludeList: ['b'], strict: true })
check('the gateway allow-list uses the planner channel list', same(splitBody.providerOptions.gateway.only, ['a']), JSON.stringify(splitBody))
check('the top-level allow-list uses the direct channel list', same(splitBody.provider.only, ['a', 'z']), JSON.stringify(splitBody))
check('the exclusion is also sent as OpenRouter ignore', same(splitBody.provider.ignore, ['b']), JSON.stringify(splitBody))

const noChannels = injectPrefs({ model: 'm' }, { pipeline: 'planner', upstreams: [] }, { upstream: null, excludeList: ['b'], strict: true })
check('an exclusion with no channel list still emits provider.ignore', same(noChannels.provider?.ignore, ['b']), JSON.stringify(noChannels))

// ── pin mode normalization ───────────────────────────────────────────────────

check('normalizePinMode accepts the documented values', normalizePinMode('strict') === 'strict' && normalizePinMode('preferred') === 'preferred')
check('normalizePinMode forgives case and padding', normalizePinMode(' Preferred ') === 'preferred' && normalizePinMode('STRICT') === 'strict')
check('normalizePinMode defaults to strict', normalizePinMode(undefined) === 'strict' && normalizePinMode('') === 'strict' && normalizePinMode('nonsense') === 'strict')
check('a padded strict behaves as strict', buildAttempts({ upstreams: ['a', 'b'], pinMode: 'strict ' })[0].strict === true)
check('a padded preferred behaves as preferred', buildAttempts({ upstreams: ['a', 'b'], pinMode: ' preferred ' })[0].strict === false)

check('a bare pin profile keeps the historical attempt shape', same(buildAttempts({ upstreams: [], exclude: ['a'] }), [{ strict: true, sort: null, excludeList: ['a'], upstream: null, orderRest: [] }]))
check('a configured spelling rides along on the attempt', buildAttempts({ upstreams: ['a'], spelling: 'both' })[0].spelling === 'both')

// ── adherence ────────────────────────────────────────────────────────────────

const routing = (finalProvider) => ({ finalProvider })

check('the reported channel matching the pin is adopted', pinAdherence({ upstream: 'baseten' }, routing('baseten')) === 'adopted')
check('a different reported channel is not adopted', pinAdherence({ upstream: 'baseten' }, routing('deepseek')) === 'not-adopted')
check('hyphenation differences do not fake a mismatch', pinAdherence({ upstream: 'together-ai' }, routing('Together AI')) === 'adopted')
check('a channel in the fallback order is a legitimate fallback', pinAdherence({ upstream: 'a', orderRest: ['b'] }, routing('b')) === 'fallback')
check('an excluded channel serving the request is a violation', pinAdherence({ upstream: 'a', excludeList: ['deepseek'] }, routing('deepseek')) === 'violated')
check('a violation is caught even under automatic routing', pinAdherence({ upstream: null, excludeList: ['deepseek'] }, routing('deepseek')) === 'violated')
check('a violation is caught under a preferred pin that fell through', pinAdherence({ upstream: 'a', orderRest: ['b'], excludeList: ['deepseek'] }, routing('deepseek')) === 'violated')
check('the pinned channel is never its own violation', pinAdherence({ upstream: 'a', excludeList: ['a'] }, routing('a')) === 'adopted')
check('an unreported channel cannot be judged', pinAdherence({ upstream: 'baseten' }, routing(null)) === 'unresolved')
check('automatic routing cannot be judged', pinAdherence({ upstream: null }, routing('anything')) === 'unresolved')
check('adherence ok covers adopted, fallback and unresolved', isAdherenceOk('adopted') && isAdherenceOk('fallback') && isAdherenceOk('unresolved'))
check('adherence ok rejects a breach and a mismatch', !isAdherenceOk('violated') && !isAdherenceOk('not-adopted'))

// ── configuration warnings ───────────────────────────────────────────────────

check('a pin with no exclusion needs no warning', same(pinWarnings({ upstream: 'a' }, { upstreams: ['a', 'b'] }), []))
check('an exclusion with no channel list is reported', /excludeUnresolved/.test(pinWarnings({ upstream: null, excludeList: ['b'] }, { upstreams: [] })[0] ?? ''))
check('excluding every known channel is reported', /PIN_UNRESOLVED/.test(pinWarnings({ upstream: null, excludeList: ['a', 'b'] }, { upstreams: ['a', 'b'] })[0] ?? ''))
check('excluding some known channels is fine', same(pinWarnings({ upstream: null, excludeList: ['b'] }, { upstreams: ['a', 'b'] }), []))
check('excluding the pinned channel is not a warning', same(pinWarnings({ upstream: 'a', excludeList: ['a'] }, { upstreams: ['a'] }), []))

if (failures.length > 0) {
  console.log(`✘ ${failures.length} of ${passed + failures.length} checks failed:`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`✔ all ${passed} checks passed`)
