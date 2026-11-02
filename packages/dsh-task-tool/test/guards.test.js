import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMaskGuard } from '../lib/guards.js'

function tracked(entries) {
  return new Map(Object.entries(entries))
}

function exec(name, sessionId) {
  return { name, agent: sessionId === undefined ? undefined : { session: { id: sessionId } } }
}

test('deny guard: an untracked caller (the parent) is never masked', async () => {
  const guard = createMaskGuard(tracked({}))
  let nextCalled = false
  const next = async () => { nextCalled = true; return { kind: 'allow' } }
  const decision = await guard(exec('bash', 'parent-session'), next)
  assert.equal(nextCalled, true)
  assert.deepEqual(decision, { kind: 'allow' })
})

test('deny guard: a tool in dshDisallowedTools is denied', async () => {
  const map = tracked({ 'child-1': { descriptor: { name: 'tester', dshTools: [], dshDisallowedTools: ['edit', 'write'] } } })
  const guard = createMaskGuard(map)
  const decision = await guard(exec('edit', 'child-1'), async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /"edit" is in disallowedTools for agent "tester"/)
})

test('deny guard: a non-empty dshTools allowlist denies anything not in it', async () => {
  const map = tracked({ 'child-1': { descriptor: { name: 'tester', dshTools: ['read', 'bash'], dshDisallowedTools: [] } } })
  const guard = createMaskGuard(map)
  const denied = await guard(exec('edit', 'child-1'), async () => ({ kind: 'allow' }))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /not in the tools allowlist/)

  const allowed = await guard(exec('bash', 'child-1'), async () => ({ kind: 'allow' }))
  assert.deepEqual(allowed, { kind: 'allow' })
})

test('deny guard: an empty dshTools list means no allowlist restriction', async () => {
  const map = tracked({ 'child-1': { descriptor: { name: 'tester', dshTools: [], dshDisallowedTools: [] } } })
  const guard = createMaskGuard(map)
  const decision = await guard(exec('anything', 'child-1'), async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'allow' })
})

test('deny guard: dshDisallowedTools wins over dshTools when a name is in both', async () => {
  const map = tracked({ 'child-1': { descriptor: { name: 'tester', dshTools: ['bash'], dshDisallowedTools: ['bash'] } } })
  const guard = createMaskGuard(map)
  const decision = await guard(exec('bash', 'child-1'), async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /disallowedTools/)
})

test('deny guard: a descriptor with no dshTools/dshDisallowedTools fields (older/fake descriptor) is never masked', async () => {
  const map = tracked({ 'child-1': { descriptor: { name: 'tester' } } })
  const guard = createMaskGuard(map)
  const decision = await guard(exec('bash', 'child-1'), async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'allow' })
})

test('deny guard: a harness-internal tool with no CC counterpart (send_message) is never denied', async () => {
  // Reproduces the live bug: tester.md's allowlist (Read, Grep, Glob, Bash)
  // has no concept of send_message at all, so it must pass through
  // untouched rather than being treated as "not in the tools allowlist".
  const map = tracked({ 'child-1': { descriptor: { name: 'tester', dshTools: ['read', 'grep', 'glob', 'bash'], dshDisallowedTools: [] } } })
  const guard = createMaskGuard(map)
  const decision = await guard(exec('send_message', 'child-1'), async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'allow' })
})

test('deny guard: a harness-internal tool is never denied even when dshDisallowedTools would otherwise match', async () => {
  // Defence in depth: even if a future mapping bug put a non-CC name into
  // dshDisallowedTools, the codomain check still wins — it is checked first.
  const map = tracked({ 'child-1': { descriptor: { name: 'tester', dshTools: [], dshDisallowedTools: ['send_message'] } } })
  const guard = createMaskGuard(map)
  const decision = await guard(exec('send_message', 'child-1'), async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'allow' })
})

test('deny guard: a CC-mapped tool (bash) is still masked normally — the codomain restriction is scoped, not a blanket bypass', async () => {
  const map = tracked({ 'child-1': { descriptor: { name: 'tester', dshTools: ['read'], dshDisallowedTools: [] } } })
  const guard = createMaskGuard(map)
  const decision = await guard(exec('bash', 'child-1'), async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
})

test('KNOWN_DSH_TOOL_NAMES equals the live CC_TO_DSH_TOOL_NAMES codomain from dsh-agents-md', async () => {
  const { KNOWN_DSH_TOOL_NAMES } = await import('../lib/guards.js')
  const { CC_TO_DSH_TOOL_NAMES } = await import('@mdcode-cc/dsh-agents-md/lib/tool-names.js')
  const expected = new Set(Object.values(CC_TO_DSH_TOOL_NAMES).flat())
  assert.deepEqual([...KNOWN_DSH_TOOL_NAMES].sort(), [...expected].sort())
  assert.ok(KNOWN_DSH_TOOL_NAMES.size > 0) // sanity: the table actually has entries
})
