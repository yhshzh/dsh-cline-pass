/**
 * Runtime capability probes for the two dsh lines this plugin supports.
 *
 * The plugin ships once and runs on both:
 *
 * - **0.1.5-rc.3** (`latest`) — schemastery 3.18.2, which has no `.volatile()`,
 *   and a settings service that installs a live section through
 *   `installSection(owner, ns, schema, seed, hooks)`.
 * - **0.1.7-alpha.2** (`alpha`) — schemastery ~3.18.4, which has `.volatile()`,
 *   and a settings service that dropped `installSection` for `configure()`
 *   plus the `update`/`replace`/`mutate` writers.
 *
 * Every probe tests for the *capability*, never a version number, so any
 * intermediate release lands on whichever branch it actually implements.
 *
 * @module dsh-cline-pass/compat
 */

/**
 * Mark one schema field as live, where the schema library supports it.
 *
 * From dsh 0.1.6 the settings service refuses every write to an entry with no
 * volatile field (`Plugin entry "…" has no volatile fields`), so without this
 * the panel's saves are all rejected while its reads keep working — the
 * "buttons do nothing" failure. On 0.1.5 the concept does not exist, where the
 * declaration is unnecessary rather than merely unavailable.
 *
 * The marking must be per field: applying `.volatile()` to the enclosing
 * `z.object()` instead makes the schema resolve to `{}` and drops every default
 * with it, which silently blanks the whole configuration.
 *
 * @param field - a schemastery field.
 * @returns the same field, marked live where the library offers it.
 */
export function markVolatile(field) {
  return typeof field?.volatile === 'function' ? field.volatile() : field
}

/**
 * Whether a plugin config value is a live reference rather than a plain value.
 *
 * On a host that supports volatile fields, the Loader hands those fields to
 * `apply()` as reference objects read through `.get()`, and the settings
 * service swaps in a fresh source on every write. Plain fields arrive as plain
 * values. Everything downstream wants the value, so the two are normalized at
 * the entry point.
 *
 * @param value - one field of the plugin config as `apply()` received it.
 * @returns whether it is a live reference.
 */
export function isLiveRef(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
}

/**
 * Resolve every live reference in a config object to its current value.
 *
 * @param config - the config object as `apply()` received it.
 * @returns a shallow copy with references resolved.
 */
export function resolveLiveRefs(config) {
  return Object.fromEntries(
    Object.entries(config ?? {}).map(([key, value]) => [key, isLiveRef(value) ? value.get() : value]),
  )
}

/**
 * Build the reader the plugin uses for its live configuration.
 *
 * On a host with live fields, the Loader commits each write into the reference
 * objects it handed `apply()` — so reading them *at call time* is what makes a
 * settings change reach the next request. Snapshotting once would freeze the
 * config at its startup values and the write would appear to do nothing.
 *
 * Where the fields are plain values (0.1.5), the snapshot is the value and the
 * settings service swaps in a fresh source through `setSource` instead, so this
 * reader is the initial state until `current` is replaced.
 *
 * @param config - the config object as `apply()` received it.
 * @returns a function returning the current configuration.
 */
export function liveConfigReader(config) {
  const hasRefs = Object.values(config ?? {}).some(isLiveRef)
  if (!hasRefs) {
    const snapshot = { ...config }
    return () => snapshot
  }
  // Read through the references on every call: the Loader mutates them in place
  // when a volatile field is committed, which is how a write becomes visible.
  return () => {
    const live = {}
    for (const [key, value] of Object.entries(config)) live[key] = isLiveRef(value) ? value.get() : value
    return live
  }
}

/**
 * Install the plugin's live configuration section on either settings service.
 *
 * On 0.1.5 this is `installSection`, which owns the schema, seeds the values and
 * hands back a source thunk `setSource` on every commit. On 0.1.7 that method is
 * gone: the section is declared with `configure()`, and the service reads the
 * schema straight off the Loader entry — so `setSource` has no counterpart and
 * the plugin keeps reading through its own `current()` thunk, which the
 * `update()` path already refreshes.
 *
 * @param settings - the `settings` service.
 * @param owner - the plugin's context, for `installSection`'s owner argument.
 * @param ns - the settings namespace / profile entry id.
 * @param schema - the plugin's Config schema.
 * @param seed - the config `apply()` received.
 * @param hooks - `{ setSource, onChange }`, used where the service accepts them.
 * @returns the disposer the host returned, when there is one.
 */
export function installLiveSection(settings, owner, ns, schema, seed, hooks) {
  if (typeof settings?.installSection === 'function') {
    return settings.installSection(owner, ns, schema, seed, hooks)
  }
  if (typeof settings?.configure === 'function') {
    // The calling fiber owns the policy, so register the disposer with the
    // plugin's effects rather than leaking it.
    const dispose = settings.configure({ auto: true })
    if (typeof owner?.effect === 'function' && typeof dispose === 'function') {
      owner.effect(() => dispose)
    }
    return dispose
  }
  return undefined
}

/**
 * Apply a patch that may also *remove* keys, on either host line.
 *
 * `settings.update` merges recursively, so a patch that merely omits a key
 * leaves the stored value in place: deleting an account wrote an `accounts`
 * object without it, the service merged the old entry back, and the panel
 * reported success while the account stayed. Both host lines behave this way,
 * and `settings.mutate` with an `unset` op is the only edit that removes a key,
 * so the two are composed here: keys present in `patch` are set, keys the
 * caller listed as removed are unset.
 *
 * @param settings - the `settings` service.
 * @param ns - the settings namespace / profile entry id.
 * @param patch - fields to merge.
 * @param removals - key paths to delete, e.g. `[['accounts', 'name']]`.
 */
export async function updateLiveSection(settings, ns, patch, removals = []) {
  if (removals.length > 0 && typeof settings?.mutate === 'function') {
    // Unset first, then merge the rest: the merge cannot resurrect a key the
    // unset already removed, because the patch no longer mentions it.
    await settings.mutate(ns, removals.map((path) => ({ op: 'unset', path: [...path] })))
  }
  if (Object.keys(patch).length > 0) await settings.update(ns, patch)
}