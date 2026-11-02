/**
 * @markishh/dsh-task-tool — one Claude-Code-shaped `Task` tool dispatching
 * to the `@markishh/dsh-agents-md` catalog, with a per-child context cap
 * (hardening b) and a verification-loop guard (hardening c).
 *
 * Spec: ./README.md and ../../docs/DESIGN.md §4.2.
 */

import z from '@deepseek-ai/schemastery'
import { createMaskGuard } from './lib/guards.js'
import { createContextCapHandler } from './lib/context-cap.js'
import { createLoopGuardState, createPostExecuteHandler, createPreExecuteHandler } from './lib/loop-guard.js'
import { createSchemaSync } from './lib/schema-sync.js'

export const name = 'dsh-task-tool'

export const inject = ['tools', 'subagents', 'agentsMd']

export const Config = z.object({
  provider: z.string().description('ctx.subagents provider to start children on.').default('spawn'),
  toolName: z.string().description('Model-facing tool name.').default('Task'),
  enableRunInBackground: z.boolean().description('Expose run_in_background.').default(true),
  maxDepth: z.natural().description('Absolute delegation depth cap; 0 forbids delegation.').default(1),

  subagentContextCap: z.natural().description('Per-child total-token ceiling before action; 0 disables.').default(150000),
  contextCapAction: z.union(['compact', 'steer', 'stop']).description('What to do at the cap.').default('steer'),

  loopGuard: z.object({
    verificationTools: z.array(z.string()).description('Tool-name patterns treated as verification-only.').default(['read', 'grep', 'glob', 'bash:*status*', 'bash:*--version*', 'bash:ls*']),
    window: z.natural().description('Max recent call descriptions retained for the reminder text (not itself a counting threshold — see maxConsecutive).').default(8),
    maxConsecutive: z.natural().description('Count at which the guard fires; 0 disables.').default(6),
    action: z.union(['remind', 'deny']).description('Inject a reminder, or deny the next verification call.').default('remind'),
  }).default({}),

  // ctx.logger has no console exporter in some shipped profiles; default off
  // now that the profile is getting its own logger-exporter row.
  mirrorLogsToConsole: z.boolean().description('Also write warnings to console.error.').default(false),
})

export async function apply(ctx, config) {
  const warn = (message) => {
    ctx.logger.warn(`dsh-task-tool: ${message}`)
    if (config.mirrorLogsToConsole) console.error(`dsh-task-tool: ${message}`)
  }
  // Same console-mirroring rule as `warn`, for the one info-level line this
  // plugin emits (the guard-identity check) — ctx.logger.info would
  // otherwise be invisible on a profile with no console exporter wired for
  // it (the same host fact the sibling packages' READMEs document).
  const info = (message) => {
    ctx.logger.info(`dsh-task-tool: ${message}`)
    if (config.mirrorLogsToConsole) console.error(`dsh-task-tool: ${message}`)
  }
  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  const tracked = new Map() // childSessionId -> { descriptor, parentAgent }
  const loopGuardState = createLoopGuardState()
  let schemaSync

  // Registered FIRST, like dsh-agents-md's own apply(): a throw anywhere
  // below it (the provider capability check, the first schema build, a
  // registration failure) must still dispose whatever got set up before
  // that throw, not leak a tool registration or a timer/watch subscription.
  // `schemaSync` is read by reference at cleanup time, so it is safe to
  // register this before it is assigned.
  ctx.effect(() => () => {
    schemaSync?.stop()
    tracked.clear()
    loopGuardState.clear()
  })

  const provider = ctx.subagents.getProvider(config.provider)
  if (provider !== undefined && provider.capabilities.agentPreset !== true) {
    throw new Error(`dsh-task-tool: provider "${config.provider}" does not support independent agent presets `
      + '(capabilities.agentPreset !== true); refusing to mount a tool whose children would silently lose their persona')
  }
  if (provider === undefined) warnOnce('provider-not-registered', `provider "${config.provider}" is not registered yet; its agentPreset capability could not be checked at mount`)

  const getService = (key) => (ctx.get ? ctx.get(key) : undefined)
  const contextCap = createContextCapHandler({
    tracked,
    config,
    getTokenMeter: () => getService('tokenMeter'),
    getCompaction: () => getService('compaction'),
    getSubagents: () => ctx.subagents,
  })

  // One-time sanity check (first successful dispatch only): the key every
  // guard looks a tracked child up by (`exec.agent.session.id`) really is
  // the same value as the `childId` this plugin tracked it under. Nothing
  // in the host's own types states this outright, and if it were ever
  // false, every guard would silently no-op for every call from every
  // child — the kind of failure a transcript cannot reveal on its own.
  let identityChecked = false
  function verifyGuardIdentity(childId) {
    if (identityChecked) return
    const liveChild = getService('agents')?.get?.(childId)
    if (liveChild === undefined) return // not resolvable yet (external provider, or not resident) — retry on the next dispatch
    identityChecked = true
    if (liveChild.session.id === childId) {
      info('guard identity verified — tracked childId matches exec.agent.session.id')
    } else {
      warn(`guard identity MISMATCH: tracked childId "${childId}" but the live child's own session.id is "${liveChild.session.id}" — `
        + 'every guard (mask/loop-guard/context-cap) keyed by exec.agent.session.id will silently no-op for this child')
    }
  }

  schemaSync = await createSchemaSync({
    ctx,
    config,
    warn,
    buildDispatchDeps: () => ({
      agentsMd: ctx.agentsMd,
      modelTiers: getService('modelTiers'),
      subagents: ctx.subagents,
      config,
      tracked,
      loopGuardState,
      forgetContextCap: contextCap.forget,
      verifyIdentity: verifyGuardIdentity,
      warnOnce,
    }),
  }).start()

  ctx.on('tools/pre-execute', createMaskGuard(tracked))
  ctx.on('tools/pre-execute', createPreExecuteHandler(tracked, loopGuardState, config.loopGuard))
  ctx.on('tools/post-execute', createPostExecuteHandler(tracked, loopGuardState, config.loopGuard))
  ctx.on('agent/pre-step', contextCap.handle)
  // A fresh user/steer message resets the loop guard's count for its child.
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.messages.length > 0) loopGuardState.reset(payload.agent.session?.id)
    return next()
  })
}

export default { name, Config, inject, apply }
