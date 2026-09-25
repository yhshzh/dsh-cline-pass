/**
 * dsh-cline-pass — a self-contained Cline Pass provider for the DeepSeek
 * Harness. It registers on the host plane:
 *
 * 1. One LLM provider route (default `cline-pass`), served by
 *    {@link ClinePassAdapter}.
 * 2. A configurable-provider directory entry for that route.
 * 3. The `cline_pass_*` tools, and the setup panel's host half.
 *
 * Configuration lives in the `cline-pass` settings section, so it survives
 * restarts and reloads live. API keys never go there: accounts name a
 * credential reference resolved per request through the credential seam.
 *
 * Routing behavior reimplements the MIT-licensed cline-pass-switcher findings.
 *
 * @module dsh-cline-pass
 */
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { assertUsableApiKey, errorChain, LlmError } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  ClinePassAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REQUEST_IMAGE_POLICY,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.js'
import { catalogEntry, MODEL_CATALOG, REASONING_EFFORTS } from './catalog.js'
import { installLiveSection, liveConfigReader, markVolatile, resolveLiveRefs, updateLiveSection } from './compat.js'
import { createEngine } from './engine.js'
import { createPanel, PANEL_PATH, registerPanel } from './panel.js'
import { BUILD_TAG } from './protocol.js'
import { createStore } from './store.js'
import { registerTools } from './tools.js'

export { ClinePassAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_CONCURRENT_REQUESTS, DEFAULT_MAX_TOKENS, DEFAULT_REQUEST_IMAGE_POLICY, DEFAULT_STREAM_IDLE_TIMEOUT_MS }
export { collectImageRefs, prepareRequestImages, projectImageDimensions, requestImageTarget } from './adapter.js'
export { MODEL_CATALOG, REASONING_EFFORTS } from './catalog.js'
export { createEngine } from './engine.js'
export { createPanel, PANEL_PATH, registerPanel } from './panel.js'
export { createStore } from './store.js'
export { BUILD_TAG, buildAttempts, CHANNEL_ALIASES, channelNameFor, injectPrefs, isAdherenceOk, normalizePinMode, parseRouting, pinAdherence, pinWarnings } from './protocol.js'

/** Stable Loader identity. */
export const name = 'cline-pass'

/** The LLM seam and the host tool registry. */
export const inject = ['llm', 'tools']

/** The settings namespace this plugin owns. */
export const DEFAULT_SETTINGS_NS = 'cline-pass'

/** The provider route registered when configuration names none. */
export const DEFAULT_PROVIDER = 'cline-pass'

/** The credential name used when no account declares one. */
export const DEFAULT_API_KEY_ENV = 'CLINE_PASS_API_KEY'

/** Cline Pass subscription models current at release time; refreshed on demand. */
export const DEFAULT_MODELS = [
  'cline-pass/glm-5.3-flash',
  'cline-pass/kimi-k3',
  'cline-pass/deepseek-v4-flash',
  'cline-pass/deepseek-v4.1-flash',
  'cline-pass/qwen3.8-max',
  'cline-pass/minimax-m3',
  'cline-pass/glm-5.3',
  'cline-pass/glm-5.2',
  'cline-pass/deepseek-v4-pro',
  'cline-pass/mimo-v2.5-pro',
  'cline-pass/mimo-v2.5',
  'cline-pass/kimi-k2.6',
  'cline-pass/qwen3.7-plus',
  'cline-pass/kimi-k2.7-code',
  'cline-pass/qwen3.7-max',
]

/** One Cline Pass account: a credential reference plus routing participation. */
export const AccountProfile = z.object({
  displayName: z.string().default(''),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  enabled: z.boolean().default(true),
  baseURL: z.string().default(''),
})

/** One model's catalog override, merged over the published metadata. */
export const ModelProfile = z.object({
  name: z.string().default(''),
  contextWindow: z.number().default(0),
  maxTokens: z.number().default(0),
  reasoning: z.union([z.boolean(), z.const(undefined)]).default(undefined),
  input: z.array(z.string()).default([]),
})

/** One model's upstream pin. */
export const PinProfile = z.object({
  upstreams: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  pinMode: z.string().default('strict'),
  sort: z.string().default(''),
})

/**
 * Validated plugin configuration (this plugin's settings section).
 *
 * The fields the panel writes are marked live through {@link markVolatile}, so
 * a save reaches the next request without a remount. From dsh 0.1.6 the
 * settings service refuses every write to an entry with no volatile field
 * (`Plugin entry "…" has no volatile fields`), which reads as "the buttons do
 * nothing"; on 0.1.5 the marking is a no-op. It must be applied per field — a
 * `.volatile()` on the enclosing object collapses the schema to `{}` and drops
 * every default with it.
 */
export const Config = z.object({
  provider: z.string().default(DEFAULT_PROVIDER),
  displayName: z.string().default('Cline Pass'),
  baseURL: z.string().default('https://api.cline.bot/api/v1'),
  apiKeyEnv: markVolatile(z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV)),
  accounts: markVolatile(z.dict(AccountProfile).default({})),
  accountMode: markVolatile(z.string().default('single')),
  activeAccount: markVolatile(z.string().default('')),
  knownModels: markVolatile(z.array(z.string()).default(DEFAULT_MODELS)),
  /**
   * Subscription models the route does NOT advertise.
   *
   * Listing a model everywhere the provider is offered — the model picker,
   * subagent allow-lists, the web Models page — is what a subscription model
   * gets by default. Subtracting here is the one place that hides it, so the
   * plugin still knows the model (and can un-hide it) while no picker offers it.
   */
  hiddenModels: markVolatile(z.array(z.string()).default([])),
  models: markVolatile(z.dict(ModelProfile).default({})),
  perModel: markVolatile(z.dict(PinProfile).default({})),
  reasoningModels: z.boolean().default(true),
  defaultContextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  /**
   * Streams one account may keep open to the gateway at once.
   *
   * A request past the cap waits for a slot (and can still be cancelled while it
   * waits) instead of opening another stream. `0` lifts the cap.
   */
  maxConcurrentRequests: z.number().default(DEFAULT_MAX_CONCURRENT_REQUESTS),
  exposeCatalog: z.boolean().default(false),
  historyLimit: z.number().default(100),
  /**
   * Which pin spellings a request carries.
   *
   * `both` (the default) writes the top-level `provider.*` and the nested
   * `providerOptions.gateway.*` form, because the pipeline a model runs on is
   * decided by the gateway and can differ between calls: writing only the one a
   * probe last observed means the pin disappears whenever that changes. Anything
   * other than the literal `detected` keeps the two-spelling behavior.
   */
  pinSpelling: z.string().default('both'),
})

/** Redact a secret, keeping just enough to recognize it. */
function maskKey(value) {
  const key = String(value ?? '')
  if (key.length === 0) return ''
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/**
 * Register the Cline Pass provider on the harness LLM seam, expose its
 * management tools, and publish its setup panel.
 *
 * @param ctx - host plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const store = createStore({ historyLimit: config.historyLimit })
  // Where the host has live config fields it hands those to `apply()` as
  // reference objects and commits each write into them, so they are read at
  // call time; where the settings service owns the values it swaps a fresh
  // source in through `setSource` below. Both end up behind this one thunk.
  let liveConfig = resolveLiveRefs(config)
  let current = liveConfigReader(config)
  const live = () => current()

  // ── account pool ──────────────────────────────────────────────────────────

  let roundRobin = 0

  /**
   * Accounts that just refused a request, and until when they are stood down.
   *
   * A pool is supposed to behave like one account with a combined quota, which
   * only holds if the router stops picking an account that already said no. The
   * cooldown is deliberately coarse — a spent window resets on its own schedule
   * and an auth failure needs a human — because it only has to outlast the
   * requests that would otherwise rediscover it.
   */
  const cooling = new Map()

  /**
   * How long one failure keeps an account out of the pool.
   *
   * Only the two account-level refusals are listed: a transient 429 is answered
   * by the channel retry already, and standing an account down for it would cost
   * capacity the request never proved was gone.
   */
  const COOLDOWN_MS = { QUOTA_EXCEEDED: 15 * 60_000, AUTH: 30 * 60_000 }

  /**
   * Resolve the configured accounts.
   *
   * An empty `accounts` dictionary means one implicit account on the top-level
   * fields, so a fresh install works as soon as `CLINE_PASS_API_KEY` exists.
   */
  const accountProfiles = () => {
    const cfg = live()
    const declared = Object.entries(cfg.accounts ?? {})
    if (declared.length === 0) {
      return [['default', {
        displayName: cfg.displayName,
        apiKeyEnv: credentialRef(cfg.apiKeyEnv),
        enabled: true,
        baseURL: cfg.baseURL,
      }]]
    }
    return declared.map(([key, profile]) => [key, {
      displayName: String(profile?.displayName ?? '') || key,
      apiKeyEnv: credentialRef(profile?.apiKeyEnv || cfg.apiKeyEnv),
      enabled: profile?.enabled !== false,
      baseURL: String(profile?.baseURL ?? '') || cfg.baseURL,
    }])
  }

  /**
   * Resolve one credential reference through the credential seam, falling back
   * to the launching environment when no credentials service is composed.
   * @returns the key value, or undefined when nothing is stored.
   */
  const resolveKey = async (ref) => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      const value = hit?.value
      return value !== undefined && String(value).length > 0 ? String(value) : undefined
    }
    const ambient = launchEnvironmentOf(ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }

  /** Pick the account for the next request and resolve its key. */
  const resolveAccount = async ({ exclude = [] } = {}) => {
    const cfg = live()
    const skip = new Set(exclude.map(String))
    const enabled = accountProfiles().filter(([, profile]) => profile.enabled)
    if (enabled.length === 0) {
      throw new LlmError('cline-pass: every configured account is disabled; enable one or add another', 'MISSING_CREDENTIAL')
    }
    // Accounts that just refused a request are stood down for a while, so a pool
    // does not spend one failed round trip per call rediscovering the same
    // exhausted key. When every candidate is cooling the oldest one is used
    // anyway: a window can reset, and refusing to try at all would be worse.
    const now = Date.now()
    const eligible = enabled.filter(([key]) => !skip.has(key) && (cooling.get(key) ?? 0) <= now)
    const pool = eligible.length > 0
      ? eligible
      : enabled.filter(([key]) => !skip.has(key))
    if (pool.length === 0) return undefined
    const ordered = eligible.length > 0
      ? pool
      : [...pool].sort((left, right) => (cooling.get(left[0]) ?? 0) - (cooling.get(right[0]) ?? 0))
    let picked
    if (cfg.accountMode === 'roundrobin' && ordered.length > 1) {
      picked = ordered[roundRobin % ordered.length]
      roundRobin = (roundRobin + 1) % 1000000000
    } else {
      picked = ordered.find(([key]) => key === cfg.activeAccount) ?? ordered[0]
    }
    const [key, profile] = picked
    const value = await resolveKey(profile.apiKeyEnv)
    if (value === undefined) {
      throw new LlmError(
        `cline-pass: no API key for account "${key}"; store it at ${profile.apiKeyEnv} (cline_pass_accounts action="add" name=${key} key=… writes it, or use the dsh Models page), or export ${profile.apiKeyEnv} in the launching environment`,
        'MISSING_CREDENTIAL',
      )
    }
    return { name: key, key: assertUsableApiKey(value, 'cline-pass', profile.apiKeyEnv), baseURL: profile.baseURL }
  }

  // ── connection facts ──────────────────────────────────────────────────────

  /**
   * The account a management call should speak for: the same pick as
   * {@link resolveAccount} but without advancing the round-robin cursor, because
   * reading quota is not a request that consumes it.
   */
  /**
   * Every enabled account a management call can speak for, with its key resolved.
   *
   * Quota is PER ACCOUNT — each one has its own windows, and possibly its own
   * plan — so a reading has to name the account it belongs to. In round-robin
   * mode no single account represents the pool, which is why this returns all of
   * them rather than picking one. An account with no stored key is reported with
   * the reason instead of being dropped: "not configured" is exactly what the
   * panel needs to be able to say about it.
   */
  const usageAccounts = async () => {
    const cfg = live()
    const enabled = accountProfiles().filter(([, profile]) => profile.enabled)
    return await Promise.all(enabled.map(async ([name, profile]) => {
      const key = await resolveKey(profile.apiKeyEnv).catch(() => undefined)
      return {
        name,
        // The name a person recognizes, for the panel's account switcher.
        displayName: profile.displayName,
        key: key ?? '',
        keyConfigured: key !== undefined,
        baseURL: profile.baseURL || cfg.baseURL,
      }
    }))
  }

  /** The model ids the route advertises: configured, plus the catalog when asked. */
  const modelIds = () => {
    const cfg = live()
    const hidden = new Set((cfg.hiddenModels ?? []).map(String))
    const ids = (cfg.knownModels ?? []).map(String)
    if (cfg.exposeCatalog === true) {
      for (const id of store.catalog().ids ?? []) if (!ids.includes(id)) ids.push(String(id))
    }
    return ids.filter((id) => !hidden.has(id))
  }

  const connection = () => {
    const cfg = live()
    return {
      baseURL: cfg.baseURL,
      displayName: cfg.displayName,
      models: modelIds().map((id) => {
        const entry = catalogEntry(id) ?? {}
        const override = cfg.models?.[id] ?? {}
        return {
          id,
          name: override.name || entry.name || id.replace(/^cline-pass\//, ''),
          contextWindow: override.contextWindow || entry.contextWindow,
          maxTokens: override.maxTokens || entry.maxTokens,
          reasoning: override.reasoning ?? entry.reasoning,
          input: override.input?.length ? override.input : entry.input,
        }
      }),
      defaultContextWindow: cfg.defaultContextWindow,
      maxTokens: cfg.defaultMaxTokens,
      reasoningModels: cfg.reasoningModels,
      streamIdleTimeoutMs: cfg.streamIdleTimeoutMs,
      maxConcurrentRequests: cfg.maxConcurrentRequests,
    }
  }

  /**
   * Best context-window guess for one model: the largest window OpenRouter
   * reports for its endpoints, when a probe has seen them.
   */
  const discoveredContext = (model) => {
    const detail = store.metaOf(model)?.upstreamDetail ?? {}
    let max = 0
    for (const entry of Object.values(detail)) max = Math.max(max, Number(entry?.context ?? 0))
    return max > 0 ? max : undefined
  }

  /**
   * What the last official catalog scan published about one model.
   *
   * The shipped table only knows the models that existed when this release was
   * cut, so a model added afterwards would otherwise be described by the
   * fallback alone — selectable and chat-capable, but declared text-only, which
   * makes the harness refuse its images with no explanation.
   */
  const publishedModel = (model) => store.catalog()?.models?.[model] ?? {}

  // ── engine + adapter ──────────────────────────────────────────────────────

  /**
   * The pin profile the router sees: the stored per-model configuration plus the
   * route-wide spelling policy. Built here so every consumer — live traffic,
   * `cline_pass_test` and the panel — sends the identical pin.
   */
  const pinFor = (model) => ({ ...(live().perModel?.[model] ?? {}), spelling: live().pinSpelling })

  const engine = createEngine({
    resolveAccount,
    store,
    logger: ctx.logger,
    attemptTimeoutMs: 180000,
    probeTimeoutMs: 60000,
  })
  engine.setPinReader(pinFor)

  const adapter = new ClinePassAdapter({
    connection,
    modelMeta: (model) => store.metaOf(model),
    pin: pinFor,
    resolveAccount,
    discoveredContext,
    // What the last official scan published, so a model newer than this release
    // is described by its real modalities instead of the text fallback.
    publishedModel,
    // Images reach an adapter as durable attachment references, never as bytes,
    // so the adapter resolves them through the attachment service per request.
    // Resolved lazily: a text-only call must not require that service.
    resolveAttachments: () => ctx.get('attachments'),
    // One request's own report, which is also where a pool learns that an
    // account just refused it: the failure code is what decides the cooldown.
    record: (model, info) => {
      store.record({ model, ...info })
      const code = String(info?.code ?? '')
      const account = String(info?.account ?? '')
      const wait = COOLDOWN_MS[code]
      if (account === '' || wait === undefined || info?.error === undefined || info?.error === null || info?.error === '') return
      cooling.set(account, Date.now() + wait)
      ctx.logger?.warn('[cline-pass] account "%s" stood down for %ds after %s; the pool will use another account', account, Math.round(wait / 1000), code)
    },
    learnUpstream: (model, upstream, status, note, ms) => store.learnUpstream(model, upstream, status, note, ms),
  })

  const provider = String(config.provider ?? '').trim() || DEFAULT_PROVIDER
  if (config.provider !== provider) {
    throw new LlmError('cline-pass: `provider` must be a non-empty route name', 'INVALID_ADAPTER')
  }
  ctx.llm.registerAdapter([provider], adapter)

  // The directory entry is what makes the web Models page treat this settings
  // namespace as the configuration of this route; a conflict here is cosmetic
  // and must not take the route down with it.
  try {
    ctx.llm.registerConfigurableProviders([{
      provider,
      displayName: config.displayName,
      settingsNs: DEFAULT_SETTINGS_NS,
      settingsPath: [],
    }])
  } catch (error) {
    ctx.logger?.warn('[cline-pass] configurable-provider directory entry refused: %s', errorChain(error))
  }

  // ── configuration surface ─────────────────────────────────────────────────

  /**
   * Persist one shallow patch into this plugin's settings section.
   *
   * `removals` names the key paths this patch deletes. The settings service
   * merges a patch recursively, so omitting a key does not remove it — writing
   * an `accounts` object without a deleted account merges that account straight
   * back — and an explicit unset is the only edit that removes it.
   *
   * Without a settings service the patch is applied in memory, which keeps the
   * session working but does not survive a restart.
   *
   * @param patch - fields to merge.
   * @param removals - key paths to delete, e.g. `[['accounts', 'test']]`.
   */
  const updateConfig = async (patch, removals = []) => {
    const settings = ctx.get('settings')
    if (settings === undefined) {
      const next = { ...liveConfig, ...patch }
      for (const path of removals) {
        if (path.length === 1) delete next[path[0]]
        else if (path.length === 2 && next[path[0]] !== undefined) delete next[path[0]][path[1]]
      }
      liveConfig = next
      return
    }
    await updateLiveSection(settings, DEFAULT_SETTINGS_NS, patch, removals)
  }

  ctx.inject(['settings'], (settingsCtx) => {
    installLiveSection(settingsCtx.settings, ctx, DEFAULT_SETTINGS_NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      // Every consumer reads the live config through a thunk, so a settings
      // change reaches the next request with nothing to re-register.
      onChange: () => {},
    })
  })

  // ── catalog ───────────────────────────────────────────────────────────────

  /** Rescan the official subscription list and adopt models that are new. */
  const refreshCatalog = async () => {
    const scan = await engine.officialModels({})
    const cfg = live()
    const currentModels = (cfg.knownModels ?? []).map(String)
    const added = scan.models.filter((id) => !currentModels.includes(id))
    if (added.length > 0) await updateConfig({ knownModels: [...currentModels, ...added] })
    store.setCatalog({
      ids: [...new Set([...scan.models, ...(cfg.exposeCatalog === true ? await engine.gatewayCatalog({}).catch(() => []) : [])])],
      // What each source published about the model: this is what tells the seam
      // a newly listed model reads images, instead of leaving it on the `text`
      // fallback and silently refusing every picture for it.
      models: scan.catalog ?? {},
      sources: scan.sources,
    })
    return { added, models: scan.models, sources: scan.sources }
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  // One control surface serves both faces of the configuration: the
  // `cline_pass_*` tools an agent calls, and the browser setup panel. Sharing
  // it is what keeps the two from ever disagreeing about what is configured.
  const control = {
    providerName: provider,
    displayName: config.displayName,
    settingsAvailable: () => ctx.get('settings') !== undefined,
    routeRegistered: () => true,
    readConfig: () => live(),
    updateConfig,
    accounts: () => accountProfiles().map(([key, profile]) => ({
      key,
      displayName: profile.displayName,
      apiKeyEnv: String(profile.apiKeyEnv),
      enabled: profile.enabled,
      baseURL: profile.baseURL,
    })),
    accountsWithKeys: async () => await Promise.all(accountProfiles().map(async ([key, profile]) => {
      const value = await resolveKey(profile.apiKeyEnv).catch(() => undefined)
      return {
        key,
        displayName: profile.displayName,
        apiKeyEnv: String(profile.apiKeyEnv),
        enabled: profile.enabled,
        keyConfigured: value !== undefined,
        keyHint: maskKey(value),
      }
    })),
    readCredential: async (ref) => (await resolveKey(credentialRef(ref))) ?? '',
    usageAccounts,
    setCredential: async (ref, value) => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) {
        throw new Error('the dsh credentials service is unavailable, so the key cannot be stored; set the environment variable instead')
      }
      await credentials.set(credentialRef(ref), String(value))
    },
    refreshCatalog,
  }

  registerTools(ctx, { store, engine, control })

  // The same surface as an ordinary browser page, for users who would rather
  // click than compose a tool call. Absent in a headless composition.
  try {
    registerPanel(ctx, { control, engine, store, logger: ctx.logger })
  } catch (error) {
    ctx.logger?.warn('[cline-pass] setup panel unavailable (the tools still work): %s', errorChain(error))
  }

  // Keep the provider directory honest without adopting anything: an explicit
  // `cline_pass_models refresh` is what changes the model list.
  void refreshCatalog().catch((error) => {
    ctx.logger?.warn('[cline-pass] initial catalog scan failed (models stay on the configured list): %s', errorChain(error))
  })

  ctx.logger?.info('[cline-pass] provider route "%s" registered with %d model(s) (build %s)', provider, modelIds().length, BUILD_TAG)
}
