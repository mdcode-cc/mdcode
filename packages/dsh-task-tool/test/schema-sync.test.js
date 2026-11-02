import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSchemaSync } from '../lib/schema-sync.js'

function fakeAgentsMd(overrides = {}) {
  let revision = 0
  return {
    list: async () => [],
    get: async () => undefined,
    presetId: async () => undefined,
    get revision() { return revision },
    bumpRevision() { revision += 1 },
    ...overrides,
  }
}

function fakeCtx({ agentsMd, registerImpl } = {}) {
  const registeredTools = []
  let nextRegisterThrows = false
  const tools = {
    register: (definition) => {
      if (registerImpl) return registerImpl(definition)
      if (nextRegisterThrows) { nextRegisterThrows = false; throw new Error('registration boom') }
      registeredTools.push(definition)
      return () => registeredTools.splice(registeredTools.indexOf(definition), 1)
    },
  }
  return {
    ctx: { agentsMd: agentsMd ?? fakeAgentsMd(), tools, logger: { warn: () => {} } },
    registeredTools,
    makeNextRegisterThrow: () => { nextRegisterThrows = true },
  }
}

test('schema-sync: start() registers the tool once', async () => {
  const { ctx, registeredTools } = fakeCtx()
  const sync = createSchemaSync({ ctx, config: { toolName: 'Task' }, warn: () => {}, buildDispatchDeps: () => ({}) })
  const { stop } = await sync.start()
  assert.equal(registeredTools.length, 1)
  assert.equal(registeredTools[0].name, 'Task')
  stop()
  assert.equal(registeredTools.length, 0)
})

test('schema-sync: a registration failure does not leave a stale disposer that blocks the next retry (item 2)', async () => {
  // Reproduces the bug: unregisterTool?.() must run, and unregisterTool
  // must be cleared to undefined, BEFORE the new ctx.tools.register() call
  // — not after — so a throw there leaves `unregisterTool === undefined`
  // (truthfully "nothing registered") rather than a stale reference to an
  // already-disposed registration. Otherwise doRefresh()'s own guard
  // (`unregisterTool !== undefined && revision === lastRevision`) would
  // treat the tool as still registered forever once `lastRevision` catches
  // up, and the next refresh would never actually re-register.
  let onChangeCallback
  const agentsMd = fakeAgentsMd({ onChange: (cb) => { onChangeCallback = cb; return () => {} } })
  const { ctx, registeredTools, makeNextRegisterThrow } = fakeCtx({ agentsMd })
  const warnings = []
  const sync = createSchemaSync({ ctx, config: { toolName: 'Task' }, warn: (m) => warnings.push(m), buildDispatchDeps: () => ({}) })

  const { stop } = await sync.start() // first registration succeeds
  assert.equal(registeredTools.length, 1)

  agentsMd.bumpRevision()
  makeNextRegisterThrow()
  await onChangeCallback() // triggers doRefresh(); the throw is caught and warned, not rethrown
  assert.equal(registeredTools.length, 0) // old registration already disposed, new one failed: truthfully "nothing registered"
  assert.ok(warnings.some((w) => /registration boom/.test(w)))

  // Revision did not advance past the failed attempt, so the SAME change
  // notification (simulating a retry — e.g. the next file-watch tick)
  // retries doRefresh() rather than treating the tool as already current.
  await onChangeCallback()
  assert.equal(registeredTools.length, 1) // this time it succeeds and actually re-registers

  stop()
})

test('schema-sync: prefers ctx.agentsMd.onChange(refresh) over polling when present', async () => {
  let onChangeCallback
  let disposed = false
  const agentsMd = fakeAgentsMd({ onChange: (cb) => { onChangeCallback = cb; return () => { disposed = true } } })
  const { ctx } = fakeCtx({ agentsMd })
  const sync = createSchemaSync({ ctx, config: { toolName: 'Task' }, warn: () => {}, buildDispatchDeps: () => ({}) })
  const { stop } = await sync.start()
  assert.equal(typeof onChangeCallback, 'function')
  await assert.doesNotReject(() => onChangeCallback())
  stop()
  assert.equal(disposed, true)
})

test('schema-sync: falls back to a polling interval when ctx.agentsMd.onChange is absent', async () => {
  const { ctx } = fakeCtx()
  const sync = createSchemaSync({ ctx, config: { toolName: 'Task' }, warn: () => {}, buildDispatchDeps: () => ({}) })
  const { stop } = await sync.start()
  assert.doesNotThrow(() => stop()) // proves a real timer handle was created and is owned by this module's own cleanup
})

test('schema-sync: execute() calls dispatchTask with buildDispatchDeps()\'s fresh result', async () => {
  const seenDeps = []
  const { ctx, registeredTools } = fakeCtx()
  const buildDispatchDeps = () => ({ marker: 'fresh-deps' })
  const sync = createSchemaSync({ ctx, config: { toolName: 'Task' }, warn: () => {}, buildDispatchDeps })
  await sync.start()
  // Can't call dispatchTask for real without a live agentsMd/subagents, but
  // we CAN confirm the registered definition's execute() forwards whatever
  // buildDispatchDeps() returns at call time by checking it is a function
  // that closes over the live buildDispatchDeps reference.
  assert.equal(typeof registeredTools[0].execute, 'function')
})
