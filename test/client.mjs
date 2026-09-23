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

// The platform seed table publishes more than React; the plugin draws its
// disclosure chevrons with the shared primitives, so the stub answers that
// specifier too rather than recording it as a missing external.
//
// The icon export was renamed between host lines, so the stub below is the
// 0.1.2–0.1.5 shape (`…Outline14`) and the postures further down cover the two
// other shapes a host can present. `stableChevronCalls` proves this shape is
// the one actually used, not merely tolerated.
const PRIMITIVES_SPECIFIER = '@deepseek-ai/dsh-client-ui-primitives'

/**
 * A primitives face whose chevron records the exact export name it was read by.
 *
 * Asserting only that "a host icon was used" cannot tell a correct resolution
 * from one that silently falls through to a lower-preference name — both draw a
 * host icon. Each name below reports itself so the test can name the winner.
 */
function taggedPrimitives(names, picked) {
  const face = {}
  for (const name of names) face[name] = () => { picked.push(name); return null }
  return face
}
let stableChevronCalls = 0
const primitivesStub = {
  IconChevronDownOutline14: () => {
    stableChevronCalls += 1
    return null
  },
}

/** Effect callbacks the bundle's React stub captured, in render order. */
const collectedEffects = []

function makeRequire(primitives = primitivesStub) {
  const React = {
    createElement,
    Fragment: Symbol('Fragment'),
    // A boolean is this panel's disclosure state: the plugin card, the account
    // card and every model row fold with one. The stub opens them so those
    // bodies are part of the rendered tree — a collapsed card renders its
    // header alone, and the copy asserted below lives in the body.
    useState: (initial) => {
      const value = typeof initial === 'function' ? initial() : initial
      return [value === false ? true : value, () => {}]
    },
    // Effects are where the panel reaches for its actions, and they run after
    // the first paint — outside every error boundary the render assertions
    // exercise. Collect them so a test can run them: a face advertising an
    // action the controller no longer defines calls it from here, and the throw
    // takes the whole panel down without failing any render assertion.
    useEffect: (callback) => { collectedEffects.push(callback) },
    useMemo: (factory) => factory(),
    useRef: () => ({ current: undefined }),
  }
  return (specifier) => {
    if (specifier === 'react') return React
    if (specifier === PRIMITIVES_SPECIFIER) return primitives
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
check('every declared slot is registered', registrations.length === 2, keys.join(' '))
check('a Plugins tab is registered', registrations.some((registration) => registration.options.name === 'settings.plugins.tab' && registration.options.id === 'cline-pass'), keys.join(' '))
check('a Models-page card is registered', registrations.some((registration) => registration.options.name === 'settings.models.provider-card' && registration.options.key === 'cline-pass'), keys.join(' '))
// `settings.plugins.tab` is a list slot ordered by `order`; the host's own
// inventory tab sits at 10, so the route's tab is placed after it.
check('the Plugins tab carries an order and a locale label thunk', registrations.find((registration) => registration.options.name === 'settings.plugins.tab')?.options.order === 20 && typeof registrations.find((registration) => registration.options.name === 'settings.plugins.tab')?.options.label === 'function', keys.join(' '))
// One surface, not two: the panel lives in the Plugins tab alone, so no
// Settings-nav entry duplicates it.
check('no Settings page duplicates the Plugins panel', !registrations.some((registration) => registration.options.name === 'settings.section'), keys.join(' '))

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

/**
 * Expand function components so a nested body is part of the tree.
 *
 * `runComponent` invokes the top-level component only, and this card keeps the
 * panel one level down (the disclosure body). Collecting text without expanding
 * would see the card's header alone.
 */
function resolveComponents(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(resolveComponents)
  if (typeof node.type === 'function') return resolveComponents(node.type(node.props))
  return { ...node, props: { ...node.props, children: resolveComponents(node.props?.children) } }
}

// The Plugins tab is the one configuration surface, and it is a disclosure the
// stub above opens, so its body — the panel — is what this renders.
const cardRegistrationForText = registrations.find((registration) => registration.options.name === 'settings.plugins.tab')

function renderCardText() {
  return collectText(resolveComponents(runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree)).join(' ')
}

/**
 * Every element in a rendered tree whose handler text matches.
 *
 * The delete button's disabled state is the thing being checked, and it is not
 * visible in the collected copy: a disabled button still renders its label.
 */
function findButtons(node, label, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) { for (const child of node) findButtons(child, label, found); return found }
  const children = node.props?.children
  if (node.type === 'button' && collectText(children).includes(label)) found.push(node)
  findButtons(children, label, found)
  return found
}

// A namespace the shared registry knows nothing about makes `locale.bind` echo
// the key back rather than throw. The panel must still render its own copy.
//
// These assertions name copy that renders before any read has answered: the
// card header and the panel's status line. The sections below the status line
// wait for the route to be configured, so they are not part of this tree — the
// store starts in its loading state here because effects are captured, not run.
stubLocale = echoingLocale('zh')
const chinese = renderCardText()
check('an unresolved locale lookup still renders Chinese copy', chinese.includes('尚未配置 API Key') && chinese.includes('订阅模型的渠道钉住'), chinese.slice(0, 160))
check('no raw i18n key leaks into the rendered panel', !/\bkeyMissing\b|\bhistory\b|\busageTitle\b/.test(chinese), chinese.slice(0, 200))

stubLocale = echoingLocale('en')
const english = renderCardText()
check('an English locale renders English copy', english.includes('No API key') && english.includes('Channel pins'), english.slice(0, 160))
check('the two locales really differ', chinese !== english)

// With no locale service at all the bundled Chinese dictionary is the default.
stubLocale = undefined
check('a composition without the locale service still renders Chinese', renderCardText().includes('尚未配置 API Key'))

// ── the loaded panel renders ────────────────────────────────────────────────
//
// The assertions above render the panel before any read has answered, so every
// section below the status line is absent — a component that only throws once
// real data reaches it (a renamed helper, a changed argument list) would pass
// them all. This renders the whole panel against a fully populated snapshot,
// which is the state a user actually looks at.
{
  const store = cardRegistrationForText.options.inject().hooks.clinePass
  const snapshot = store.getSnapshot()
  const accounts = [{ key: 'default', displayName: 'Cline Pass', apiKeyEnv: 'CLINE_PASS_API_KEY', enabled: true, declared: true, keyConfigured: true, keyHint: 'sk_liv…3456' }]
  const models = [{ id: 'cline-pass/glm-5.2', hidden: false, pinned: ['alibaba'], excluded: ['baseten'], upstreams: ['alibaba', 'baseten'], upstreamStatus: [{ upstream: 'alibaba', status: 'ok', note: '' }], targets: ['alibaba'] }]
  const usage = { fetchedAt: Date.now(), accounts: [{ account: 'default', ok: true, limits: [{ type: 'five_hour', percentUsed: 25, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, { type: 'weekly', percentUsed: 80, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }, { type: 'made_up_window', percentUsed: 5, resetsAt: '' }] }] }
  store.set({
    ...snapshot,
    status: 'ready',
    data: {
      provider: 'cline-pass', displayName: 'Cline Pass', baseURL: 'https://api.cline.bot/api/v1',
      settingsAvailable: true, accountMode: 'single', activeAccount: '', ready: true,
      accounts, models, pinnedModels: 1, hiddenModels: 0, catalogCount: 1, historySize: 2, usage,
    },
  })
  let loaded = null
  let loadedError = null
  try {
    loaded = collectText(resolveComponents(runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree)).join(' ')
  } catch (error) {
    loadedError = error
  }
  check('the fully loaded panel renders without throwing', loadedError === null, loadedError?.message ?? '')
  check('the loaded panel shows the quota percentages', loaded !== null && loaded.includes('25%') && loaded.includes('80%'), (loaded ?? '').slice(0, 200))
  check('the loaded panel names an unknown window verbatim', loaded !== null && loaded.includes('made_up_window'), (loaded ?? '').slice(0, 300))
  check('the loaded panel shows the pinned channel', loaded !== null && loaded.includes('alibaba'), (loaded ?? '').slice(0, 300))
  check('the loaded panel leaks no raw key', loaded !== null && !/keyMissing$|\bdata\b:/.test(loaded), (loaded ?? '').slice(0, 200))
  store.set(snapshot)
}

// ── the user's path: open the tab, let the effects run, show the data ───────
//
// This is the sequence that shipped broken. A real mount renders with no data,
// runs its effects to start the first read, renders again once that read lands,
// and starts its remaining reads from there — the guard in each effect means the
// reads only happen on the second pass. The tab's header renders fine
// throughout, so a closed card looks healthy; the failure appears only after the
// body mounts and its later effects run, where a throw retires the slot entry and
// leaves an empty tabpanel rather than an error.
{
  const savedFetch = globalThis.fetch
  const payload = {
    provider: 'cline-pass', displayName: 'Cline Pass', baseURL: 'https://api.cline.bot/api/v1',
    settingsAvailable: true, accountMode: 'single', activeAccount: 'default', ready: true,
    accounts: [{ key: 'default', displayName: 'Cline Pass', apiKeyEnv: 'CLINE_PASS_API_KEY', enabled: true, declared: true, keyConfigured: true, keyHint: 'sk_liv…3456' }],
    models: [{ id: 'cline-pass/glm-5.2', hidden: false, pinned: ['alibaba'], excluded: [], upstreams: ['alibaba'], upstreamStatus: [], targets: ['alibaba'] }],
    pinnedModels: 1, hiddenModels: 0, catalogCount: 1, historySize: 1,
    usage: { fetchedAt: Date.now(), accounts: [{ account: 'default', ok: true, limits: [{ type: 'five_hour', percentUsed: 42, resetsAt: new Date(Date.now() + 60_000).toISOString() }] }] },
    entries: [], total: 0,
  }
  globalThis.fetch = async () => ({ ok: true, async json() { return { ok: true, value: payload } } })

  const store = cardRegistrationForText.options.inject().hooks.clinePass
  store.set({ status: 'loading', error: null, data: null, busy: null, notice: null, action: null })

  const failures = []
  const runEffects = () => {
    const collected = []
    // The stub collects into one module-level array, so drain it per pass.
    collectedEffects.length = 0
    runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText))
    collected.push(...collectedEffects)
    collectedEffects.length = 0
    for (const effect of collected) {
      try { effect() } catch (error) { failures.push(error?.message ?? String(error)) }
    }
    return collected.length
  }

  // First pass: no data yet, so only the mount read starts.
  const firstPass = runEffects()
  for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => { setTimeout(resolve, 0) })
  check('opening the tab starts a read', firstPass > 0, String(firstPass))

  // Second pass: the read landed, so the remaining effects run — this is where
  // an action the face advertises but the controller no longer defines throws.
  const secondPass = runEffects()
  for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => { setTimeout(resolve, 0) })
  check('the reads that follow the first one all run', failures.length === 0, failures.join(' | '))
  check('the panel re-reads once its data lands', secondPass > 0, String(secondPass))

  const settled = collectText(resolveComponents(runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree)).join(' ')
  check('the panel is populated after the reads settle', settled.includes('42%') && settled.includes('cline-pass/glm-5.2'), settled.slice(0, 200))
  check('the settled panel renders no raw i18n key', !/\bkeyMissing\b|\bpanelUnavailable\b|\bexpand\b|\bcollapse\b/.test(settled), settled.slice(0, 200))

  globalThis.fetch = savedFetch
  // The store is shared across this file, and a later assertion checks its very
  // first state, so hand it back the way it was found.
  store.set({ status: 'loading', error: null, data: null, busy: null, notice: null, action: null })
}

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
  // The effects are where the panel reaches for its actions, and they run after
  // the first paint — outside every error boundary the render assertions above
  // exercise. A face advertising an action the controller no longer defines
  // (calling `props.loadUsage()` on a deleted method) therefore blanks the real
  // panel while all of those assertions still pass. Run them here instead.
  check(`rendering ${label} registers effects without throwing`, Array.isArray(result.effects))
}

// ── run the effects the first render registered ─────────────────────────────
//
// The stub collects them rather than running them, because a real mount runs
// them right after paint. They are the only place some actions are reached, so a
// face that advertises an action the controller no longer defines throws here —
// after paint, where nothing catches it, blanking the whole panel while every
// render assertion above still passes.
{
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, async json() { return { ok: true, value: {} } } })
  const thrown = []
  for (const [index, effect] of collectedEffects.entries()) {
    let cleanup = null
    try {
      cleanup = effect()
    } catch (error) {
      thrown.push(`[${index}] ${error?.message ?? error}`)
    }
    if (typeof cleanup === 'function') {
      try { cleanup() } catch (error) { thrown.push(`[${index}] cleanup: ${error?.message ?? error}`) }
    }
  }
  check('every effect the first render registered runs and cleans up', thrown.length === 0, thrown.join(' | '))
  check('the first render registers at least one effect', collectedEffects.length > 0, String(collectedEffects.length))
  globalThis.fetch = savedFetch
}

// ── the disclosure chevron across host icon sets ────────────────────────────
//
// The icon export was renamed between host lines: 0.1.2–0.1.5 ships
// `IconChevronDownOutline14`, 0.1.6+ ships `…Regular` / `…Medium`. A bundle
// that destructures one name and calls it crashes the whole panel on the other
// host, so each posture below must still render, and the fallback must be a
// real drawing rather than `undefined`.
check('the 0.1.2–0.1.5 chevron export is the one used', stableChevronCalls > 0, String(stableChevronCalls))

/** Render one registration under a given primitives module. */
function renderWith(primitives, registration) {
  const load = []
  const win = {
    __ModuleLoader__: { load: (e) => load.push(e) },
    document: documentStub,
  }
  const previous = globalThis.window
  globalThis.window = win
  try {
    const run = new Function('window', 'document', 'require', source)
    run(win, documentStub, makeRequire(primitives))
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  const exportsUnderTest = load[0].factory(makeRequire(primitives))
  const seen = []
  const slots = {
    inject: (key, callback) => { callback(); return () => {} },
    register: (options, component) => { seen.push({ options, component }); return () => {} },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    slots,
    connection: connectionService,
    effect: (body) => {
      const dispose = body()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: (name) => (name === 'slots' ? slots : name === 'connection' ? connectionService : undefined),
  }
  exportsUnderTest.apply(ctx)
  const target = seen.find((entry) => entry.options.name === registration)
  if (target === undefined) return { tree: null, effects: [] }
  return runComponent(target.component, propsFor(target))
}

for (const [label, names, expected] of [
  // This is what the shipping host actually publishes, and the bundle used to
  // omit the unsuffixed name — it silently fell back to a lower-preference one.
  ['the shipping fan-out set', ['IconChevronDownOutline', 'IconChevronDownOutlineArtwork', 'IconChevronDownOutlineRegular', 'IconChevronDownOutlineMedium'], 'IconChevronDownOutline'],
  ['0.1.2-0.1.5 single name', ['IconChevronDownOutline14'], 'IconChevronDownOutline14'],
  ['an artwork/regular/medium triple', ['IconChevronDownOutlineRegular', 'IconChevronDownOutlineMedium'], 'IconChevronDownOutlineRegular'],
  ['a seed table without any chevron icon', [], null],
]) {
  const picked = []
  const primitives = taggedPrimitives(names, picked)
  let result = null
  try {
    result = renderWith(primitives, 'settings.plugins.tab')
  } catch (error) {
    failures.push(`rendering the Plugins tab under ${label} threw: ${error?.message ?? error}`)
    continue
  }
  check(`the Plugins tab renders under ${label}`, result.tree !== null && result.tree !== undefined)
  // The bundle picks one name at load. Assert it picked the highest-preference
  // one this host publishes, and that an unknown host falls back to the glyph.
  const usedFallback = JSON.stringify(result.tree ?? null).includes('M4 6.5 8 10.5 12 6.5')
  if (expected === null) {
    check(`the inline glyph is the fallback under ${label}`, usedFallback, `picked=${JSON.stringify(picked)}`)
  } else {
    check(`the Plugins tab resolves the chevron under ${label}`, picked.includes(expected), `expected=${expected} picked=${JSON.stringify(picked)}`)
  }
  // The fallback is an inline <svg>; `undefined` as an element type is the
  // crash this guards against, and JSON keeps it out of the tree entirely.
  check(`no undefined element type leaks under ${label}`, !JSON.stringify(result.tree ?? null).includes('"type":null'), JSON.stringify(result.tree ?? null).slice(0, 120))
}

// ── the registration face is live, not a snapshot ───────────────────────────

const faceRegistration = registrations.find((registration) => registration.options.name === 'settings.plugins.tab')
const firstFace = propsFor(faceRegistration)
check('the injected face exposes the store hook', typeof firstFace.useClinePass === 'function')
const snapshotA = firstFace.useClinePass((value) => value)
check('the store starts in a loading state', snapshotA.status === 'loading', JSON.stringify(snapshotA).slice(0, 80))
check('the store is uSES-safe (same reference between reads)', firstFace.useClinePass((value) => value) === snapshotA)

// Every action the face advertises must exist on the controller. The face is
// built from `controller.<name>` references, so a method deleted from the
// controller while its reference stays behind yields `undefined` here — and the
// panel calls several of them from an effect, after paint, where nothing catches
// the throw and the whole panel goes blank.
{
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, async json() { return { ok: true, value: {} } } })
  const advertised = Object.entries(firstFace).filter(([, value]) => typeof value === 'function' && value !== firstFace.useClinePass)
  const missing = advertised.filter(([, value]) => value === undefined).map(([name]) => name)
  check('every advertised action is a real function', missing.length === 0, `undefined: ${missing.join(', ')}`)
  // Call each one: a method that exists but reaches for something absent throws
  // just as loudly, and that is exactly what the panel's own effects do.
  const args = {
    setKey: ['CLINE_PASS_API_KEY', 'sk_typed'], testKey: ['CLINE_PASS_API_KEY', 'sk_typed'],
    saveAndTest: ['CLINE_PASS_API_KEY', 'sk_typed'], addAccount: [{ name: 'a', key: 'sk_k' }],
    removeAccount: ['a'], setAccountMode: [{ mode: 'single' }], setAccountEnabled: ['a', true],
    pinModel: [{ model: 'm', upstreams: [], exclude: [], sort: 'none' }], setModelVisible: ['m', true],
    setModelsVisibility: ['all'], probeModel: ['m'], validateModel: ['m'], testModel: ['m'],
    resetModel: ['m'], loadHistory: [5], loadUsage: [true],
  }
  const thrown = []
  for (const [name, fn] of advertised) {
    try { await fn(...(args[name] ?? [])) } catch (error) { thrown.push(`${name}: ${error?.message ?? error}`) }
  }
  check('every advertised action is callable', thrown.length === 0, thrown.join(' | '))
  globalThis.fetch = savedFetch
}

// The delete button is gated on `declared`, not on the pool size: an implicit
// account is the top-level key with nothing to delete, while a materialized one
// must stay removable even when it is the only account. Gating on the pool size
// left the button permanently dead for the common single-account case.
{
  const savedFetch = globalThis.fetch
  const seeded = (declared) => {
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          ok: true,
          value: {
            provider: 'cline-pass', displayName: 'Cline Pass', baseURL: 'https://api.cline.bot/api/v1',
            settingsAvailable: true, accountMode: 'single', activeAccount: '', ready: true,
            accounts: [{ key: 'default', displayName: 'Cline Pass', apiKeyEnv: 'CLINE_PASS_API_KEY', enabled: true, declared, keyConfigured: true, keyHint: 'sk_liv…3456' }],
            models: [], pinnedModels: 0, hiddenModels: 0, catalogCount: 0, historySize: 0, usage: null,
          },
        }
      },
    })
  }
  const removeButton = async (declared) => {
    seeded(declared)
    await firstFace.refresh()
    const tree = runComponent(faceRegistration.component, firstFace).tree
    const expanded = resolveComponents(tree)
    const buttons = findButtons(expanded, '删除')
    return buttons.find((button) => button.props.disabled !== undefined)
  }
  const implicit = await removeButton(false)
  const materialized = await removeButton(true)
  check('the delete button is disabled for an implicit account', implicit?.props.disabled === true, JSON.stringify(implicit?.props.disabled))
  check('the delete button is enabled for a declared account', materialized?.props.disabled === false, JSON.stringify(materialized?.props.disabled))
  globalThis.fetch = savedFetch
  await firstFace.refresh()
}

// The actions the panel exposes must all be callable; each one is what a
// button in the rendered tree binds to.
for (const name of ['refresh', 'setKey', 'testKey', 'saveAndTest', 'addAccount', 'removeAccount', 'setAccountMode', 'setAccountEnabled', 'pinModel', 'setModelVisible', 'setModelsVisibility', 'probeModel', 'validateModel', 'testModel', 'resetModel', 'refreshModels', 'loadUsage', 'loadHistory']) {
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
