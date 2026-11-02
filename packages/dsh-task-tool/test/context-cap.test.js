import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContextCapHandler, applyCapAction } from '../lib/context-cap.js'

function childAgent(id = 'child-1') {
  return { session: { id } }
}

function baseConfig(overrides = {}) {
  return { subagentContextCap: 1000, contextCapAction: 'compact', ...overrides }
}

test('context cap: below the cap, no action and next() result passes through', async () => {
  const tracked = new Map([['child-1', { descriptor: { name: 'tester' }, parentAgent: {} }]])
  const tokenMeter = { measure: () => ({ totalTokens: 500 }) }
  const { handle } = createContextCapHandler({ tracked, config: baseConfig(), getTokenMeter: () => tokenMeter, getCompaction: () => undefined, getSubagents: () => undefined })
  const decision = await handle({ agent: childAgent(), signal: {} }, async () => 'the-decision')
  assert.equal(decision, 'the-decision')
})

test('context cap: fires exactly once per child even across repeated pre-steps', async () => {
  const tracked = new Map([['child-1', { descriptor: { name: 'tester' }, parentAgent: {} }]])
  const tokenMeter = { measure: () => ({ totalTokens: 999999 }) }
  let compactCalls = 0
  const compaction = { compactIfNeeded: async () => { compactCalls += 1 } }
  const { handle } = createContextCapHandler({ tracked, config: baseConfig(), getTokenMeter: () => tokenMeter, getCompaction: () => compaction, getSubagents: () => undefined })
  const agent = childAgent()
  await handle({ agent, signal: {} }, async () => undefined)
  await handle({ agent, signal: {} }, async () => undefined)
  await handle({ agent, signal: {} }, async () => undefined)
  assert.equal(compactCalls, 1)
})

test('context cap: an untracked agent (the parent) is never measured', async () => {
  const tracked = new Map()
  let measured = false
  const tokenMeter = { measure: () => { measured = true; return { totalTokens: 999999 } } }
  const { handle } = createContextCapHandler({ tracked, config: baseConfig(), getTokenMeter: () => tokenMeter, getCompaction: () => undefined, getSubagents: () => undefined })
  await handle({ agent: childAgent('parent'), signal: {} }, async () => undefined)
  assert.equal(measured, false)
})

test('context cap: subagentContextCap: 0 disables the feature entirely', async () => {
  const tracked = new Map([['child-1', { descriptor: { name: 'tester' }, parentAgent: {} }]])
  let measured = false
  const tokenMeter = { measure: () => { measured = true; return { totalTokens: 999999 } } }
  const { handle } = createContextCapHandler({ tracked, config: baseConfig({ subagentContextCap: 0 }), getTokenMeter: () => tokenMeter, getCompaction: () => undefined, getSubagents: () => undefined })
  await handle({ agent: childAgent(), signal: {} }, async () => undefined)
  assert.equal(measured, false)
})

test('context cap: a failed action still marks "acted" (acted.add runs after, not before)', async () => {
  // compactIfNeeded throws every time, but applyCapAction itself never
  // throws (it falls back to steer) — so the cap must still fire exactly
  // once per child, not retry forever.
  const tracked = new Map([['child-1', { descriptor: { name: 'tester' }, parentAgent: {} }]])
  const tokenMeter = { measure: () => ({ totalTokens: 999999 }) }
  let attempts = 0
  const compaction = { compactIfNeeded: async () => { attempts += 1; throw new Error('boom') } }
  const { handle } = createContextCapHandler({ tracked, config: baseConfig(), getTokenMeter: () => tokenMeter, getCompaction: () => compaction, getSubagents: () => undefined })
  const agent = { session: { id: 'child-1' }, steer: () => {} }
  await handle({ agent, signal: {} }, async () => undefined)
  await handle({ agent, signal: {} }, async () => undefined)
  assert.equal(attempts, 1)
})

test('context cap: forget(childId) clears the "already acted" marker so a later run can act again', async () => {
  const tracked = new Map([['child-1', { descriptor: { name: 'tester' }, parentAgent: {} }]])
  const tokenMeter = { measure: () => ({ totalTokens: 999999 }) }
  let compactCalls = 0
  const compaction = { compactIfNeeded: async () => { compactCalls += 1 } }
  const { handle, forget } = createContextCapHandler({ tracked, config: baseConfig(), getTokenMeter: () => tokenMeter, getCompaction: () => compaction, getSubagents: () => undefined })
  const agent = childAgent()
  await handle({ agent, signal: {} }, async () => undefined)
  assert.equal(compactCalls, 1)
  forget('child-1')
  await handle({ agent, signal: {} }, async () => undefined)
  assert.equal(compactCalls, 2)
})

test('applyCapAction: compact calls ctx.compaction.compactIfNeeded(agent, "pressure", signal) — not compactNow', async () => {
  const calls = []
  const compaction = { compactIfNeeded: async (agent, trigger, signal) => calls.push([agent, trigger, signal]) }
  const agent = childAgent()
  const signal = {}
  await applyCapAction({ agent, config: { contextCapAction: 'compact' }, getCompaction: () => compaction, getSubagents: () => undefined, entry: {}, signal })
  assert.deepEqual(calls, [[agent, 'pressure', signal]])
})

test('applyCapAction: compact falls back to steer when ctx.compaction is unavailable', async () => {
  const steered = []
  const agent = { session: { id: 'c' }, steer: (msg) => steered.push(msg) }
  await applyCapAction({ agent, config: { contextCapAction: 'compact' }, getCompaction: () => undefined, getSubagents: () => undefined, entry: {}, signal: {} })
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /context cap reached/)
  assert.equal(steered[0].source.form, 'notice')
  assert.equal(typeof steered[0].source.summary, 'string')
})

test('applyCapAction: compact falls back to steer when compactIfNeeded throws (e.g. a ManualCompactionError)', async () => {
  const steered = []
  const agent = { session: { id: 'c' }, steer: (msg) => steered.push(msg) }
  const compaction = { compactIfNeeded: async () => { throw new Error('ManualCompactionError: busy') } }
  await applyCapAction({ agent, config: { contextCapAction: 'compact' }, getCompaction: () => compaction, getSubagents: () => undefined, entry: {}, signal: {} })
  assert.equal(steered.length, 1)
})

test('applyCapAction: steer calls agent.steer with a wrap-up message', async () => {
  const steered = []
  const agent = { session: { id: 'c' }, steer: (msg) => steered.push(msg) }
  await applyCapAction({ agent, config: { contextCapAction: 'steer' }, getCompaction: () => undefined, getSubagents: () => undefined, entry: {}, signal: {} })
  assert.equal(steered.length, 1)
})

test('applyCapAction: stop interrupts the child under the parent-agent ancestor authority', async () => {
  const calls = []
  const subagents = { interrupt: (childId, authority) => calls.push([childId, authority]) }
  const parentAgent = { id: 'parent' }
  const agent = childAgent('child-1')
  await applyCapAction({ agent, config: { contextCapAction: 'stop' }, getCompaction: () => undefined, getSubagents: () => subagents, entry: { parentAgent }, signal: {} })
  assert.deepEqual(calls, [['child-1', { kind: 'ancestor', agent: parentAgent }]])
})

test('applyCapAction: stop falls back to steer when interrupt() throws (e.g. a real SubagentError UNAUTHORIZED)', async () => {
  // dsh-subagent/lib/types/manager.js:133-152 throws SubagentError('UNAUTHORIZED')
  // from interrupt() in three real paths when authority.kind === 'ancestor':
  // the stored parentAgent is no longer the exact live agent, it IS the
  // target, or the target isn't in its tracked ancestry. Unguarded, this
  // would rethrow on every single agent/pre-step for that child (acted is
  // only marked after a successful action).
  const steered = []
  const agent = { session: { id: 'c' }, steer: (msg) => steered.push(msg) }
  const subagents = { interrupt: () => { throw new Error("SubagentError: interrupting requires the exact live ancestor agent (UNAUTHORIZED)") } }
  await applyCapAction({ agent, config: { contextCapAction: 'stop' }, getCompaction: () => undefined, getSubagents: () => subagents, entry: { parentAgent: {} }, signal: {} })
  assert.equal(steered.length, 1)
})

test('context cap: a failed stop action still marks "acted" via the handler (does not retry forever)', async () => {
  const tracked = new Map([['child-1', { descriptor: { name: 'tester' }, parentAgent: {} }]])
  const tokenMeter = { measure: () => ({ totalTokens: 999999 }) }
  let interruptAttempts = 0
  const subagents = { interrupt: () => { interruptAttempts += 1; throw new Error('UNAUTHORIZED') } }
  const { handle } = createContextCapHandler({ tracked, config: baseConfig({ contextCapAction: 'stop' }), getTokenMeter: () => tokenMeter, getCompaction: () => undefined, getSubagents: () => subagents })
  const agent = { session: { id: 'child-1' }, steer: () => {} }
  await handle({ agent, signal: {} }, async () => undefined)
  await handle({ agent, signal: {} }, async () => undefined)
  assert.equal(interruptAttempts, 1)
})

test('applyCapAction: compact prefers the child\'s own agent.ctx compaction service over the host-level one', async () => {
  const hostCalls = []
  const childCalls = []
  const hostCompaction = { compactIfNeeded: async (...a) => hostCalls.push(a) }
  const childCompaction = { compactIfNeeded: async (...a) => childCalls.push(a) }
  const agent = { session: { id: 'c' }, ctx: { get: (key) => (key === 'compaction' ? childCompaction : undefined) } }
  await applyCapAction({ agent, config: { contextCapAction: 'compact' }, getCompaction: () => hostCompaction, getSubagents: () => undefined, entry: {}, signal: {} })
  assert.equal(childCalls.length, 1)
  assert.equal(hostCalls.length, 0)
})

test('applyCapAction: compact falls back to the host-level compaction service when the child\'s agent.ctx has none', async () => {
  const hostCalls = []
  const hostCompaction = { compactIfNeeded: async (...a) => hostCalls.push(a) }
  const agent = { session: { id: 'c' }, ctx: { get: () => undefined } }
  await applyCapAction({ agent, config: { contextCapAction: 'compact' }, getCompaction: () => hostCompaction, getSubagents: () => undefined, entry: {}, signal: {} })
  assert.equal(hostCalls.length, 1)
})

test('applyCapAction: compact falls back to the host-level compaction service when agent.ctx is entirely absent', async () => {
  const hostCalls = []
  const hostCompaction = { compactIfNeeded: async (...a) => hostCalls.push(a) }
  const agent = { session: { id: 'c' } } // no .ctx at all — a minimal fake agent
  await applyCapAction({ agent, config: { contextCapAction: 'compact' }, getCompaction: () => hostCompaction, getSubagents: () => undefined, entry: {}, signal: {} })
  assert.equal(hostCalls.length, 1)
})
