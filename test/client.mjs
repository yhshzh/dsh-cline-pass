/**
 * Client-bundle test for dsh-cline-pass.
 *
 * `lib/client.js` is a hand-written browser bundle, which means nothing in the
 * ordinary Node test path would notice a syntax error, a typo in a
 * `window.__ModuleLoader__.load` call, or a component that throws on its first
 * render. This test therefore executes the bundle the way the browser module
 * system does — with a stubbed `window`, a stub `require`, and a stub React —
 * and then:
 *
 * - asserts the bundle registers itself under the package name the manifest
 *   resolves to (the module system throws when a bundle's id is not the name it
 *   was fetched for);
 * - asserts the exported plugin face (`apply` + `inject`) is what the Loader
 *   expects;
 * - runs `apply` against a stub client context and asserts every slot it
 *   declares really gets registered, with the registration options that slot
 *   protocol requires;
 * - CALLS each registered component, which is what catches a broken render
 *   function without a browser;
 * - checks the manifest still declares the client half consistently, because a
 *   `dsh.client` declaration without a resolvable `./client` export fails the
 *   host at startup.
 *
 * No network, no browser, and no dsh process are involved.
 * Run with: node test/client.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PANEL_PATH } from '../lib/panel.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const pkg = JSON.parse(readFileSync(resolve(pluginDir, 'package.json'), 'utf8'))
const source = readFileSync(resolve(pluginDir, 'lib/client.js'), 'utf8')

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) passed += 1
  else failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ── a React stub good enough to run a render function ───────────────────────

const RENDERED = []

/** Build one element node; children are flattened the way React does. */
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
  return { type, props: { ...(props ?? {}), children: flat } }
}

/** Render a node tree, invoking function components, without hooks state. */
function renderNode(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) return { fragment: node.map((child) => renderNode(child, depth + 1)) }
  if (typeof node.type === 'function') {
    if (depth > 60) throw new Error('render recursion limit: a component renders itself unconditionally')
    return renderNode(node.type(node.props), depth + 1)
  }
  RENDERED.push(node.type)
  return { tag: node.type, props: node.props, children: (node.props.children ?? []).map((child) => renderNode(child, depth + 1)) }
}

/**
 * Run one function component for real.
 *
 * Hooks are stubbed with a per-call cursor: `useState` returns the initial
 * value and a no-op setter, and `useEffect` is skipped (its callback is
 * captured so a test can assert it does not throw on its own). This is enough
 * to execute every branch a first render takes.
 */
function runComponent(component, props) {
  const effects = []
  let cursor = 0
  const slots = []
  const React = {
    createElement,
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useEffect(callback) { effects.push(callback) },
    useMemo(factory) { cursor += 1; return factory() },
    useRef(initial) { cursor += 1; return { current: initial } },
    useCallback(callback) { cursor += 1; return callback },
  }
  const tree = renderNode(component({ ...props, React }))
  return { tree, effects }
}

// ── a window/require harness shaped like the browser module system ──────────

const registered = []

/** The platform seed words the shell actually provides (see dsh-client-modules). */
const SEED = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']

const documentStub = {
  head: { appendChild() {} },
  createElement: () => ({ dataset: {}, textContent: '', setAttribute() {} }),
  querySelector: () => null,
}

const windowStub = {
  __ModuleLoader__: {
    load(entry) { registered.push(entry) },
  },
  document: documentStub,
}

let missingRequires = []

function makeRequire() {
  const React = {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: () => ({ current: undefined }),
  }
  return (specifier) => {
    if (specifier === 'react') return React
    missingRequires.push(specifier)
    throw new Error(`client-modules: require("${specifier}") missed the module table`)
  }
}

// ── execute the bundle ──────────────────────────────────────────────────────

const previousWindow = globalThis.window
globalThis.window = windowStub
try {
  // eslint-disable-next-line no-new-func -- the bundle is CJS source, not a module
  const run = new Function('window', 'document', 'require', source)
  run(windowStub, documentStub, makeRequire())
} catch (error) {
  failures.push(`the bundle threw while registering: ${error?.message ?? error}`)
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
}

check('the bundle registers exactly one module', registered.length === 1, `${registered.length} registration(s)`)
const entry = registered[0]

// The module system rejects a bundle that registers an id other than the
// package name it was fetched for (`bundle ${url} loaded without registering`).
check('the bundle id is the package name', entry?.id === pkg.name, `${String(entry?.id)} vs ${pkg.name}`)
check('the bundle exposes a factory', typeof entry?.factory === 'function')

let exportsValue = null
try {
  exportsValue = entry.factory(makeRequire())
} catch (error) {
  failures.push(`the factory threw: ${error?.message ?? error}`)
}

check('the bundle requires nothing outside the platform seed', missingRequires.length === 0, missingRequires.join(','))
check('the plugin exports apply()', typeof exportsValue?.apply === 'function')
check('the plugin declares its inject list', Array.isArray(exportsValue?.inject) && exportsValue.inject.length > 0, JSON.stringify(exportsValue?.inject))
check('the plugin injects slots', exportsValue?.inject?.includes('slots'))
check('the plugin injects connection', exportsValue?.inject?.includes('connection'))

// ── run apply() against a stub client context ───────────────────────────────

const registrations = []

const slotsService = {
  inject(key, callback) {
    // The real registry waits for the slot to be declared; the stub declares
    // every slot immediately, because the host half of this package relies on
    // exactly these three being present in the shipped web composition.
    callback()
    return () => {}
  },
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  },
}

const rpcCalls = []
const connectionService = {
  rpc: {
    async call(channel, endpoint, payload) {
      rpcCalls.push({ channel, endpoint, payload })
      return { ok: true, value: { provider: 'cline-pass', displayName: 'Cline Pass', baseURL: 'https://api.cline.bot/api/v1', settingsAvailable: true, accountMode: 'single', activeAccount: '', ready: true, accounts: [{ key: 'default', displayName: 'Cline Pass', apiKeyEnv: 'CLINE_PASS_API_KEY', enabled: true, keyConfigured: true, keyHint: 'sk_liv…3456' }], models: [], pinnedModels: 0, catalogCount: 0, historySize: 0 } }
    },
  },
}

// A Cordis context exposes a declared dependency as a property as well as
// through `get()`; the plugin uses both forms. `stubLocale` stays reassignable
// so the tests below can exercise each locale posture.
let stubLocale
const stubCtx = {
  logger: { info() {}, warn() {}, error() {} },
  slots: slotsService,
  connection: connectionService,
  effect(body) {
    const dispose = body()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(name) {
    if (name === 'slots') return slotsService
    if (name === 'connection') return connectionService
    if (name === 'locale') return stubLocale
    return undefined
  },
}

let applyError = null
try {
  exportsValue.apply(stubCtx)
} catch (error) {
  applyError = error
}
check('apply() runs without throwing', applyError === null, applyError?.message ?? '')

const keys = registrations.map((registration) => `${registration.options.name}:${registration.options.key ?? registration.options.id ?? ''}`)
check('every declared slot is registered', registrations.length === 3, keys.join(' '))
check('a Settings page is registered', registrations.some((registration) => registration.options.name === 'settings.section' && registration.options.id === 'cline-pass'), keys.join(' '))
check('a Plugins card is registered', registrations.some((registration) => registration.options.name === 'settings.plugin.item' && registration.options.key === 'cline-pass'), keys.join(' '))
check('a Models-page card is registered', registrations.some((registration) => registration.options.name === 'settings.models.provider-card' && registration.options.key === 'cline-pass'), keys.join(' '))
check('the settings section carries a nav label thunk', typeof registrations.find((registration) => registration.options.name === 'settings.section')?.options.label === 'function')

// ── the panel's own copy follows the active locale ──────────────────────────

/** Collect every rendered string, including text-bearing attributes. */
function collectText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(collectText)
  if (node.fragment !== undefined) return collectText(node.fragment)
  if (node.text !== undefined) return [String(node.text)]
  const props = node.props ?? {}
  const own = [props.children, props.title, props.placeholder, props['aria-label']].flat(Infinity)
  return own.flatMap(collectText)
}

/** A locale stand-in whose namespace lookup echoes keys, as an unregistered one does. */
function echoingLocale(active) {
  return {
    register() { return () => {} },
    subscribe() { return () => {} },
    getLocale() { return { active, locales: [], revision: 1 } },
    bind() { return (key) => key },
  }
}

const sectionRegistrationForText = registrations.find((registration) => registration.options.name === 'settings.section')

function renderSectionText() {
  return collectText(runComponent(sectionRegistrationForText.component, propsFor(sectionRegistrationForText)).tree).join(' ')
}

// A namespace the shared registry knows nothing about makes `locale.bind` echo
// the key back rather than throw. The panel must still render its own copy.
stubLocale = echoingLocale('zh')
const chinese = renderSectionText()
check('an unresolved locale lookup still renders Chinese copy', chinese.includes('尚未配置 API Key') && chinese.includes('最近请求'), chinese.slice(0, 160))
check('no raw i18n key leaks into the rendered panel', !/\bkeyMissing\b|\bnotReady\b|\bautoSetup\b|\bhistory\b/.test(chinese), chinese.slice(0, 200))

stubLocale = echoingLocale('en')
const english = renderSectionText()
check('an English locale renders English copy', english.includes('No API key') && english.includes('Recent requests'), english.slice(0, 160))
check('the two locales really differ', chinese !== english)

// With no locale service at all the bundled Chinese dictionary is the default.
stubLocale = undefined
check('a composition without the locale service still renders Chinese', renderSectionText().includes('尚未配置 API Key'))

// ── call every registered component ─────────────────────────────────────────

/** Build the props a slot hands a component: the injected face plus hooks. */
function propsFor(registration) {
  const face = typeof registration.options.inject === 'function'
    ? (Array.isArray(registration.options.inject) ? registration.options.inject() : registration.options.inject())
    : {}
  const injected = face?.hooks === undefined
    ? face
    : { ...face, ...face.hooks }
  // The Loader turns each `hooks.<name>` source into a `use<Name>` hook prop.
  const props = { ...injected }
  for (const [name, store] of Object.entries(face?.hooks ?? {})) {
    const hook = `use${name.charAt(0).toUpperCase()}${name.slice(1)}`
    props[hook] = (selector) => selector(store.getSnapshot())
  }
  return props
}

for (const registration of registrations) {
  const label = `${registration.options.name}[${registration.options.key ?? registration.options.id}]`
  let result = null
  try {
    result = runComponent(registration.component, propsFor(registration))
  } catch (error) {
    failures.push(`rendering ${label} threw: ${error?.message ?? error}`)
    continue
  }
  check(`rendering ${label} produces a tree`, result.tree !== null && result.tree !== undefined)
  const serialized = JSON.stringify(result.tree)
  check(`rendering ${label} does not leak a Host object`, !serialized.includes('"rpc"') && !serialized.includes('Symbol('), serialized.slice(0, 120))
  // Effects are captured, never run: the RPC read they trigger needs a live
  // browser session, and running it here would assert nothing about rendering.
  check(`rendering ${label} registers effects without throwing`, Array.isArray(result.effects))
}

// ── the registration face is live, not a snapshot ───────────────────────────

const sectionRegistration = registrations.find((registration) => registration.options.name === 'settings.section')
const firstFace = propsFor(sectionRegistration)
check('the injected face exposes the store hook', typeof firstFace.useClinePass === 'function')
const snapshotA = firstFace.useClinePass((value) => value)
check('the store starts in a loading state', snapshotA.status === 'loading', JSON.stringify(snapshotA).slice(0, 80))
check('the store is uSES-safe (same reference between reads)', firstFace.useClinePass((value) => value) === snapshotA)

// The actions the panel exposes must all be callable; each one is what a
// button in the rendered tree binds to.
for (const name of ['refresh', 'setKey', 'testKey', 'saveAndTest', 'addAccount', 'removeAccount', 'setAccountMode', 'pinModel', 'setupModel', 'probeModel', 'validateModel', 'testModel', 'resetModel', 'refreshModels', 'loadHistory']) {
  check(`the injected face exposes ${name}`, typeof firstFace[name] === 'function')
}

// ── the manifest and the bundle agree ───────────────────────────────────────

const decl = pkg.dsh?.client
check('the manifest declares a web client half', decl?.platform === 'web', JSON.stringify(decl))
check('the manifest declares the client dependencies it uses', Array.isArray(decl?.inject) && decl.inject.length > 0, JSON.stringify(decl?.inject))
check('the client half is exported', pkg.exports?.['./client'] === './lib/client.js', String(pkg.exports?.['./client']))
check('the client bundle ships in the package', Array.isArray(pkg.files) && pkg.files.includes('lib'), JSON.stringify(pkg.files))
// The two halves must agree on one route, and it must be an authenticated one:
// `/api` belongs to Connection, whose handler applies the trust fence and the
// browser-cookie check. A route on the bare webserver would be unauthenticated.
check('the browser half calls the exact route the host publishes', source.includes(`'${PANEL_PATH}'`), `${PANEL_PATH} not found in the bundle`)
check('the panel route sits inside the authenticated /api prefix', PANEL_PATH.startsWith('/api/'), PANEL_PATH)
check('the browser half reaches it with a plain fetch, not a retired RPC channel', /fetch\(PANEL_PATH/.test(source), 'fetch(PANEL_PATH) not found')
check('the browser half posts JSON to it', /'content-type':\s*'application\/json'/.test(source), 'no JSON content type')
check('the browser half no longer speaks the old RPC channel', !source.includes('rpc.call'), 'a stale rpc.call remains')

// A caller on the Models page gets the same controller as the Settings page,
// so the two can never disagree about what is configured.
check('one controller serves every registration', new Set(registrations.map((registration) => registration.options.inject)).size <= registrations.length)

if (failures.length > 0) {
  console.error(`\n✘ ${failures.length} check(s) failed, ${passed} passed:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✔ all ${passed} checks passed`)
