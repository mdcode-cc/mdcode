/**
 * Hardening (b): per-child context cap. One `agent/pre-step` listener
 * measures a tracked child's session pressure and, above the cap, acts
 * exactly once per child — `steer` (default), `compact` (opt-in, falls back
 * to `steer` on failure), or `stop`.
 */

import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'

const WRAP_UP_TEXT = 'dsh-task-tool: context cap reached. Stop exploring, write down what you have found, and finish your current task now.'

function steerToWrapUp(agent) {
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: WRAP_UP_TEXT }],
    source: { kind: 'dsh-task-tool', form: 'notice', summary: boundContextSummary('Context cap reached; told the child to wrap up.') },
  }))
}

/**
 * The child's OWN scoped `compaction` service when its preset mounts one in
 * an isolate (the `cc-agents-md` `inheritPlugins` shape does — see README
 * "Known limitations"), preferred over the host-level instance. Falls back
 * to `getCompaction()` (the plugin's own `ctx`) when the child's `ctx` has
 * none — e.g. a preset without that isolate group, or a fake `agent` in a
 * test with no `.ctx`.
 */
function resolveCompaction(agent, getCompaction) {
  const childCompaction = agent.ctx?.get?.('compaction')
  return childCompaction !== undefined ? childCompaction : getCompaction()
}

/**
 * @param deps `{tracked, config, getTokenMeter, getCompaction, getSubagents}`
 *   — `tracked` is the shared `childSessionId -> {descriptor, parentAgent}`
 *   map; the `get*` fields are `() => service | undefined` lookups,
 *   deferred so a fake `ctx` need not provide them until called.
 * @returns `{handle, forget}` — `handle` is the `agent/pre-step` listener;
 *   `forget(childId)` drops that child's "already acted" marker (called by
 *   `dispatchTask`'s `untrack` once the child settles, so a childId is never
 *   reused across two different runs).
 */
export function createContextCapHandler(deps) {
  const { tracked, config, getTokenMeter, getCompaction, getSubagents } = deps
  const acted = new Set() // childSessionId already acted on, so the cap fires once per child

  const handle = async (payload, next) => {
    const decision = await next()
    if (config.subagentContextCap <= 0) return decision

    const sessionId = payload.agent.session?.id
    const entry = sessionId === undefined ? undefined : tracked.get(sessionId)
    if (entry === undefined || acted.has(sessionId)) return decision

    const tokenMeter = getTokenMeter()
    if (tokenMeter === undefined) return decision

    const measurement = tokenMeter.measure(payload.agent.session)
    if (measurement.totalTokens <= config.subagentContextCap) return decision

    // acted.add() runs only once the action has actually completed (below) —
    // never before — so a failed/aborted attempt is free to retry on the
    // next pre-step instead of being silently marked "done".
    await applyCapAction({ agent: payload.agent, config, getCompaction, getSubagents, entry, signal: payload.signal })
    acted.add(sessionId)
    return decision
  }

  return { handle, forget: (childId) => acted.delete(childId) }
}

/**
 * The action taken once a tracked child crosses the cap. Exported for direct
 * testing of each branch. Never throws: `compact` falls back to `steer` on
 * any `compactIfNeeded` failure, and `stop` falls back to `steer` on any
 * `interrupt()` failure (including a real `SubagentError('UNAUTHORIZED')` —
 * see below).
 */
export async function applyCapAction({ agent, config, getCompaction, getSubagents, entry, signal }) {
  if (config.contextCapAction === 'stop') {
    const subagents = getSubagents()
    try {
      // `interrupt(targetSessionId, authority)` throws `SubagentError`
      // tagged `UNAUTHORIZED` in three real paths when `authority.kind ===
      // 'ancestor'` (dsh-subagent/lib/types/manager.js:133-152): the stored
      // `entry.parentAgent` is no longer the exact live agent
      // (`ctx.agents.get(id) !== caller`), it equals the target itself
      // (self-interrupt), or the target is not in its tracked ancestry. Any
      // of those is plausible by the time this fires — the parent's own
      // turn may have ended, or moved on — so this is not a true "never
      // happens" case. Unguarded, it would rethrow out of `applyCapAction`
      // on every single `agent/pre-step` for that child (since `acted` is
      // only marked after a successful action), spamming the parent's own
      // turn with an uncaught rejection.
      subagents?.interrupt(agent.session.id, { kind: 'ancestor', agent: entry.parentAgent })
      return
    } catch {
      steerToWrapUp(agent)
      return
    }
  }
  if (config.contextCapAction === 'compact') {
    const compaction = resolveCompaction(agent, getCompaction)
    if (compaction !== undefined) {
      try {
        // `compactIfNeeded(agent, trigger, signal)` — NOT `compactNow`.
        // `compactNow` requires an idle agent (it wraps `agent.runMaintenance`,
        // which throws `ManualCompactionError('busy', ...)` whenever the agent
        // has active turn work — dsh-compaction-basic/lib/index.js ~985-1010,
        // dsh-agent-loop/lib/index.js ~822-823) and this handler always runs
        // from `agent/pre-step`, i.e. a running turn. `compactIfNeeded` is the
        // per-step-pressure API the host's own compaction trigger uses
        // (dsh-compaction-basic calls it from the same `agent/pre-step`-style
        // position with trigger `'pressure'`) and does not require idleness.
        await compaction.compactIfNeeded(agent, 'pressure', signal)
        return
      } catch {
        // Any compaction failure (config error, no safe range some other way,
        // or a future ManualCompactionError if this ever calls compactNow)
        // falls back to steer rather than failing the child's step.
      }
    }
    steerToWrapUp(agent)
    return
  }
  steerToWrapUp(agent) // 'steer' (default)
}
