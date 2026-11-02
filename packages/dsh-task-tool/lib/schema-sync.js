/**
 * Keeps the `Task` tool's registration in sync with `ctx.agentsMd`'s live
 * roster — rebuilds the parameter schema and re-registers whenever its
 * `revision` changes. Prefers `ctx.agentsMd.onChange(cb)` when the catalog
 * exposes one; falls back to a plain interval otherwise. Split out of
 * `index.js` to keep that file under its line cap.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildParameters, dispatchTask } from './dispatch.js'

const FALLBACK_REFRESH_INTERVAL_MS = 5000

const TASK_DESCRIPTION = 'Start a subagent to handle a complex, multi-step task autonomously. Launched agents cannot '
  + 'communicate with you — they return one final result. Describe the task in detail so it can run without further '
  + 'input, and state explicitly whether it should write code or only research.'

/**
 * @param deps `{ctx, config, buildDispatchDeps, warn}` — `buildDispatchDeps`
 *   is `() => deps` for `dispatchTask`, called fresh on every `execute()` so
 *   it always reads the caller's current `ctx.get(...)` lookups.
 * @returns `{start}` — `await start()` performs the first registration and
 *   subscribes to change notifications, then resolves to `{stop}`.
 */
export function createSchemaSync({ ctx, config, buildDispatchDeps, warn }) {
  let unregisterTool
  let lastRevision = -1
  let refreshChain = Promise.resolve()

  async function doRefresh() {
    if (unregisterTool !== undefined && ctx.agentsMd.revision === lastRevision) return
    const revisionAtStart = ctx.agentsMd.revision
    const parameters = await buildParameters(ctx.agentsMd, config)
    // Clear BEFORE attempting the new registration: if ctx.tools.register
    // throws below, a stale `unregisterTool` left pointing at the disposed
    // old registration would make the guard above look satisfied forever —
    // the next refresh() would see a "registered" tool that is actually
    // gone, and never retry. `undefined` here is the truth until the line
    // below succeeds.
    unregisterTool?.()
    unregisterTool = undefined
    unregisterTool = ctx.tools.register(defineTool({
      name: config.toolName,
      description: TASK_DESCRIPTION,
      parameters,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        return dispatchTask(buildDispatchDeps(), args, exec)
      },
    }))
    lastRevision = revisionAtStart
  }

  function refresh() {
    refreshChain = refreshChain.then(doRefresh, doRefresh).catch((error) => warn(`tool refresh failed: ${error.message}`))
    return refreshChain
  }

  async function start() {
    await refresh()
    let stopWatching
    // Prefer a live change notification; the interval is a fallback only
    // (and, once onChange lands everywhere, a much slower one) for a
    // composition without it.
    if (typeof ctx.agentsMd.onChange === 'function') {
      stopWatching = ctx.agentsMd.onChange(refresh)
    } else {
      const refreshTimer = setInterval(refresh, FALLBACK_REFRESH_INTERVAL_MS)
      refreshTimer.unref?.() // never keeps the process (or a test runner) alive on its own
      stopWatching = () => clearInterval(refreshTimer)
    }
    return { stop: () => { stopWatching(); unregisterTool?.() } }
  }

  return { start }
}
