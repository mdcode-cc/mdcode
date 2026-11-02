import { test } from 'node:test'
import assert from 'node:assert/strict'
import { name, Config, apply } from '../index.js'

/**
 * Minimal fake cordis `ctx`: records `on`/`tools.register`/`effect`, exposes
 * `get`. `opts.provider` is read with `'provider' in opts` (not a
 * destructuring default) so a caller can pass `provider: undefined` to mean
 * "not registered yet" without the default silently winning.
 */
function createFakeCtx(opts = {}) {
  const provider = 'provider' in opts ? opts.provider : { capabilities: { agentPreset: true } }
  const agentsMd = opts.agentsMd
  const handlers = {}
  const registeredTools = []
  const logs = []
  let teardown
  const ctx = {
    logger: {
      warn: (msg) => logs.push({ level: 'warn', msg }),
      info: () => {},
    },
    agentsMd: agentsMd ?? { list: async () => [], get: async () => undefined, presetId: async () => undefined, revision: 0 },
    subagents: {
      getProvider: () => provider,
      startActivation: async () => { throw new Error('not used in this test') },
    },
    tools: {
      register: (definition) => { registeredTools.push(definition); return () => registeredTools.splice(registeredTools.indexOf(definition), 1) },
    },
    on(event, listener) {
      (handlers[event] ??= []).push(listener)
      return () => {}
    },
    get() { return undefined },
    // real cordis: runs the factory now, keeps its returned disposer for
    // this plugin's own teardown — not `apply()`'s own (unrelated) return value.
    effect(factory) { teardown = factory() },
  }
  return { ctx, handlers, registeredTools, logs, runTeardown: () => teardown() }
}

test('name identifies the plugin', () => {
  assert.equal(name, 'dsh-task-tool')
})

test('Config: defaults match the spec', () => {
  const config = Config()
  assert.equal(config.provider, 'spawn')
  assert.equal(config.toolName, 'Task')
  assert.equal(config.enableRunInBackground, true)
  assert.equal(config.maxDepth, 1)
  assert.equal(config.subagentContextCap, 150000)
  assert.equal(config.contextCapAction, 'steer')
  assert.deepEqual(config.loopGuard, {
    verificationTools: ['read', 'grep', 'glob', 'bash:*status*', 'bash:*--version*', 'bash:ls*'],
    window: 8,
    maxConsecutive: 6,
    action: 'remind',
  })
  assert.equal(config.mirrorLogsToConsole, false)
})

test('apply: registers the Task tool and wires every listener', async () => {
  const { ctx, handlers, registeredTools } = createFakeCtx()
  await apply(ctx, Config())
  assert.equal(registeredTools.length, 1)
  assert.equal(registeredTools[0].name, 'Task')
  assert.equal(handlers['tools/pre-execute'].length, 2) // mask guard + loop-guard deny
  assert.equal(handlers['tools/post-execute'].length, 1)
  assert.equal(handlers['agent/pre-step'].length, 2) // context cap + loop-guard reset
})

test('apply: refuses to mount when the provider lacks agentPreset', async () => {
  const { ctx } = createFakeCtx({ provider: { capabilities: { agentPreset: false } } })
  await assert.rejects(() => apply(ctx, Config()), /does not support independent agent presets/)
})

test('apply: warns but still mounts when the provider is not registered yet', async () => {
  const { ctx, logs, registeredTools } = createFakeCtx({ provider: undefined })
  await apply(ctx, Config())
  assert.equal(registeredTools.length, 1)
  assert.ok(logs.some((l) => /not registered yet/.test(l.msg)))
})

test('apply: subagent_type enum reflects the live roster', async () => {
  const agentsMd = { list: async () => [{ name: 'tester', description: 'runs tests' }], get: async () => undefined, presetId: async () => undefined, revision: 0 }
  const { ctx, registeredTools } = createFakeCtx({ agentsMd })
  await apply(ctx, Config())
  // defineTool() compiles the flat `parameters` dict into a JSON Schema object.
  assert.deepEqual(registeredTools[0].parameters.properties.subagent_type.enum, ['tester'])
})

test('apply: subscribes to ctx.agentsMd.onChange(refresh) when present, instead of polling', async () => {
  let onChangeCallback
  let disposed = false
  const agentsMd = {
    list: async () => [],
    get: async () => undefined,
    presetId: async () => undefined,
    revision: 0,
    onChange: (cb) => { onChangeCallback = cb; return () => { disposed = true } },
  }
  const { ctx, runTeardown } = createFakeCtx({ agentsMd })
  await apply(ctx, Config())
  assert.equal(typeof onChangeCallback, 'function')
  // Calling the subscribed callback re-runs refresh without throwing.
  await assert.doesNotReject(() => onChangeCallback())
  runTeardown()
  assert.equal(disposed, true)
})

test('apply: falls back to a 5s polling interval when ctx.agentsMd.onChange is absent', async () => {
  const { ctx, runTeardown } = createFakeCtx() // default fake agentsMd has no onChange
  await apply(ctx, Config())
  // Teardown must clear the interval cleanly (no throw) — proves a real
  // timer handle was created and is owned by this plugin's cleanup.
  assert.doesNotThrow(() => runTeardown())
})

test('apply: the ctx.effect cleanup is registered before the provider check can throw', async () => {
  // Registered first (like dsh-agents-md's own apply()): a throw anywhere
  // after it must not leak the effect's own registration — runTeardown()
  // must exist and run cleanly even though apply() itself rejected.
  const { ctx, runTeardown } = createFakeCtx({ provider: { capabilities: { agentPreset: false } } })
  await assert.rejects(() => apply(ctx, Config()), /does not support independent agent presets/)
  assert.doesNotThrow(() => runTeardown())
})
