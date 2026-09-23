/**
 * Runtime observation state: pipeline detection, discovered upstream channels,
 * per-channel verdicts, and request history.
 *
 * Configuration lives in the settings document instead (see `index.js`). This
 * is derived data any probe can rebuild, so it is never persisted.
 *
 * @module dsh-cline-pass/store
 */
import { MAX_UPSTREAMS } from './protocol.js'

/** How many request-history rows are retained. */
export const DEFAULT_HISTORY_LIMIT = 100

/** One upstream availability verdict. */
function verdict(status, note, ms) {
  return { status, note: String(note ?? '').slice(0, 200), ms: Number(ms ?? 0), checkedAt: Date.now() }
}

/**
 * Create the observation store.
 * @param options - `{ historyLimit }`.
 */
export function createStore({ historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
  /** @type {Map<string, object>} model id -> discovered metadata */
  const models = new Map()
  /** @type {object[]} newest first */
  const history = []
  let catalog = { ids: [], sources: [], fetchedAt: 0 }
  /** Last quota reading, one entry per enabled account. */
  let usage = { ok: false, accounts: [], fetchedAt: 0 }
  /** Last per-window usage reading, one entry per enabled account. */

  return {
    /** Discovered metadata for one model (never undefined). */
    metaOf(model) {
      return models.get(model) ?? {}
    },
    /** Every model with discovered metadata. */
    allMeta() {
      return [...models.entries()].map(([id, meta]) => ({ id, ...meta }))
    },
    /** Merge one discovery result into a model's metadata. */
    learn(model, patch) {
      const current = models.get(model) ?? {}
      const next = { ...current, ...patch }
      if (patch?.upstreamStatus !== undefined) {
        next.upstreamStatus = { ...(current.upstreamStatus ?? {}), ...patch.upstreamStatus }
      }
      if (next.upstreams !== undefined) {
        // Same bound as the protocol layer's merge: a tighter cap here would
        // silently drop channels the probe just discovered.
        next.upstreams = [...new Set(next.upstreams.map(String).filter((name) => name.length > 0))].slice(0, MAX_UPSTREAMS)
      }
      models.set(model, next)
      return next
    },
    /** Record one upstream's availability verdict; an inconclusive one is dropped. */
    learnUpstream(model, upstream, status, note, ms) {
      if (upstream === undefined || upstream === null || upstream === '') return
      if (status === 'unknown') return
      const current = models.get(model) ?? {}
      models.set(model, {
        ...current,
        upstreamStatus: { ...(current.upstreamStatus ?? {}), [upstream]: verdict(status, note, ms) },
      })
    },
    /** Append one request-history row (newest first, bounded). */
    record(entry) {
      history.unshift({ ts: Date.now(), ...entry })
      if (history.length > historyLimit) history.length = historyLimit
    },
    /**
     * Read request history.
     * @param limit - maximum rows (defaults to the configured cap).
     * @param model - optional case-insensitive substring filter.
     */
    readHistory(limit = historyLimit, model = '') {
      const needle = String(model ?? '').trim().toLowerCase()
      return history
        .filter((entry) => needle === '' || String(entry.model ?? '').toLowerCase().includes(needle))
        .slice(0, Math.max(0, Math.min(limit, historyLimit)))
    },
    /** Total rows retained, before any filter. */
    historySize() {
      return history.length
    },
    /** The last cached official-catalog scan. */
    catalog() {
      return catalog
    },
    /** Replace the cached official-catalog scan. */
    setCatalog(next) {
      catalog = { ...next, fetchedAt: Date.now() }
      return catalog
    },
    /** The last quota reading (never undefined). */
    usage() {
      return usage
    },
    /** Replace the cached quota reading. */
    setUsage(next) {
      usage = { ...usage, ...next, fetchedAt: Date.now() }
      return usage
    },
    }
}
