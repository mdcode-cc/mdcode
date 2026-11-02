/**
 * @markishh/dsh-hooks-approval — emulates the two Claude Code hook events
 * @deepseek-ai/dsh-hooks-claude-code does not bridge: `PermissionRequest`
 * (a blocking approval relay) and `SessionEnd`. Both run the command hooks
 * configured for them in a Claude Code settings.json `hooks` key.
 *
 * Spec: ./README.md.
 */

import os from 'node:os'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_HOOK_TIMEOUT_MS, createDetachedRuns, mergeHookOutputs, runHook, selectHookGroups } from '@deepseek-ai/dsh-hook-protocol'
import { loadApprovalHookConfig } from './lib/settings.js'
import { createPendingToolCache } from './lib/cache.js'
import { permissionRequestPayload, sessionEndPayload } from './lib/payload.js'
import { outcomeFor, reconcilePermissionDecision } from './lib/decision.js'
import { createShellAdapter } from './lib/shell-adapter.js'

export const name = 'dsh-hooks-approval'

// SessionEnd is fire-and-forget (a configured hook can run an async
// notifier there, unlike the blocking PermissionRequest case) — bound
// it hard so plugin disposal never waits the full default (10 min) timeout
// on a hook that will never answer. See `apply()`'s session/disposed
// listener below for why this can't just be `detached.signal`.
const SESSION_END_TIMEOUT_MS = 5000

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.claude', 'settings.json')

export const Config = Schema.object({
  configPath: Schema.string().default(DEFAULT_CONFIG_PATH)
    .description('Absolute path to the Claude Code settings.json whose `hooks` key configures PermissionRequest/SessionEnd commands.'),
  events: Schema.object({
    permissionRequest: Schema.boolean().default(true),
    sessionEnd: Schema.boolean().default(true),
  }),
  timeoutMs: Schema.natural().default(DEFAULT_HOOK_TIMEOUT_MS)
    .description('Default per-hook timeout in ms; a per-hook `timeout` (seconds) in settings.json overrides it. An approval-relay hook that blocks indefinitely waiting on a human decision has no timeout of its own, so in practice this is the relay\'s own ceiling, not the hook\'s.'),
  fallback: Schema.union(['next', 'deny']).default('next')
    .description('What the PermissionRequest relay does when the hook fails, times out, or expresses no allow/deny: \'next\' delegates to the next answerer (e.g. the TUI prompt); \'deny\' rejects outright.'),
  cacheMaxAgeMs: Schema.natural().default(5 * 60 * 1000)
    .description('How long a tools/pre-execute tool-input cache entry survives without a matching tools/post-execute before it is evicted.'),
})

/**
 * Run every matched command hook for `point` and fold with `mergeHookOutputs`.
 * `cwd`, when given, is threaded both as the hook's actual spawn directory
 * (`RunHookOptions.cwd`) and as `CLAUDE_PROJECT_DIR` in its environment —
 * the same two places dsh-hooks-claude-code's own `runPoint` sets them
 * (lib/index.js:171,185-189) — not just reported inside the JSON payload.
 */
async function runPoint({ bash, parsed, timeoutMs }, point, matchQuery, payload, { signal, cwd, decode = output => output }) {
  const groups = selectHookGroups(parsed.config[point], matchQuery, 'claude-code')
  if (groups.length === 0) return mergeHookOutputs([])
  const outputs = []
  const env = cwd !== undefined ? { CLAUDE_PROJECT_DIR: cwd } : undefined
  for (const group of groups) {
    for (const hook of group.hooks) {
      const { output } = await runHook(bash, hook, {
        payload,
        signal,
        trailingNewline: true,
        defaultTimeoutMs: timeoutMs,
        expectedEventName: point,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(env !== undefined ? { env } : {}),
      }, () => performance.now())
      outputs.push(decode(output))
    }
  }
  return mergeHookOutputs(outputs)
}

export function apply(ctx, config) {
  let parsed
  try {
    parsed = loadApprovalHookConfig(config.configPath)
  } catch (error) {
    ctx.logger.warn(`dsh-hooks-approval: could not load hook config "${config.configPath}": ${String(error)} — no hooks registered`)
    return
  }
  for (const s of parsed.skipped) ctx.logger.warn(`dsh-hooks-approval: skipping unsupported "${s.type}" hook on ${s.event} (only command hooks run)`)

  const bash = createShellAdapter()
  const detached = createDetachedRuns()
  const pendingTools = createPendingToolCache(config.cacheMaxAgeMs)
  const run = (...args) => runPoint({ bash, parsed, timeoutMs: config.timeoutMs }, ...args)

  ctx.effect(() => () => detached.drain(), 'dsh-hooks-approval: drain detached hook runs')

  if (config.events.permissionRequest) {
    // Cache tool_input for the approval/request relay below — the waterfall
    // request carries no tool arguments. Neither listener changes the
    // tools/pre-execute or tools/post-execute decision: `next()` always wins.
    ctx.on('tools/pre-execute', (exec, next) => {
      pendingTools.set(exec.callId, {
        toolName: exec.name,
        arguments: exec.arguments,
        sessionId: exec.agent?.session.header.id,
      })
      return next()
    })
    ctx.on('tools/post-execute', (exec, result, next) => {
      pendingTools.delete(exec.callId)
      return next()
    })

    // Prepended (cordis `ctx.on(name, listener, true)` — unshift, runs
    // FIRST): dsh-tui's own answerer parks every ask for the human prompt
    // and only calls `next()` on rejection, so if it registered first this
    // listener — appended behind it — would never be consulted at all.
    // Running first and delegating via our OWN `next()` keeps the TUI
    // prompt as the fallback instead of something the approval relay
    // (fallback: 'next') never reaches.
    ctx.on('approval/request', async (req, next) => {
      const cached = pendingTools.get(req.callId)
      const session = req.agent?.session
      const cwd = session !== undefined ? ctx.get('workingDirectory')?.get(session) : undefined
      const resolvedCwd = cwd ?? process.cwd()
      const payload = permissionRequestPayload({
        sessionId: session?.header.id,
        toolName: cached?.toolName ?? req.toolName,
        toolInput: cached?.arguments,
        callId: req.callId,
        reason: req.reason,
        cwd: resolvedCwd,
      })
      const signal = req.signal ?? new AbortController().signal
      const merged = await run('PermissionRequest', req.toolName, payload, { signal, cwd: resolvedCwd, decode: reconcilePermissionDecision })
      const outcome = outcomeFor(merged, config.fallback)
      ctx.logger.info(`dsh-hooks-approval: PermissionRequest relay for "${req.toolName}" -> ${merged.decision} (${outcome})`)
      return outcome === 'next' ? next() : outcome
    }, true)
  }

  if (config.events.sessionEnd) {
    ctx.on('session/disposed', session => {
      const cwd = ctx.get('workingDirectory')?.get(session) ?? session.header.cwd ?? process.cwd()
      const payload = sessionEndPayload({ sessionId: session.header.id, cwd })
      // NOT `detached.signal`: `drain()` (dsh-hook-protocol) aborts that
      // signal BEFORE awaiting in-flight runs (`controller.abort(); while
      // (inflight.size > 0) await ...`), so on a normal plugin/session
      // teardown this hook would be SIGKILLed the instant disposal starts —
      // before an async notifier hook even finishes connecting. A signal
      // bounded to this one run (not tied to disposal) fixes that;
      // `detached.track()` below still makes `drain()` AWAIT this run to
      // completion (or its own timeout), it just no longer aborts it early.
      const signal = AbortSignal.timeout(SESSION_END_TIMEOUT_MS)
      const pending = run('SessionEnd', '', payload, { signal, cwd })
        .then(merged => {
          ctx.logger.info(`dsh-hooks-approval: SessionEnd relay for session "${session.header.id}" -> ${merged.decision}`)
        })
        .catch(error => {
          ctx.logger.warn(`dsh-hooks-approval: SessionEnd hook failed: ${String(error)}`)
        })
      detached.track(pending)
    })
  }
}

export default { name, Config, apply }
