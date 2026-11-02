/**
 * @mdcode-cc/dsh-changes-panel — a tiny subscribable cache for
 * `getSnapshot()`/`subscribe()` consumption by `React.useSyncExternalStore`.
 * No React here; the panel component owns that wiring.
 */

/**
 * createWatcher({ collect, cwd, timeoutMs, untracked, maxFiles }) -> {
 *   getSnapshot, subscribe, refresh, setCwd, dispose
 * }
 *
 * `getSnapshot()` returns the SAME object identity until a `refresh()`
 * actually produces new data — required for `useSyncExternalStore`, which
 * loops forever if the snapshot getter returns a fresh object every call.
 * There is no `refreshMs`/polling knob here on purpose: the panel drives
 * its own cadence via `ui.useAnimationTime` and calls `refresh()` itself.
 */
export function createWatcher({ collect, cwd, timeoutMs, untracked, maxFiles }) {
  let currentCwd = cwd
  let snapshot = { ok: true, repo: true, loading: true, branch: null, staged: [], unstaged: [], untracked: [], totals: { files: 0, added: 0, deleted: 0 }, truncated: 0, at: 0 }
  const listeners = new Set()
  let disposed = false
  let inFlight = null

  function notify() {
    for (const listener of listeners) listener()
  }

  async function runCollect() {
    const cwdAtStart = currentCwd
    let result
    try {
      result = await collect({ cwd: cwdAtStart, timeoutMs, untracked, maxFiles })
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error) }
    }
    inFlight = null
    if (disposed) return // never notify after disposal
    if (cwdAtStart !== currentCwd) {
      // The cwd moved on while this refresh was in flight (e.g. a
      // coalesced refresh() call during mount's initial fetch). Drop this
      // now-stale result and immediately refresh for the current cwd
      // instead of leaving the panel stuck on `loading` until the next
      // poll tick (or forever, if the panel is paused).
      refresh()
      return
    }
    snapshot = { ...result, loading: false }
    notify()
  }

  function refresh() {
    if (disposed) return inFlight ?? Promise.resolve()
    if (inFlight) return inFlight // coalesce overlapping refreshes for the SAME cwd
    inFlight = runCollect()
    return inFlight
  }

  function setCwd(nextCwd) {
    if (nextCwd === currentCwd) return
    currentCwd = nextCwd
    snapshot = { ...snapshot, loading: true }
    notify()
    refresh()
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function getSnapshot() {
    return snapshot
  }

  function dispose() {
    disposed = true
    listeners.clear()
  }

  return { getSnapshot, subscribe, refresh, setCwd, dispose }
}
