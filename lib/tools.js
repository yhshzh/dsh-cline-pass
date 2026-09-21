/**
 * The model-facing `cline_pass_*` management tools.
 *
 * They read and write the same settings section the provider runs from, so a
 * pin written here takes effect on the very next model call.
 *
 * @module dsh-cline-pass/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BUILD_TAG, normalizePinMode, pinWarnings } from './protocol.js'

/** One model-facing text block. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** Collapse a value into one display line. */
function firstLine(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Human label for one upstream availability verdict. */
const STATUS_LABEL = {
  ok: 'available',
  limited: 'rate-limited',
  bad: 'not-pinnable',
  auth: 'auth-failed',
  // A channel that answered while a different one served the request. It is its
  // own verdict precisely because "available" used to be claimed for it.
  'not-adopted': 'not-adopted',
  unknown: 'unknown',
}

const statusLabel = (status) => STATUS_LABEL[status] ?? String(status ?? 'unknown')

const ACCOUNT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true },
    displayName: { type: 'string', required: true },
    apiKeyEnv: { type: 'string', required: true },
    enabled: { type: 'boolean', required: true },
    keyConfigured: { type: 'boolean', required: true },
    keyHint: { type: 'string', required: true },
  },
}

const TRACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    upstream: { type: 'string', required: true },
    status: { type: 'integer', required: true },
    ms: { type: 'integer', required: true },
    note: { type: 'string', required: true },
  },
}

const UPSTREAM_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    upstream: { type: 'string', required: true },
    status: { type: 'string', required: true },
    ms: { type: 'integer', required: true },
    note: { type: 'string', required: true },
    checkedAt: { type: 'integer', required: true },
  },
}

const MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    displayName: { type: 'string', required: true },
    pipeline: { type: 'string', required: true },
    pinnable: { type: 'boolean', required: true },
    pinMode: { type: 'string', required: true },
    sort: { type: 'string', required: true },
    pinned: { type: 'array', required: true, items: { type: 'string' } },
    excluded: { type: 'array', required: true, items: { type: 'string' } },
    upstreams: { type: 'array', required: true, items: { type: 'string' } },
    upstreamStatus: { type: 'array', required: true, items: UPSTREAM_STATUS_SCHEMA },
    lastProvider: { type: 'string', required: true },
    lastMs: { type: 'integer', required: true },
    probedAt: { type: 'integer', required: true },
    validatedAt: { type: 'integer', required: true },
  },
}

/** Project one model from the live configuration plus what the store observed. */
function projectModel(model, pin, meta) {
  const upstreamStatus = Object.entries(meta?.upstreamStatus ?? {}).map(([upstream, verdict]) => ({
    upstream: String(upstream),
    status: String(verdict?.status ?? 'unknown'),
    ms: Number(verdict?.ms ?? 0),
    note: firstLine(verdict?.note, 160),
    checkedAt: Number(verdict?.checkedAt ?? 0),
  }))
  return {
    id: String(model),
    displayName: String(model).replace(/^cline-pass\//, ''),
    pipeline: String(meta?.pipeline ?? ''),
    pinnable: meta?.pinnable === true,
    // The executed mode, not a second opinion about it: `buildAttempts` reads
    // the same normalizer, so what this shows is what a request will do.
    pinMode: normalizePinMode(pin?.pinMode),
    sort: String(pin?.sort ?? ''),
    pinned: Array.isArray(pin?.upstreams) ? pin.upstreams.map(String) : [],
    excluded: Array.isArray(pin?.exclude) ? pin.exclude.map(String) : [],
    upstreams: Array.isArray(meta?.upstreams) ? meta.upstreams.map(String) : [],
    upstreamStatus,
    lastProvider: String(meta?.lastProvider ?? ''),
    lastMs: Number(meta?.lastMs ?? 0),
    probedAt: Number(meta?.probedAt ?? 0),
    validatedAt: Number(meta?.validatedAt ?? 0),
  }
}

/**
 * Register every `cline_pass_*` tool.
 *
 * @param ctx - host plugin context (must own `tools`).
 * @param control - the plugin's configuration surface.
 * @param engine - the Cline Pass engine.
 * @param store - the observation store.
 */
export function registerTools(ctx, { control, engine, store }) {
  const readConfig = () => control.readConfig()
  const pinOf = (model) => readConfig().perModel?.[model] ?? {}

  // ── cline_pass_status ─────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'cline_pass_status',
    description: 'Report the Cline Pass provider state: route, accounts and whether each key is stored, account mode, model and pin counts. Read-only and free. Check this first when a Cline Pass model fails.',
    parameters: {},
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          displayName: { type: 'string', required: true },
          baseURL: { type: 'string', required: true },
          routeRegistered: { type: 'boolean', required: true },
          settingsAvailable: { type: 'boolean', required: true },
          accountMode: { type: 'string', required: true },
          activeAccount: { type: 'string', required: true },
          accounts: { type: 'array', required: true, items: ACCOUNT_SCHEMA },
          knownModels: { type: 'integer', required: true },
          pinnedModels: { type: 'integer', required: true },
          probedModels: { type: 'integer', required: true },
          build: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const rows = value.accounts.map((account) => `  ${account.key}${account.enabled ? '' : ' (disabled)'} key=${account.keyConfigured ? account.keyHint : 'NOT SET'} ref=${account.apiKeyEnv}`)
        return text([
          `${value.displayName} provider "${value.provider}" @ ${value.baseURL}`,
          `route registered=${value.routeRegistered} settings=${value.settingsAvailable ? 'available' : 'UNAVAILABLE (configuration cannot persist)'} build=${value.build}`,
          `accountMode=${value.accountMode} active=${value.activeAccount || '(first enabled)'}`,
          `accounts (${value.accounts.length}):`,
          ...rows,
          `models: known=${value.knownModels} pinned=${value.pinnedModels} probed=${value.probedModels}`,
        ].join('\n'))
      },
    },
    async execute() {
      const config = readConfig()
      const accounts = await control.accountsWithKeys()
      return {
        provider: control.providerName,
        displayName: control.displayName,
        baseURL: config.baseURL,
        routeRegistered: control.routeRegistered(),
        settingsAvailable: control.settingsAvailable(),
        accountMode: config.accountMode === 'roundrobin' ? 'roundrobin' : 'single',
        activeAccount: String(config.activeAccount ?? ''),
        accounts,
        knownModels: (config.knownModels ?? []).length,
        pinnedModels: Object.values(config.perModel ?? {}).filter((pin) => Array.isArray(pin?.upstreams) && pin.upstreams.length > 0).length,
        probedModels: store.allMeta().filter((meta) => meta.pipeline !== undefined && meta.pipeline !== null).length,
        build: BUILD_TAG,
      }
    },
  }))

  // ── cline_pass_models ─────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'cline_pass_models',
    description: 'List the Cline Pass models with their pipeline, discovered channels, per-channel verdicts and stored pin. Pass `model` to filter by substring, `refresh: true` to rescan the official model list. Free unless `refresh` is set.',
    parameters: {
      model: { type: 'string', description: 'Only return models whose id contains this text, e.g. "glm-5.2".' },
      refresh: { type: 'boolean', description: 'Rescan the official model list first and adopt new ids.' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          models: { type: 'array', required: true, items: MODEL_SCHEMA },
          catalogCount: { type: 'integer', required: true },
          catalogSources: { type: 'array', required: true, items: { type: 'string' } },
          catalogFetchedAt: { type: 'integer', required: true },
          added: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const blocks = value.models.map((model) => {
          const lines = [
            `${model.id}  pipeline=${model.pipeline || 'unknown'}${model.pinnable ? '' : ' (not pinnable)'}`,
            `  pinned=${model.pinned.length === 0 ? '(auto)' : model.pinned.join(' > ')} mode=${model.pinMode}${model.sort === '' ? '' : ` sort=${model.sort}`}${model.excluded.length === 0 ? '' : ` excluded=${model.excluded.join(',')}`}`,
          ]
          if (model.upstreams.length > 0) {
            const verdicts = new Map(model.upstreamStatus.map((entry) => [entry.upstream, entry.status]))
            lines.push(`  upstreams: ${model.upstreams.map((upstream) => `${upstream}[${statusLabel(verdicts.get(upstream) ?? 'unknown')}]`).join(' ')}`)
          } else {
            lines.push('  upstreams: (unknown — run cline_pass_probe for this model)')
          }
          if (model.lastProvider !== '') lines.push(`  last=${model.lastProvider} (${model.lastMs}ms)`)
          return lines.join('\n')
        })
        const head = `${value.models.length} Cline Pass model(s); official catalog=${value.catalogCount}${value.catalogSources.length === 0 ? '' : ` via ${value.catalogSources.join(',')}`}`
        const added = value.added.length === 0 ? [] : [`newly adopted: ${value.added.join(', ')}`]
        return text([head, ...added, ...blocks].join('\n\n'))
      },
    },
    async execute(args) {
      const config = readConfig()
      let added = []
      let catalog = store.catalog()
      if (args.refresh === true) {
        const scan = await control.refreshCatalog()
        added = scan.added
        catalog = store.catalog()
      }
      const needle = String(args.model ?? '').trim().toLowerCase()
      const models = (config.knownModels ?? [])
        .filter((id) => needle === '' || String(id).toLowerCase().includes(needle))
        .map((id) => projectModel(id, pinOf(id), store.metaOf(id)))
      return {
        models,
        catalogCount: catalog.ids?.length ?? 0,
        catalogSources: (catalog.sources ?? []).map(String),
        catalogFetchedAt: Number(catalog.fetchedAt ?? 0),
        added,
      }
    },
  }))

  // ── cline_pass_probe ──────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'cline_pass_probe',
    description: 'Detect how one model is routed and harvest its pinnable upstream channels, with one tiny real request. Run it before pinning, and again when a pin that used to work stops working.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id, e.g. "cline-pass/glm-5.2".' },
    },
    timeoutMs: 600000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          error: { type: 'string', required: true },
          ms: { type: 'integer', required: true },
          pipeline: { type: 'string', required: true },
          pinnable: { type: 'boolean', required: true },
          canonicalSlug: { type: 'string', required: true },
          lastProvider: { type: 'string', required: true },
          upstreams: { type: 'array', required: true, items: { type: 'string' } },
          availableProviders: { type: 'array', required: true, items: { type: 'string' } },
          tier0: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return text(`probe ${value.model} failed: ${value.error}`)
        return text([
          `probe ${value.model}: ok in ${value.ms}ms`,
          `pipeline=${value.pipeline} pinnable=${value.pinnable} canonicalSlug=${value.canonicalSlug || '-'} lastProvider=${value.lastProvider || '-'}`,
          value.upstreams.length === 0 ? 'upstreams: (none discovered)' : `upstreams (${value.upstreams.length}): ${value.upstreams.join(', ')}`,
          value.tier0.length === 0 ? '' : `tier0: ${value.tier0.join(', ')}`,
        ].filter((line) => line !== '').join('\n'))
      },
    },
    async execute(args, exec) {
      const model = String(args.model).trim()
      const result = await engine.probe(model, { signal: exec.signal })
      if (result.ok !== true) {
        return { ok: false, model, error: firstLine(result.error, 400), ms: Number(result.ms ?? 0), pipeline: '', pinnable: false, canonicalSlug: '', lastProvider: '', upstreams: [], availableProviders: [], tier0: [] }
      }
      return {
        ok: true,
        model,
        error: '',
        ms: Number(result.ms ?? 0),
        pipeline: String(result.pipeline ?? ''),
        pinnable: result.pinnable === true,
        canonicalSlug: String(result.canonicalSlug ?? ''),
        lastProvider: String(result.lastProvider ?? ''),
        upstreams: (result.upstreams ?? []).map(String),
        availableProviders: (result.availableProviders ?? []).map(String),
        tier0: (result.tier0 ?? []).map(String),
      }
    },
  }))

  // ── cline_pass_validate ───────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'cline_pass_validate',
    description: 'Test every known channel of one model, one tiny real request each, and report a verdict per channel: available, rate-limited, not-pinnable, or auth-failed. This is the ground truth behind a pin. Probe the model first so its channel list exists.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id, e.g. "cline-pass/glm-5.2".' },
    },
    timeoutMs: 1800000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          error: { type: 'string', required: true },
          summary: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              ok: { type: 'integer', required: true },
              limited: { type: 'integer', required: true },
              bad: { type: 'integer', required: true },
              auth: { type: 'integer', required: true },
              unknown: { type: 'integer', required: true },
            },
          },
          upstreams: { type: 'array', required: true, items: { type: 'string' } },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                upstream: { type: 'string', required: true },
                status: { type: 'string', required: true },
                ms: { type: 'integer', required: true },
                note: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return text(`validate ${value.model} failed: ${value.error}`)
        const rows = [...value.results]
          .sort((a, b) => Number(a.status !== 'ok') - Number(b.status !== 'ok'))
          .map((entry) => `${entry.upstream}: ${statusLabel(entry.status)} (${entry.ms}ms)${entry.note === '' ? '' : ` — ${entry.note}`}`)
        return text([
          `validate ${value.model}: ${value.results.length} upstream(s)`,
          `available=${value.summary.ok} rate-limited=${value.summary.limited} not-pinnable=${value.summary.bad} auth-failed=${value.summary.auth} unknown=${value.summary.unknown}`,
          ...rows,
        ].join('\n'))
      },
    },
    async execute(args, exec) {
      const model = String(args.model).trim()
      const meta = store.metaOf(model)
      if (!Array.isArray(meta.upstreams) || meta.upstreams.length === 0) {
        return {
          ok: false,
          model,
          error: 'no known upstream channels: run cline_pass_probe for this model first',
          summary: { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 },
          upstreams: [],
          results: [],
        }
      }
      const outcome = await engine.validate(model, { signal: exec.signal })
      return {
        ok: true,
        model,
        error: '',
        summary: outcome.summary,
        upstreams: (store.metaOf(model).upstreams ?? []).map(String),
        results: outcome.results.map((result) => ({
          upstream: String(result.upstream),
          status: String(result.status),
          ms: Number(result.ms ?? 0),
          note: firstLine(result.note, 160),
        })),
      }
    },
  }))

  // ── cline_pass_test ───────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'cline_pass_test',
    description: 'Send one small real request through a pin and report which upstream served it, with the failover trace. `upstreams` and `exclude` override the stored pin for this call only; omit both to exercise it as stored. Nothing is persisted.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id, e.g. "cline-pass/glm-5.2".' },
      upstreams: { type: 'array', items: { type: 'string' }, description: 'Ordered upstream candidates for this call only.' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Upstream channels to exclude for this call only.' },
    },
    timeoutMs: 600000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          error: { type: 'string', required: true },
          ms: { type: 'integer', required: true },
          targets: { type: 'array', required: true, items: { type: 'string' } },
          excluded: { type: 'array', required: true, items: { type: 'string' } },
          actual: { type: 'string', required: true },
          actualName: { type: 'string', required: true },
          pipeline: { type: 'string', required: true },
          pinnable: { type: 'boolean', required: true },
          canonicalSlug: { type: 'string', required: true },
          account: { type: 'string', required: true },
          content: { type: 'string', required: true },
          adopted: { type: 'boolean', required: true },
          adherence: { type: 'string', required: true },
          plan: { type: 'string', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          trace: { type: 'array', required: true, items: TRACE_SCHEMA },
        },
      },
      render: (_args, value) => {
        const trace = value.trace.map((entry) => `  ${entry.upstream} -> HTTP ${entry.status} in ${entry.ms}ms${entry.note === '' ? '' : ` — ${entry.note}`}`)
        const head = value.ok
          ? `test ${value.model}: ok in ${value.ms}ms via ${value.actual || value.actualName || '(unknown)'}`
          : `test ${value.model}: FAILED — ${value.error}`
        // A 200 from the wrong channel is the finding. It must never be left for
        // the reader to spot by comparing `pinned` with `actual`.
        const adherenceNote = value.ok
          ? value.adherence === 'fallback'
            ? `⚠ the gateway fell back to ${value.actual || '(unknown)'}`
            : value.adherence === 'unresolved' && value.targets.length > 0
              // Only worth saying when a pin was actually asked for: under
              // automatic routing there is nothing to confirm, and claiming
              // otherwise reads as a failure that did not happen.
              ? '⚠ the response did not name the serving channel, so the pin could not be confirmed'
              : ''
          : value.actual === '' ? '' : `actual: served by ${value.actual}`
        return text([
          head,
          adherenceNote,
          ...value.warnings.map((warning) => `⚠ ${warning}`),
          value.targets.length === 0 ? '' : `pinned: ${value.targets.join(' > ')}`,
          value.excluded.length === 0 ? '' : `excluded: ${value.excluded.join(', ')}`,
          value.ok ? `pipeline=${value.pipeline} canonicalSlug=${value.canonicalSlug || '-'} account=${value.account || '-'}` : '',
          value.plan === '' ? '' : `router: ${value.plan}`,
          trace.length === 0 ? '' : `attempts (${trace.length}):`,
          ...trace,
          value.content === '' ? '' : `reply: ${value.content}`,
        ].filter((line) => line !== '').join('\n'))
      },
    },
    async execute(args, exec) {
      const model = String(args.model).trim()
      const result = await engine.test(model, {
        upstreams: Array.isArray(args.upstreams) ? args.upstreams.map(String) : undefined,
        exclude: Array.isArray(args.exclude) ? args.exclude.map(String) : undefined,
        signal: exec.signal,
      })
      return {
        ok: result.ok === true,
        model,
        error: firstLine(result.error, 400),
        ms: Number(result.ms ?? 0),
        targets: (result.targets ?? []).map(String),
        excluded: (result.excluded ?? []).map(String),
        actual: String(result.actual ?? ''),
        actualName: String(result.actualName ?? ''),
        pipeline: String(result.pipeline ?? ''),
        pinnable: result.pinnable === true,
        canonicalSlug: String(result.canonicalSlug ?? ''),
        account: String(result.account ?? ''),
        content: String(result.content ?? ''),
        adopted: result.adopted === true,
        adherence: String(result.adherence ?? ''),
        plan: firstLine(result.plan, 300),
        warnings: (result.warnings ?? []).map(String),
        trace: (result.trace ?? []).map((entry) => ({
          upstream: String(entry.upstream ?? '(auto)'),
          status: Number(entry.status ?? 0),
          ms: Number(entry.ms ?? 0),
          note: firstLine(entry.note, 160),
        })),
      }
    },
  }))

  // ── cline_pass_pin ────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'cline_pass_pin',
    description: 'Persist one model\'s upstream pin. `upstreams` is the ordered candidate list, primary first (an empty array returns the model to automatic routing); `exclude` lists channels that must never be used, and is compiled into an allow-list on the wire because the gateway ignores an ignore-field; `pinMode` is "strict" or "preferred"; `sort` orders candidates by "cost", "ttft" or "tps" ("none" clears it). Only the fields you supply change. Returns `warnings` when a name cannot be checked or an exclusion cannot be expressed.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id, e.g. "cline-pass/glm-5.2".' },
      upstreams: { type: 'array', items: { type: 'string' }, description: 'Ordered pin list; an empty array clears pinning.' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Channels that must never be used.' },
      pinMode: { type: 'string', enum: ['strict', 'preferred'], description: 'How strictly to honor the pin list.' },
      sort: { type: 'string', enum: ['cost', 'ttft', 'tps', 'none'], description: 'Reorder candidates by this metric; "none" clears it.' },
    },
    timeoutMs: 30000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          note: { type: 'string', required: true },
          pinned: { type: 'array', required: true, items: { type: 'string' } },
          excluded: { type: 'array', required: true, items: { type: 'string' } },
          pinMode: { type: 'string', required: true },
          sort: { type: 'string', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => text([
        `${value.ok ? 'pinned' : 'pin failed'} ${value.model}`,
        `upstreams: ${value.pinned.length === 0 ? '(auto)' : value.pinned.join(' > ')}`,
        `exclude: ${value.excluded.length === 0 ? '(none)' : value.excluded.join(', ')}`,
        `pinMode=${value.pinMode} sort=${value.sort === '' ? 'none' : value.sort}`,
        ...value.warnings.map((warning) => `⚠ ${warning}`),
        value.note === '' ? '' : `note: ${value.note}`,
      ].filter((line) => line !== '').join('\n')),
    },
    async execute(args) {
      const model = String(args.model).trim()
      const config = readConfig()
      const current = pinOf(model)
      const next = {
        upstreams: Array.isArray(args.upstreams) ? args.upstreams.map(String) : (current.upstreams ?? []).map(String),
        exclude: Array.isArray(args.exclude) ? args.exclude.map(String) : (current.exclude ?? []).map(String),
        pinMode: args.pinMode !== undefined ? args.pinMode : (current.pinMode ?? 'strict'),
        sort: args.sort === undefined ? (current.sort ?? '') : (args.sort === 'none' ? '' : String(args.sort)),
      }
      await control.updateConfig({ perModel: { ...(config.perModel ?? {}), [model]: next } })
      const stored = pinOf(model)
      const meta = store.metaOf(model)
      const pinned = (stored.upstreams ?? []).map(String)
      const excluded = (stored.exclude ?? []).map(String)
      const known = Array.isArray(meta.upstreams) ? meta.upstreams.map(String) : []
      // Pinning is allowed to name a channel the plugin has never seen — the
      // gateway, not this plugin, decides what exists. What is not allowed is
      // letting that look verified: an unusable channel is dropped by the
      // router without an error, so a silent pin is indistinguishable from a
      // working one until the serving channel is read back.
      const warnings = [...pinWarnings({ upstream: pinned[0] ?? null, excludeList: excluded }, meta)]
      const named = [...pinned, ...excluded]
      if (named.length > 0) {
        if (known.length === 0) {
          warnings.push(`unverifiedChannel: this model has no discovered channel list yet, so ${named.join(', ')} cannot be checked — run cline_pass_probe for it`)
        } else {
          const unknown = named.filter((name) => !known.includes(name))
          if (unknown.length > 0) warnings.push(`unknownChannel: ${unknown.join(', ')} is not in this model's discovered channel list (${known.join(', ')}); confirm with cline_pass_test, because the gateway ignores a channel it cannot use rather than failing`)
        }
      }
      return {
        ok: true,
        model,
        note: control.settingsAvailable()
          ? 'Saved to the provider configuration; the next model call uses it. Run cline_pass_test to confirm the gateway honors it.'
          : 'Applied in memory only: the dsh settings service is unavailable, so this will not survive a restart.',
        pinned,
        excluded,
        pinMode: normalizePinMode(stored.pinMode),
        sort: String(stored.sort ?? ''),
        warnings,
      }
    },
  }))

  // ── cline_pass_accounts ───────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'cline_pass_accounts',
    description: 'Manage the Cline Pass account pool: list, add, remove, switch single/round-robin, or test a key with one real request. Keys go to the dsh credential store and are only ever shown masked.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'remove', 'mode', 'set', 'test'], description: 'Operation to perform.' },
      name: { type: 'string', description: 'Account key (letters, digits, dot, dash, underscore).' },
      key: { type: 'string', description: 'API key (sk_…), for add/test.' },
      apiKeyEnv: { type: 'string', description: 'Credential name holding this account key.' },
      displayName: { type: 'string', description: 'Human-readable label.' },
      enabled: { type: 'boolean', description: 'Whether the account takes part in routing.' },
      mode: { type: 'string', enum: ['single', 'roundrobin'], description: 'Pool mode.' },
      active: { type: 'string', description: 'Account key used in single mode.' },
      accounts: {
        type: 'array',
        description: 'Full replacement pool, for set.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            apiKeyEnv: { type: 'string' },
            displayName: { type: 'string' },
            enabled: { type: 'boolean' },
            key: { type: 'string' },
          },
        },
      },
    },
    timeoutMs: 180000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          note: { type: 'string', required: true },
          accountMode: { type: 'string', required: true },
          activeAccount: { type: 'string', required: true },
          accounts: { type: 'array', required: true, items: ACCOUNT_SCHEMA },
        },
      },
      render: (_args, value) => text([
        `accounts.${value.action}: ${value.ok ? 'ok' : 'FAILED'}`,
        value.note === '' ? '' : `note: ${value.note}`,
        `accountMode=${value.accountMode} active=${value.activeAccount || '(first enabled)'} count=${value.accounts.length}`,
        ...value.accounts.map((account) => `  ${account.key}${account.enabled ? '' : ' (disabled)'} key=${account.keyConfigured ? account.keyHint : 'NOT SET'} ref=${account.apiKeyEnv}`),
      ].filter((line) => line !== '').join('\n')),
    },
    async execute(args, exec) {
      const action = String(args.action)
      let note = ''
      const nameOf = (value) => String(value ?? '').trim()
      if (action === 'test') {
        let key = String(args.key ?? '').trim()
        let label = args.name === undefined ? '(supplied key)' : nameOf(args.name)
        let baseURL = readConfig().baseURL
        if (key === '') {
          if (args.name === undefined) throw new Error('cline_pass_accounts action="test" needs `key` or an existing `name`')
          const account = control.accounts().find((entry) => entry.key === nameOf(args.name))
          if (account === undefined) throw new Error(`no account named ${JSON.stringify(nameOf(args.name))}`)
          key = await control.readCredential(account.apiKeyEnv)
          if (key === '') throw new Error(`account ${JSON.stringify(account.key)} has no stored key at ${account.apiKeyEnv}; store one with action="add" key=… or through the dsh Models page`)
          baseURL = account.baseURL || baseURL
        }
        const model = (readConfig().knownModels ?? [])[0] ?? 'cline-pass/glm-5.3-flash'
        const result = await engine.testAccount({ key, baseURL, model, signal: exec.signal })
        note = result.authorized
          ? `key for ${label} authorized in ${result.ms}ms`
          : `key for ${label} FAILED: ${firstLine(result.error, 200)}`
      } else if (action !== 'list') {
        const config = readConfig()
        const accounts = { ...(config.accounts ?? {}) }
        if (action === 'set') {
          if (!Array.isArray(args.accounts)) throw new Error('cline_pass_accounts action="set" needs `accounts`')
          const next = {}
          for (const [index, entry] of args.accounts.entries()) {
            const key = nameOf(entry?.name) || `account-${index + 1}`
            next[key] = {
              displayName: String(entry?.displayName ?? key),
              apiKeyEnv: String(entry?.apiKeyEnv ?? `CLINE_PASS_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_KEY`),
              enabled: entry?.enabled !== false,
              baseURL: '',
            }
            if (typeof entry?.key === 'string' && entry.key.trim() !== '') {
              await control.setCredential(next[key].apiKeyEnv, entry.key.trim())
              note = `stored the key for ${key} in the credential store`
            }
          }
          await control.updateConfig({ accounts: next })
        } else if (action === 'add') {
          const key = nameOf(args.name)
          if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error('cline_pass_accounts action="add" needs a `name` of letters, digits, dot, dash or underscore')
          const config2 = readConfig()
          // Adding the first account must not silently drop the implicit default
          // account the top-level key fields describe: materialize it first.
          if (Object.keys(accounts).length === 0) {
            accounts.default = {
              displayName: String(config2.displayName ?? 'default'),
              apiKeyEnv: String(config2.apiKeyEnv ?? ''),
              enabled: true,
              baseURL: '',
            }
          }
          const apiKeyEnv = String(args.apiKeyEnv ?? `CLINE_PASS_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_KEY`)
          accounts[key] = {
            displayName: String(args.displayName ?? key),
            apiKeyEnv,
            enabled: args.enabled !== false,
            baseURL: '',
          }
          await control.updateConfig({ accounts })
          if (typeof args.key === 'string' && args.key.trim() !== '') {
            await control.setCredential(apiKeyEnv, args.key.trim())
            note = `stored the key for ${key} at ${apiKeyEnv}`
          } else {
            note = `account ${key} added; store its key at ${apiKeyEnv} (pass key=… next time, or use the dsh Models page)`
          }
        } else if (action === 'remove') {
          const key = nameOf(args.name)
          if (accounts[key] === undefined) throw new Error(`no account named ${JSON.stringify(key)}`)
          const removedRef = String(accounts[key]?.apiKeyEnv ?? config.apiKeyEnv ?? '')
          delete accounts[key]
          const active = readConfig().activeAccount === key ? '' : readConfig().activeAccount
          await control.updateConfig({ accounts, activeAccount: active })
          note = Object.keys(accounts).length === 0
            ? `removed ${key}; with no accounts left, requests fall back to the top-level ${readConfig().apiKeyEnv} credential`
            : `removed ${key} (a value stored at ${removedRef} was left in place)`
        } else if (action === 'mode') {
          if (args.mode === undefined) throw new Error('cline_pass_accounts action="mode" needs `mode`')
        }
        // A read-only action must not rewrite the pool: `mode` and `active` used
        // to apply whenever they were present, so an `action="list"` carrying a
        // stray field silently switched the account mode. Both land in one patch
        // as well, so an interrupted call cannot leave half the change applied.
        if (action !== 'list' && action !== 'test') {
          const patch = {}
          if (args.mode !== undefined) patch.accountMode = args.mode === 'roundrobin' ? 'roundrobin' : 'single'
          if (args.active !== undefined) patch.activeAccount = nameOf(args.active)
          if (Object.keys(patch).length > 0) await control.updateConfig(patch)
        }
      }
      const config = readConfig()
      return {
        ok: true,
        action,
        note,
        accountMode: config.accountMode === 'roundrobin' ? 'roundrobin' : 'single',
        activeAccount: String(config.activeAccount ?? ''),
        accounts: await control.accountsWithKeys(),
      }
    },
  }))

  // ── cline_pass_history ────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'cline_pass_history',
    description: 'Read the in-process request history (newest first): account, upstream that served each call, latency, error. Read-only and free. In memory only, so it starts empty after a restart.',
    parameters: {
      limit: { type: 'integer', description: 'How many rows to return (default 25, max 100).' },
      model: { type: 'string', description: 'Only return rows whose model id contains this text.' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ts: { type: 'integer', required: true },
                model: { type: 'string', required: true },
                provider: { type: 'string', required: true },
                canonical: { type: 'string', required: true },
                account: { type: 'string', required: true },
                ms: { type: 'integer', required: true },
                stream: { type: 'boolean', required: true },
                error: { type: 'string', required: true },
                attempts: { type: 'array', required: true, items: { type: 'string' } },
                adherence: { type: 'string', required: true },
                warnings: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.entries.length === 0) return text('No Cline Pass model calls recorded yet in this process.')
        return text([
          `last ${value.entries.length} of ${value.total} call(s):`,
          ...value.entries.map((entry) => {
            const when = entry.ts === 0 ? '-' : new Date(entry.ts).toISOString()
            const attempts = entry.attempts.length === 0 ? '' : ` attempts=${entry.attempts.join('>')}`
            const error = entry.error === '' ? '' : ` error=${entry.error}`
            const adherence = entry.adherence === '' ? '' : ` adherence=${entry.adherence}`
            const warnings = entry.warnings.length === 0 ? '' : ` warnings=${entry.warnings.length}`
            return `${when} ${entry.model} -> ${entry.provider || '(auto)'}${entry.canonical === '' ? '' : ` [${entry.canonical}]`} ${entry.ms}ms${entry.stream ? ' stream' : ''} account=${entry.account || '-'}${attempts}${adherence}${warnings}${error}`
          }),
        ].join('\n'))
      },
    },
    async execute(args) {
      const limit = Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 25
      const entries = store.readHistory(limit, args.model ?? '')
      return {
        total: store.historySize(),
        entries: entries.map((entry) => ({
          ts: Number(entry.ts ?? 0),
          model: String(entry.model ?? ''),
          provider: String(entry.provider ?? ''),
          canonical: String(entry.canonical ?? ''),
          account: String(entry.account ?? ''),
          ms: Number(entry.ms ?? 0),
          stream: entry.stream === true,
          error: firstLine(entry.error, 200),
          attempts: Array.isArray(entry.attempts) ? entry.attempts.map((item) => String(item ?? '')) : [],
          adherence: String(entry.adherence ?? ''),
          warnings: Array.isArray(entry.warnings) ? entry.warnings.map((item) => firstLine(item, 200)) : [],
        })),
      }
    },
  }))
}
