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
function runComponent(component, props, persistent) {
  const effects = []
  let cursor = 0
  // `persistent` carries hook state across renders, which is what a second render
  // after an effect set state has to see. Without it every render starts blank and
  // a component that fetches in an effect can never show its result.
  const slots = persistent ?? []
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
    // The pill subscribes to the model-selection store through this, so the
    // stub has to read the snapshot rather than returning a constant.
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
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
  // The usage pill skips a poll in a hidden tab and refreshes when the tab comes
  // back, so it registers and removes a visibility listener. A stub without
  // these throws from an effect — after paint, outside any render assertion.
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
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

function makeRequire(primitives = primitivesStub, react = undefined) {
  // This table belongs to the caller that gets it back, so its hook state is its
  // own. The blocks that render a component to completion pass their own table
  // (with a cursor they can restart); this one only serves the registrations the
  // module-scope `apply()` records, whose bodies are never rendered here.
  const ownHooks = []
  let ownCursor = 0
  const React = react ?? {
    createElement,
    Fragment: Symbol('Fragment'),
    // A boolean is this panel's disclosure state: the plugin card, the account
    // card and every model row fold with one. The stub opens them so those
    // bodies are part of the rendered tree — a collapsed card renders its
    // header alone, and the copy asserted below lives in the body.
    useState: (initial) => {
      const index = ownCursor++
      if (!(index in ownHooks)) {
        const value = typeof initial === 'function' ? initial() : initial
        ownHooks[index] = value === false ? true : value
      }
      return [ownHooks[index], (next) => { ownHooks[index] = typeof next === 'function' ? next(ownHooks[index]) : next }]
    },
    // Effects are where the panel reaches for its actions, and they run after
    // the first paint — outside every error boundary the render assertions
    // exercise. Collect them so a test can run them: a face advertising an
    // action the controller no longer defines calls it from here, and the throw
    // takes the whole panel down without failing any render assertion.
    useEffect: (callback) => { collectedEffects.push(callback) },
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    // The bundle reads `React.useSyncExternalStore` from this table (not from a
    // prop), so the usage pill's subscription has to be served here. It reads the
    // snapshot, which is what lets a test move the selection and re-render.
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    useCallback: (callback) => callback,
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

// A duplicate key in a dictionary is silently the LAST one: the earlier value is
// overwritten, so a new key that collides with an existing one breaks whatever
// already used it, with nothing failing at load. This is how the usage pill's
// heading broke the quota card's heading.
{
  // `source` is the bundle read at the top of this file.
  for (const name of ['ZH', 'EN']) {
    const from = source.indexOf(`const ${name} = {`)
    const body = source.slice(from, source.indexOf('\n    }', from))
    const keys = [...body.matchAll(/^\s*([a-zA-Z][A-Za-z0-9]*):/gm)].map((match) => match[1])
    const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))]
    check(`the ${name} dictionary declares no duplicate key`, duplicates.length === 0, duplicates.join(', '))
  }
}
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
// The `history` endpoint answers with a fixture the cache-hit test sets; every other
// endpoint answers with the panel state.
let rpcHistory = { entries: [], total: 0 }
const connectionService = {
  rpc: {
    async call(channel, endpoint, payload) {
      rpcCalls.push({ channel, endpoint, payload })
      if (endpoint === 'history') return { ok: true, value: rpcHistory }
      return { ok: true, value: { provider: 'cline-pass', displayName: 'Cline Pass', baseURL: 'https://api.cline.bot/api/v1', settingsAvailable: true, accountMode: 'single', activeAccount: '', ready: true, accounts: [{ key: 'default', displayName: 'Cline Pass', apiKeyEnv: 'CLINE_PASS_API_KEY', enabled: true, keyConfigured: true, keyHint: 'sk_liv…3456' }], models: [], pinnedModels: 0, catalogCount: 0, historySize: 0 } }
    },
  },
}

// A Cordis context exposes a declared dependency as a property as well as
// through `get()`; the plugin uses both forms. `stubLocale` stays reassignable
// so the tests below can exercise each locale posture.
let stubLocale
/**
 * The model-selection directory the usage pill reads the selected provider from.
 *
 * `session` is captured so a test can move the selection and assert the pill
 * re-gates; a stub that answered `undefined` would let a pill that never reads
 * the selection back pass.
 */
const stubDirectory = { current: { provider: 'cline-pass', model: 'cline-pass/glm-5.3' } }
const stubModelDirectories = {
  directoryFor: () => ({
    store: {
      getSnapshot: () => stubDirectory,
      subscribe: () => () => {},
    },
  }),
}
const stubCtx = {
  logger: { info() {}, warn() {}, error() {} },
  slots: slotsService,
  connection: connectionService,
  modelDirectories: stubModelDirectories,
  effect(body) {
    const dispose = body()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(name) {
    if (name === 'slots') return slotsService
    if (name === 'connection') return connectionService
    if (name === 'locale') return stubLocale
    if (name === 'modelDirectories') return stubModelDirectories
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

// Current Cordis executes service methods in the consumer's context. Model
// directories need remote.session; legacy hosts lack that service entirely.
{
  const modernRegistrations = []
  const scopes = []
  const modernSlots = { ...slotsService, register(options, component) { modernRegistrations.push({ options, component }); return () => {} } }
  const modernCtx = {
    ...stubCtx,
    slots: modernSlots,
    modelDirectories: { directoryFor() { throw new Error('remote.session was not injected into this context') } },
    get(name) { if (name === 'remote.session') return {}; if (name === 'slots') return modernSlots; return stubCtx.get(name) },
    inject(dependencies, callback) {
      scopes.push(dependencies)
      return callback({ ...this, modelDirectories: stubModelDirectories })
    },
  }
  exportsValue.apply(modernCtx)
  const usage = modernRegistrations.find((r) => r.options.name === 'conversation.input.right')
  let injected
  let failure
  try { injected = usage.options.inject('modern-session') } catch (error) { failure = error }
  check('modern usage slot gets a context with remote.session', failure === undefined, failure?.message)
  check('modern usage slot receives the actual model selection store', injected?.directory?.getSnapshot() === stubDirectory)
  check('only the modern host path adds the remote.session dependency', scopes.length === 1 && scopes[0].includes('remote.session'))
}

const keys = registrations.map((registration) => `${registration.options.name}:${registration.options.key ?? registration.options.id ?? ''}`)
check('every declared slot is registered', registrations.length === 3, keys.join(' '))
check('a first-level settings section is registered', registrations.some((registration) => registration.options.name === 'settings.section' && registration.options.id === 'cline-pass'), keys.join(' '))
check('a Models-page card is registered', registrations.some((registration) => registration.options.name === 'settings.models.provider-card' && registration.options.key === 'cline-pass'), keys.join(' '))
// 12 sits between the shell's own Models (10) and Plugins (15): the pins are what
// this plugin is for, so they get the same standing as a built-in page.
check('the section carries its nav position and a locale label thunk', registrations.find((registration) => registration.options.name === 'settings.section')?.options.order === 12 && typeof registrations.find((registration) => registration.options.name === 'settings.section')?.options.label === 'function' && typeof registrations.find((registration) => registration.options.name === 'settings.section')?.options.label() === 'string', keys.join(' '))
// One surface, not two. The panel used to be a tab under Plugins and nothing else,
// which is what put a pin five clicks deep; the section replaces it rather than
// joining it, so the same panel is not offered twice.
check('the panel is not also offered as a Plugins tab',
  !registrations.some((registration) => registration.options.name === 'settings.plugins.tab'), keys.join(' '))

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
const cardRegistrationForText = registrations.find((registration) => registration.options.name === 'settings.section')

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
  // Two rows, because the wording differs by state: one pinned, one on smart routing.
  const models = [
    { id: 'cline-pass/glm-5.2', hidden: false, pinMode: 'strict', pinned: ['alibaba'], excluded: ['baseten'], upstreams: ['alibaba', 'baseten'], upstreamStatus: [{ upstream: 'alibaba', status: 'ok', note: '' }], targets: ['alibaba'] },
    { id: 'cline-pass/kimi-k3', hidden: false, pinMode: 'strict', pinned: [], excluded: [], upstreams: ['moonshot', 'baseten'], upstreamStatus: [], targets: [] },
  ]
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
  // The row answers "what will a request do" without expanding it. It used to read
  // `已钉住: 自动路由`, asserting a pin over the state where nothing is pinned.
  {
    // The exact node text, not a substring: `精确钉住 · alibaba` contains
    // `钉住 · alibaba`, so an `includes` here would pass with the long wording back.
    let modeNode = null
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object' || modeNode !== null) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (String(node.props?.className ?? '').includes('cp-model-mode')) { modeNode = node; return }
      walk(node.children)
    }
    walk(runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree)
    const mode = modeNode === null ? '' : String(modeNode.props.children ?? '')
    check('a pinned row names its mode and the channel it pins',
      mode === '钉住 · alibaba', mode)
  }
  // The route prefix lives once, in the card header, instead of on every row.
  check('the card header names the route', loaded !== null && loaded.includes('cline-pass · 2 个模型'), (loaded ?? '').slice(0, 400))
  // Short in the header, spelled out in its tooltip: the long form was the longest
  // thing on the line and said the same as two characters.
  {
    const surface = cardRegistrationForText.options.inject().hooks.clinePass
    const before = surface.getSnapshot()
    surface.set({ ...before, data: { ...before.data, hiddenModels: 17 } })
    let summary = null
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object' || summary !== null) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      // Both cards fold through `foldHeader`, so the models card is the one that
      // counts models — the accounts card carries a different header.
      if (String(node.props?.className ?? '').includes('cp-fold')
        && collectText(node).join('').includes('个模型')) { summary = node; return }
      walk(node.children)
    }
    walk(runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree)
    const header = summary === null ? '' : collectText(summary).join('')
    check('the header shortens the hidden count',
      header.includes('cline-pass · 2 个模型 · 17 隐藏'), header.slice(0, 200))
    check('the long hidden spelling survives as the header tooltip',
      String(summary?.props?.title ?? '').includes('17 个已从选择列表隐藏'), String(summary?.props?.title))
    surface.set(before)
  }
  {
    // The visible label loses the prefix; the full id stays in `title` (and in the
    // checkbox's accessible name), so the row drops noise without losing identity.
    let nameNode = null
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object' || nameNode !== null) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (String(node.props?.className ?? '').includes('cp-grow cp-ellipsis')) { nameNode = node; return }
      walk(node.children)
    }
    walk(runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree)
    // `collectText` folds in `title` as well, so the assertion reads the child
    // itself: that is the only thing a reader sees.
    const visible = nameNode === null ? '' : String(nameNode.props.children ?? '')
    check('a row drops the route prefix it shares with every other row',
      nameNode !== null && visible === 'glm-5.2' && nameNode.props.title === 'cline-pass/glm-5.2',
      JSON.stringify({ visible, title: nameNode?.props?.title }))
  }
  // The count is a hint, not a column: the pinned names already say how many are
  // pinned, and repeating it pushed the row onto a second line. It survives in the
  // expander's tooltip.
  check('a pinned row does not repeat how many channels are pinned',
    loaded !== null && !loaded.includes('已钉住 1'), (loaded ?? '').slice(0, 400))
  // Not just "the old exact string is gone": any `已钉住:` prefix is the defect, since
  // the mode is not a pin and prefixing it claims one.
  check('an unpinned row says smart routing instead of claiming a pin',
    loaded !== null && loaded.includes('智能路由')
      && !loaded.includes('已钉住:') && !loaded.includes('已钉住: 自动路由'), (loaded ?? '').slice(0, 400))
  // The channel count moved off the row and onto the expander's tooltip, so the row
  // stays one line whatever the pin order is.
  {
    let expander = null
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object' || expander !== null) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (String(node.props?.title ?? '').includes('个渠道')) { expander = node; return }
      walk(node.children)
    }
    walk(runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree)
    check('the channel count rides on the expander tooltip',
      expander !== null && String(expander.props.title).includes('2 个渠道'), String(expander?.props?.title))
  }
  check('the loaded panel leaks no raw key', loaded !== null && !/keyMissing$|\bdata\b:/.test(loaded), (loaded ?? '').slice(0, 200))
  // The section is the page. It used to fold inside the Plugins tab, where a long
  // panel had to stay out of the way; as a page of its own the fold only asks for a
  // click on the thing the user just navigated to.
  {
    let folded = null
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object' || folded !== null) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (String(node.props?.className ?? '').includes('cp-set-header')) { folded = node; return }
      walk(node.children)
    }
    walk(runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree)
    check('the section renders its panel without a second fold', folded === null)
  }
  // The bulk toolbar sits directly above the first row, where the card's own gap
  // reads as none against two stacked borders. The class is what opens it up.
  {
    const modelsCard = registrations.length > 0
      ? runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree
      : null
    // `details` wraps everything after its summary, so the card's flex gap stops at
    // that wrapper; the grouping is what separates the toolbar from the first row.
    check('the models card groups its toolbar and list so the gap applies',
      JSON.stringify(modelsCard ?? null).includes('cp-models-body'),
      JSON.stringify(modelsCard ?? null).slice(0, 200))
    // Open on first render: a collapsed card hides whether anything is pinned, which
    // is the question this page exists to answer.
    let fold = null
    const findFold = (node) => {
      if (node === null || node === undefined || typeof node !== 'object' || fold !== null) return
      if (Array.isArray(node)) { node.forEach(findFold); return }
      if (String(node.props?.className ?? '').includes('cp-models')) { fold = node; return }
      findFold(node.children)
    }
    findFold(modelsCard)
    check('the models card starts expanded', fold !== null && fold.props.open === true,
      JSON.stringify(fold?.props?.open))
  // ── the channel list is editable, not just what a probe returned ──────────
  //
  // An account whose probe came back empty used to be a dead end: the row said no
  // channels were probed and offered no way to name the upstream the user knew
  // served them. The list is the user's data now.
  {
    const store = cardRegistrationForText.options.inject().hooks.clinePass
    const base = store.getSnapshot()
    const row = (pinned) => ({
      id: 'cline-pass/glm-5.2', hidden: false, pinMode: 'strict',
      pinned, excluded: [], upstreams: [], upstreamStatus: [], has: [], pipeline: 'planner',
    })
    const tree = () => runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree
    const find = (predicate) => {
      let found = null
      const walk = (node) => {
        if (node === null || node === undefined || typeof node !== 'object' || found !== null) return
        if (Array.isArray(node)) { node.forEach(walk); return }
        if (predicate(node)) { found = node; return }
        walk(node.children)
      }
      walk(tree())
      return found
    }

    store.set({ ...base, status: 'ready', data: { ...base.data, models: [row([])] } })
    const input = find((node) => node.tag === 'input' && String(node.props?.placeholder ?? '').includes('渠道名'))
    check('a model with nothing probed still offers a channel input', input !== null)
    check('the input accepts a typed name', typeof input?.props?.onChange === 'function' && typeof input?.props?.onKeyDown === 'function')

    // A name typed by hand has no probe behind it and must still render, or it could
    // never be removed.
    store.set({ ...base, status: 'ready', data: { ...base.data, models: [row(['deepseek'])] } })
    const chip = find((node) => node.tag === 'span' && String(node.props?.className ?? '') === 'cp-chip cp-chip-on cp-chip-manual')
    check('a hand-typed channel renders as an unverified chip', chip !== null, JSON.stringify(chip?.props?.className))
    // It has no discovery list to fall back on, so it needs its own way out.
    const remove = find((node) => node.props?.title === 'remove' && typeof node.props?.onClick === 'function')
    check('a hand-typed channel can be removed, not only un-pinned', remove !== null)

    // A probed channel keeps its entry whether pinned or not, so it gets no remove.
    store.set({ ...base, status: 'ready', data: { ...base.data, models: [{ ...row([]), upstreams: ['deepseek'] }] } })
    check('a probed channel offers no remove control',
      find((node) => node.props?.title === 'remove') === null)

    // The output budget is one route-wide number, and the card says which one is in
    // force rather than leaving it to be inferred from the highlighted button.
    store.set({ ...base, status: 'ready', data: { ...base.data, defaultMaxTokens: 131072 } })
    const budgetTitle = find((node) => String(node.props?.className ?? '') === 'cp-card-title' && String(node.props?.children ?? '').includes('输出预算'))
    check('the panel shows the output budget it is running',
      budgetTitle !== null && String(budgetTitle.props.children).includes('131,072'), String(budgetTitle?.props?.children))
    const pressed = find((node) => String(node.props?.className ?? '') === 'cp-btn cp-btn-on')
    check('the active budget preset is marked as pressed',
      pressed !== null && String(pressed.props.children).includes('128K'), JSON.stringify(pressed?.props?.children))



    store.set(base)
  }
  }

  // The management-tools switch: a real checkbox, reflecting the stored value
  // and wired to the host action. Its caption is the whole explanation the panel
  // gives, so the caption has to carry the restart it needs — the value is read
  // when the plugin activates, and nothing here can change that.
  {
    const collect = (node, out = { labels: [], boxes: [] }) => {
      if (node === null || node === undefined || typeof node !== 'object') return out
      if (Array.isArray(node)) { node.forEach((child) => collect(child, out)); return out }
      if (typeof node.type === 'function') return collect(node.type(node.props), out)
      if (node.type === 'input' && node.props?.type === 'checkbox') out.boxes.push(node)
      if (node.type === 'label') out.labels.push(node)
      collect(node.props?.children, out)
      return out
    }
    const surface = cardRegistrationForText.options.inject().hooks.clinePass
    const base = surface.getSnapshot()
    const renderSwitch = () => {
      const out = collect(resolveComponents(runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree))
      const label = out.labels.find((node) => JSON.stringify(node.props?.children ?? '').includes('开启工具注入'))
      const box = label?.props?.children?.find?.((child) => child?.type === 'input') ?? out.boxes.at(-1)
      return { label, box }
    }
    surface.set({ ...base, status: 'ready', data: { ...base.data, exposeTools: false } })
    const off = renderSwitch()
    check('the panel offers the management-tools switch', off.box !== undefined, String(off.box))
    check('the switch is off when the tools are not registered', off.box?.props.checked === false, JSON.stringify(off.box?.props.checked))
    check('the switch is wired to the host action', typeof off.box?.props.onChange === 'function')
    check('the caption carries the restart it needs', JSON.stringify(off.label?.props?.children ?? '').includes('重启后生效'), JSON.stringify(off.label?.props?.children ?? null))
    // The caption is the whole explanation the panel gives, so it is also the
    // place a stray third line would reappear. Pin the exact wording and the
    // absence of the removed metadata lines.
    const captionText = (node) => {
      if (typeof node === 'string') return node
      if (node === null || node === undefined || typeof node !== 'object') return ''
      if (Array.isArray(node)) return node.map(captionText).join('')
      if (typeof node.type === 'function') return captionText(node.type(node.props))
      return captionText(node.props?.children)
    }
    check('the caption is exactly the requested wording',
      captionText(off.label) === '开启工具注入（重启后生效）',
      JSON.stringify(captionText(off.label)))
    {
      const rendered = resolveComponents(runComponent(cardRegistrationForText.component, propsFor(cardRegistrationForText)).tree)
      const strings = []
      const collectStrings = (node) => {
        if (typeof node === 'string') { strings.push(node); return }
        if (node === null || node === undefined || typeof node !== 'object') return
        if (Array.isArray(node)) { node.forEach(collectStrings); return }
        if (typeof node.type === 'function') { collectStrings(node.type(node.props)); return }
        collectStrings(node.props?.children)
      }
      collectStrings(rendered)
      check('no leftover management-tools metadata is rendered',
        !strings.some((text) => /5\.5k|管理工具|exposeTools|未注册/.test(text)),
        strings.filter((text) => /5\.5k|管理工具|exposeTools|未注册/.test(text)).join(' | '))
    }
    surface.set({ ...base, status: 'ready', data: { ...base.data, exposeTools: true } })
    const on = renderSwitch()
    check('the switch is on when the tools are registered', on.box?.props.checked === true, JSON.stringify(on.box?.props.checked))
    surface.set(base)
  }  store.set(snapshot)
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
  check('the panel is populated after the reads settle', settled.includes('42%') && settled.includes('glm-5.2'), settled.slice(0, 200))
  check('the settled panel renders no raw i18n key', !/\bkeyMissing\b|\bpanelUnavailable\b|\bexpand\b|\bcollapse\b/.test(settled), settled.slice(0, 200))

  globalThis.fetch = savedFetch
  // The store is shared across this file, and a later assertion checks its very
  // first state, so hand it back the way it was found.
  store.set({ status: 'loading', error: null, data: null, busy: null, notice: null, action: null })
}

// ── call every registered component ─────────────────────────────────────────

/** Build the props a slot hands a component: the injected face plus hooks. */
function propsFor(registration, sessionId) {
  // A session-scoped slot's `inject` is called with the session it renders for;
  // calling it with nothing would hand the component a different directory than
  // the one a test mutates, and the gate would pass for the wrong reason.
  const face = typeof registration.options.inject === 'function'
    ? registration.options.inject(sessionId)
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
    modelDirectories: { directoryFor: () => ({ store: { getSnapshot: () => ({ current: null }), subscribe: () => () => {} } }) },
    effect: (body) => {
      const dispose = body()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'slots') return slots
      if (name === 'connection') return connectionService
      if (name === 'modelDirectories') return this.modelDirectories
      return undefined
    },
  }
  exportsUnderTest.apply(ctx)
  const target = seen.find((entry) => entry.options.name === registration)
  if (target === undefined) return { tree: null, effects: [] }
  const props = propsFor(target)
  return { ...runComponent(target.component, props), props, target }
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
    result = renderWith(primitives, 'settings.section')
  } catch (error) {
    failures.push(`rendering the section under ${label} threw: ${error?.message ?? error}`)
    continue
  }
  check(`the section renders under ${label}`, result.tree !== null && result.tree !== undefined)
  // The chevron only exists inside a fold header, and the fold cards wait for data.
  // Populating the shared store and rendering again is what puts one on screen.
  const surface = result.props?.hooks?.clinePass
  if (surface !== undefined) {
    const before = surface.getSnapshot()
    surface.set({
      ...before,
      status: 'ready',
      data: {
        provider: 'cline-pass', displayName: 'Cline Pass', ready: true, settingsAvailable: true,
        accountMode: 'single', activeAccount: '', accounts: [], models: [{ id: 'cline-pass/glm-5.2', hidden: false, pinned: [], excluded: [], upstreams: [] }],
        pinnedModels: 0, hiddenModels: 0, catalogCount: 0, historySize: 0, usage: null,
      },
    })
    result = { ...runComponent(result.target.component, result.props), props: result.props, target: result.target }
  }
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

// ── the quota card shows one account at a time ──────────────────────────────
//
// A pool of several accounts, each with three windows, stacked every reading at
// once: the card became a wall of bars, no single account's remaining quota
// could be read, and the card grew with the pool. It now shows one account with
// `‹` `›` arrows, which is state held in the component — paging issues no
// request, so it works while the panel is busy or the settings service is
// read-only.
//
// The click-and-observe transition is the thing to test, and it needs hooks whose
// state survives a re-render: `runComponent` starts a fresh cursor every call, so
// a click there is unobservable. The bundle closes over the React it required, so
// a persistent set has to be installed by loading it again.
{
  const hooks = []
  let cursor = 0
  // The settings panel's cards fold on a boolean and the copy under test lives in
  // the body, so its `false` states are opened. The usage pill's booleans are
  // data and interaction state — coercing those renders its failure posture and
  // an already-expanded card — so it renders with this off.
  let coerced = true
  const React = {
    createElement,
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      // A boolean in the settings panel is a disclosure, and the card under test
      // is the folded body one guards. The usage pill's booleans are failure and
      // disclosure flags read from data, so coercing those would make it render
      // its failed posture instead of its reading.
      if (hooks[index] === false && coerced) hooks[index] = true
      return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
    },
    useEffect(callback) { collectedEffects.push(callback) },
    useMemo(factory) { cursor += 1; return factory() },
    useRef(initial) { cursor += 1; return { current: initial } },
    useCallback(callback) { cursor += 1; return callback },
    // The usage pill learns the selected provider through this. Reading the
    // snapshot (rather than a constant) is what lets a test move the selection
    // and assert the pill re-gates.
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
  }
  const load = []
  const win = { __ModuleLoader__: { load: (entry) => load.push(entry) }, document: documentStub }
  const previousWindow = globalThis.window
  globalThis.window = win
  try {
    const run = new Function('window', 'document', 'require', source)
    run(win, documentStub, makeRequire(primitivesStub, React))
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  const seen = []
  /**
   * A model-selection directory stand-in.
   *
   * The usage pill subscribes to this to learn the selected provider, so the
   * store has to behave like the real one: a snapshot plus a subscribe that
   * fires on change. A stub that only exposed the current value would let a pill
   * that never re-gates on a model switch pass.
   */
  const makeDirectory = (initial = { current: null }) => {
    let snapshot = initial
    const listeners = new Set()
    return {
      store: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
      },
      set: (next) => { snapshot = next; listeners.forEach((listener) => listener()) },
    }
  }
  const directories = new Map()
  const modelDirectories = {
    directoryFor: (sessionId) => {
      if (!directories.has(sessionId)) directories.set(sessionId, makeDirectory())
      return directories.get(sessionId)
    },
  }

  const slots = {
    inject: (key, callback) => { callback(); return () => {} },
    register: (options, component) => { seen.push({ options, component }); return () => {} },
  }
  load[0].factory(makeRequire(primitivesStub, React)).apply({
    logger: { info() {}, warn() {}, error() {} },
    slots,
    connection: connectionService,
    modelDirectories,
    effect: (body) => { const dispose = body(); return typeof dispose === 'function' ? dispose : () => {} },
    get: (name) => (name === 'slots' ? slots : name === 'connection' ? connectionService : name === 'modelDirectories' ? modelDirectories : undefined),
  })
  const card = seen.find((entry) => entry.options.name === 'settings.section').component
  const cardProps = propsFor(seen.find((entry) => entry.options.name === 'settings.section'))
  const render = () => { cursor = 0; return card({ ...cardProps }) }
  const copy = (tree) => collectText(resolveComponents(tree)).join(' ')
  const navButton = (tree, label) => {
    let found = null
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object' || found !== null) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (typeof node.type === 'function') { walk(node.type(node.props)); return }
      if (node.type === 'button' && (node.props?.['aria-label'] === label || node.props?.title === label)) found = node
      walk(node.props?.children)
    }
    walk(resolveComponents(tree))
    return found
  }
  const store = cardProps.hooks.clinePass
  const snapshot = store.getSnapshot()
  const reading = (name, percent, ok = true) => ({
    account: name, displayName: `名字 ${name}`, ok,
    limits: ok ? [{ type: 'five_hour', percentUsed: percent, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] : [],
    ...(ok ? {} : { error: '读不到' }),
  })
  const show = (accounts, mode = 'single', active = '') => store.set({
    ...snapshot,
    status: 'ready',
    data: {
      provider: 'cline-pass', ready: true, settingsAvailable: true, accountMode: mode, activeAccount: active,
      // The host resolves which account a request would use. The stub mirrors it:
      // single mode honours `activeAccount`, and a pool without a cursor takes the
      // first enabled one.
      effectiveAccount: active !== '' ? active : (accounts[0] ?? ''),
      accounts: accounts.map((key) => ({ key, enabled: true, declared: true })),
      models: [], pinnedModels: 0, hiddenModels: 0, catalogCount: 0, historySize: 0,
      usage: { fetchedAt: Date.now(), accounts: accounts.map((key, index) => reading(key, [11, 22, 33][index] ?? 44, key !== 'b')) },
    },
  })
  /** The quota card's own region: `当前` is also the accounts card's column head. */
  const quota = (text) => {
    const from = text.indexOf('官方额度')
    if (from < 0) return ''
    // The models card's header is the region's end. It used to read 订阅模型, which is
    // why this marker went stale the release that header was shortened: the slice ran
    // to the end of the panel and picked up every later card.
    const to = text.indexOf('cline-pass', from)
    return text.slice(from, to < 0 ? undefined : to)
  }
  const next = '下一个账号'
  const prev = '上一个账号'
  const click = (label) => {
    const button = navButton(render(), label)
    if (button === null) return false
    button.props.onClick()
    return true
  }

  // The card opens on the account a request would use, which is the reading the
  // pool was opened for. The first entry is not it: usage is per account, so
  // starting there answers a question about a key that may not be about to be used.
  show(['a', 'b', 'c'], 'single', 'b')
  let view = copy(render())
  check('the quota card opens on the account a request would use',
    view.includes('名字 b') && !view.includes('名字 a') && !view.includes('名字 c'), quota(view).slice(0, 120))
  check('the quota card shows which account of how many', view.includes('2 / 3'), quota(view).slice(0, 120))
  // The account in line is shown even when its own read failed, rather than a
  // healthy reading borrowed from an account the request will not touch.
  check('an account whose read failed still shows its own error', view.includes('读不到'), quota(view).slice(0, 160))

  show(['a'], 'single', 'new-account')
  const missingReading = quota(copy(render()))
  check('the quota card never borrows a reading for an account absent from its cache',
    !missingReading.includes('11%') && missingReading.includes('账号 new-account'), missingReading)
  const missingState = store.getSnapshot()
  store.set({ ...missingState, data: { ...missingState.data, effectiveAccount: '' } })
  const disabledReading = quota(copy(render()))
  check('the quota card does not show cached quota when no account is effective',
    !disabledReading.includes('11%') && disabledReading.includes('暂时读不到'), disabledReading)
  store.set({ ...missingState, data: { ...missingState.data, effectiveAccount: undefined } })
  check('the quota card still supports a host without effectiveAccount', quota(copy(render())).includes('11%'))
  show(['a', 'b', 'c'], 'single', 'b')

  check('the quota card offers a next-account control', click(next), 'no button')
  view = copy(render())
  check('next moves to the following account', view.includes('名字 c') && view.includes('3 / 3'), quota(view).slice(0, 120))
  click(next); view = copy(render())
  check('next wraps back to the first account', view.includes('名字 a') && view.includes('1 / 3'), quota(view).slice(0, 120))
  check('the quota card offers a previous-account control', click(prev), 'no button')
  view = copy(render())
  check('previous wraps backwards to the last account', view.includes('名字 c') && view.includes('3 / 3'), quota(view).slice(0, 120))

  // Paging is the user's: the account in line moving underneath must not yank the
  // card off the account they are reading.
  show(['a', 'b', 'c'], 'single', 'a')
  view = copy(render())
  check('a paged card keeps the page the user chose',
    view.includes('名字 c') && view.includes('3 / 3'), quota(view).slice(0, 120))

  // Removing accounts shortens the reading under a selection that is now past
  // its end; the card must clamp rather than index off the list.
  show(['a', 'b', 'c'], 'single', '')
  click(next); click(next)          // deliberately on the last of three
  show(['a'], 'single', '')
  // A dropped account must not throw either: an index left past the end reads
  // `undefined.account` and takes the whole panel with it, so catch it here
  // rather than let one mutation abort the run.
  let shrunk = ''
  let shrunkError = null
  try {
    shrunk = quota(copy(render()))
  } catch (error) {
    shrunkError = error
  }
  check('a reading that shrank under the selection does not blank the card', shrunkError === null && (shrunk.includes('名字 a') || shrunk.includes('11%')), shrunkError?.message ?? shrunk.slice(0, 160))

  show(['a'], 'single', 'a')
  check('a single account gets no pager controls', navButton(render(), next) === null && navButton(render(), prev) === null)

  // The badge names the account a request would use. Paging must land it on that
  // account and on no other, whatever page the component happens to be on.
  const badgeOn = (mode, active) => {
    show(['a', 'b'], mode, active)
    const badged = []
    for (let page = 0; page < 2; page += 1) {
      const region = quota(copy(render()))
      if (region.includes('当前')) badged.push(['名字 a', '名字 b'].find((name) => region.includes(name)))
      click(next)
    }
    return badged
  }
  check('single mode marks exactly the account a request would use', JSON.stringify(badgeOn('single', 'b')) === JSON.stringify(['名字 b']), JSON.stringify(badgeOn('single', 'b')))
  // Round-robin rotates every request, so a badge would name a moving fact.
  show(['a', 'b'], 'roundrobin', 'a')
  check('round-robin shows no current badge', !quota(copy(render())).includes('当前'), quota(copy(render())).slice(0, 120))
  // An empty `activeAccount` means "first enabled", not "none".
  check('an empty activeAccount resolves to the first enabled account', JSON.stringify(badgeOn('single', '')) === JSON.stringify(['名字 a']), JSON.stringify(badgeOn('single', '')))

  // ── the usage pill beside the model selector ────────────────────────────────
  //
  // The pill is the only surface that reads the model selection, and the gate is
  // the whole reason it exists: a pill that polled the gateway for every model
  // would spend a request per conversation. Both postures are asserted, plus the
  // reading itself, so neither the gate nor the rendering can regress silently.
  {
    const pillEntry = seen.find((entry) => entry.options.name === 'conversation.input.right')
    const pillProps = propsFor(pillEntry, 'pill-session')
    // The shared stub answers state without a reading, so the pill would render
    // its empty posture. Give this one the shape the host actually returns for
    // `usage`, so the assertions below are about the rendering and not about a
    // stub that never carried the data.
    const pillLimits = [
      { type: 'five_hour', percentUsed: 6, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      { type: 'weekly', percentUsed: 2, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
      { type: 'monthly', percentUsed: 48, resetsAt: new Date(Date.now() + 172_800_000).toISOString() },
    ]
    /**
     * Stand in for the host's `usage` reply.
     *
     * The real read also lands its result in the panel's snapshot, and the pill
     * takes the effective account from there — a switch updates that snapshot at
     * once while a reading only arrives on a timer. A stub that only returned the
     * payload would leave the store naming an account this test never set.
     */
    const replyUsage = (payload) => {
      pillProps.readUsage = async () => {
        const state = store.getSnapshot()
        store.set({ ...state, status: 'ready', data: { ...state.data, ...payload } })
        return payload
      }
    }
    replyUsage({
      effectiveAccount: 'default',
      usage: { fetchedAt: Date.now(), accounts: [{ account: 'default', displayName: 'Cline Pass', ok: true, limits: pillLimits }] },
    })
    /**
     * Render the pill with its effects run, the way the host does.
     *
     * The reading arrives from the RPC inside an effect — the panel's own tests
     * had to do this for the same reason — so a render without running them only
     * ever shows the pre-fetch state.
     */
    /**
     * Render the pill the way the shell does: one pass, run its effects, then a
     * second pass that sees the state those effects set. The bundle-level React
     * table owns that state, so it is reset per render pass here.
     */
    const pillText = async () => {
      // The component reads React from the bundle's own `require('react')`, whose
      // table is this block's `hooks`/`cursor` — not the one `runComponent`
      // returns. Hook state is kept across the two passes so the reading the
      // effect set survives; the cursor restarts so the second pass reads the
      // same slots the first one wrote.
      hooks.length = 0
      cursor = 0
      collectedEffects.length = 0
      coerced = false
      try {
        runComponent(pillEntry.component, { ...pillProps })
      } finally {
        coerced = true
      }
      // The effect arms a 60s interval. Its cleanup is what stops that timer, so
      // it has to be called or the process never exits — and the timer is the
      // same one that would keep polling a mounted pill.
      const cleanups = []
      for (const effect of collectedEffects) {
        const dispose = effect()
        if (typeof dispose === 'function') cleanups.push(dispose)
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (const dispose of cleanups) dispose()
      cursor = 0
      coerced = false
      let second
      try {
        second = runComponent(pillEntry.component, { ...pillProps })
      } finally {
        coerced = true
      }
      cursor = 0
      return collectText(resolveComponents(second.tree)).join(' ')
    }
    // The same session the props were built for, so the store the pill
    // subscribes to is the one this test moves.
    const sessionId = 'pill-session'
    const directory = modelDirectories.directoryFor(sessionId)

    // Another provider's model selected: the pill must render nothing at all.
    directory.set({ current: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } })
    check('the usage pill is absent under another provider', (await pillText()) === '', (await pillText()).slice(0, 80))

    // This provider selected: the pill renders its reading.
    directory.set({ current: { provider: 'cline-pass', model: 'cline-pass/glm-5.3' } })
    const shown = await pillText()
    check('the usage pill renders under this provider', shown.includes('Pass'), shown.slice(0, 160))
    // The collapsed button's OWN text, found by its class. Asserting against the
    // whole rendered tree would pass even if the summary lost a window, because
    // the expanded card names the same windows.
    const summaryText = () => {
      // Keep the hook state the fetch wrote (so the reading is on screen); only
      // restart the cursor, which is what makes this pass read the same slots.
      cursor = 0
      coerced = false
      let tree
      try {
        tree = runComponent(pillEntry.component, { ...pillProps }).tree
      } finally {
        coerced = true
      }
      cursor = 0
      let found = null
      const walk = (node) => {
        if (node === null || node === undefined || typeof node !== 'object' || found !== null) return
        if (Array.isArray(node)) { node.forEach(walk); return }
        if (node.props?.className === 'cp-pill-btn') { found = node; return }
        walk(node.children)
      }
      walk(tree)
      return found === null ? '' : collectText({ ...found, children: found.children }).join('')
    }
    // Populate the reading the way the host does, then read the button alone.
    await pillText()
    const collapsed = summaryText()
    check('the collapsed pill summarises the five-hour and weekly windows',
      collapsed.includes('5 小时 6%') && collapsed.includes('周 2%'), JSON.stringify(collapsed))
    // `chargeUsage` is what the injected face hands the component; the first
    // paint must not have called it, because the effect only runs when the host
    // runs effects and the pill is asserted here before that.
    check('the pill follows the selection rather than a captured value',
      typeof pillEntry.options.inject === 'function' && typeof pillEntry.options.inject(sessionId).route === 'function')

    // The reported bug: with a pool the pill showed the first account that
    // answered rather than the one a request would spend. Quota is per account,
    // so a healthy reading from the wrong key is worse than none — it answers a
    // question about a key that is not about to be used.
    const at = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString()
    /** Two accounts with distinguishable readings, and the host's pick. */
    const poolOf = (effectiveAccount) => ({
      effectiveAccount,
      usage: {
        fetchedAt: Date.now(),
        accounts: [
          { account: 'primary', displayName: 'Primary', ok: true, limits: [
            { type: 'five_hour', percentUsed: 11, resetsAt: at(1) },
            { type: 'weekly', percentUsed: 22, resetsAt: at(24) },
          ] },
          { account: 'backup', displayName: 'Backup', ok: true, limits: [
            { type: 'five_hour', percentUsed: 66, resetsAt: at(1) },
            { type: 'weekly', percentUsed: 77, resetsAt: at(24) },
          ] },
        ],
      },
    })
    replyUsage(poolOf('backup'))
    await pillText()
    const pooled = summaryText()
    check('the pill reads the account a request would use, not the first that answered',
      pooled.includes('66%') && pooled.includes('77%') && !pooled.includes('11%'),
      JSON.stringify(pooled))

    // A pool whose effective account has no readable quota must say so rather
    // than fall back to a healthy account the request will not touch.
    replyUsage({
      effectiveAccount: 'broken',
      usage: {
        fetchedAt: Date.now(),
        accounts: [
          { account: 'primary', displayName: 'Primary', ok: true, limits: [
            { type: 'five_hour', percentUsed: 11, resetsAt: at(1) },
          ] },
          { account: 'broken', displayName: 'Broken', ok: false, limits: [], error: 'no API key stored for broken' },
        ],
      },
    })
    await pillText()
    const brokenPool = summaryText()
    check('the pill does not substitute a different account when the effective one cannot be read',
      !brokenPool.includes('11%'), JSON.stringify(brokenPool))

    replyUsage(poolOf('new-account'))
    await pillText()
    check('the pill never borrows quota when the effective account is absent from its cache',
      !summaryText().includes('%'), summaryText())
    replyUsage(poolOf(''))
    await pillText()
    check('the pill clears cached percentages when no account is effective',
      !summaryText().includes('%'), summaryText())
    replyUsage(poolOf(undefined))
    await pillText()
    check('the pill still supports a host without effectiveAccount',
      summaryText().includes('11%'), summaryText())

    // ── the popover moves between accounts ──────────────────────────────────
    //
    // Quota is per account, so a pool is reviewed one at a time — the same
    // behaviour the settings card has. Without this the pill could only ever show
    // whichever account the host named, and a pool's other accounts were
    // unreachable from the model selector entirely.
    replyUsage(poolOf('primary'))
    /** One render pass, keeping the hook state the previous pass wrote. */
    const pillTree = () => {
      cursor = 0
      coerced = false
      let tree
      try {
        tree = runComponent(pillEntry.component, { ...pillProps }).tree
      } finally {
        coerced = true
      }
      cursor = 0
      return tree
    }
    const findIn = (tree, match) => {
      let found = null
      const walk = (node) => {
        if (node === null || node === undefined || typeof node !== 'object' || found !== null) return
        if (Array.isArray(node)) { node.forEach(walk); return }
        if (match(node)) { found = node; return }
        walk(node.children)
      }
      walk(tree)
      return found
    }
    const pillText2 = () => collectText(resolveComponents(pillTree())).join(' ')

    await pillText()
    // Open it the way a user does, rather than by forcing the disclosure state.
    const opener = findIn(pillTree(), (node) => node.props?.className === 'cp-pill-btn')
    check('the pill offers a disclosure control', opener !== null && typeof opener.props?.onClick === 'function')
    opener?.props?.onClick?.()

    const firstPage = pillText2()
    check('the popover opens on the account a request would use',
      firstPage.includes('Primary') && firstPage.includes('1 / 2') && firstPage.includes('11%'),
      firstPage.slice(0, 200))

    const arrow = (label) => findIn(pillTree(), (node) => node.props?.['aria-label'] === label)
    const nextArrow = arrow('下一个账号')
    check('the popover offers a next-account control', nextArrow !== null && typeof nextArrow.props?.onClick === 'function')
    // Guarded: a missing control must fail its own check rather than throw and
    // hide every assertion after it.
    nextArrow?.props?.onClick?.()
    const secondPage = pillText2()
    check('the popover moves to the next account',
      secondPage.includes('Backup') && secondPage.includes('2 / 2') && secondPage.includes('66%'),
      secondPage.slice(0, 200))

    // The account a request would use moving underneath must not yank the reading
    // off the page the user chose: the host still names `primary`, and the popover
    // has to stay on the account the user turned to.
    const held = pillText2()
    check('a paged popover keeps the page the user chose',
      held.includes('Backup') && held.includes('2 / 2') && held.includes('66%') && !held.includes('Primary'),
      held.slice(0, 200))

    // ── the popover follows an account switched elsewhere ───────────────────
    //
    // Switching accounts is a panel action: it lands in the shared snapshot at
    // once, whereas a usage reading only arrives on mount and on a timer. Taking
    // the account from the reading is what left the popover naming the previous
    // account after the settings card had already moved.
    replyUsage(poolOf('primary'))
    await pillText()
    findIn(pillTree(), (node) => node.props?.className === 'cp-pill-btn')?.props?.onClick?.()
    check('the popover opens on the account the host named',
      pillText2().includes('Primary'), pillText2().slice(0, 160))

    // The settings page switches accounts. No usage read is taken here: the point
    // is that the snapshot alone has to carry it.
    const switchedFrom = store.getSnapshot()
    store.set({ ...switchedFrom, data: { ...switchedFrom.data, effectiveAccount: 'backup' } })
    const switched = pillText2()
    check('the popover follows an account switched in the settings page',
      switched.includes('Backup') && switched.includes('66%') && !switched.includes('Primary'),
      switched.slice(0, 200))

    // Closing forgets the page, so reopening after a switch shows the account a
    // request would use rather than the page left behind.
    replyUsage(poolOf('primary'))
    await pillText()
    const clickPill = () => findIn(pillTree(), (node) => node.props?.className === 'cp-pill-btn')?.props?.onClick?.()
    /** Run the effects a render registered, the way the host does after paint. */
    const runEffects = async () => {
      collectedEffects.length = 0
      pillTree()
      const cleanups = []
      for (const effect of collectedEffects) {
        const dispose = effect()
        if (typeof dispose === 'function') cleanups.push(dispose)
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (const dispose of cleanups) dispose()
    }
    clickPill()
    findIn(pillTree(), (node) => node.props?.['aria-label'] === '下一个账号')?.props?.onClick?.()
    check('the popover can be moved before it is closed',
      pillText2().includes('Backup') && pillText2().includes('2 / 2'), pillText2().slice(0, 160))
    clickPill()
    await runEffects()
    clickPill()
    const reopened = pillText2()
    check('reopening returns to the account a request would use',
      reopened.includes('Primary') && reopened.includes('1 / 2') && !reopened.includes('Backup'),
      reopened.slice(0, 200))

    // A setting change arrives before the next usage poll. Even if that poll
    // fails, the retained successful cache belongs to the old account.
    const cachedState = store.getSnapshot()
    store.set({ ...cachedState, data: { ...cachedState.data, effectiveAccount: 'new-account' } })
    check('a panel-only account switch immediately clears unrelated cached percentages',
      !summaryText().includes('%'), summaryText())
    pillProps.readUsage = async () => { throw new Error('usage unavailable') }
    await runEffects()
    const failedRefresh = pillText2()
    check('a failed usage poll cannot restore a different account\'s cached quota',
      !summaryText().includes('%') && failedRefresh.includes('用量不可用') && !failedRefresh.includes('Primary'), failedRefresh)
    store.set({ ...cachedState, data: { ...cachedState.data, effectiveAccount: '' } })
    check('disabling all accounts clears retained quota even after a failed poll',
      !summaryText().includes('%'), summaryText())

  }


  store.set(snapshot)
}

// ── the registration face is live, not a snapshot ───────────────────────────

const faceRegistration = registrations.find((registration) => registration.options.name === 'settings.section')
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
