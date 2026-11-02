import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesVerification, isReadOnlyAgent, createLoopGuardState, createPostExecuteHandler, createPreExecuteHandler } from '../lib/loop-guard.js'

const CONFIG = { verificationTools: ['read', 'grep', 'glob', 'bash:*status*', 'bash:*--version*', 'bash:ls*'], window: 5, maxConsecutive: 3, action: 'remind' }

function execCall(name, args = {}, sessionId = 'child-1') {
  return { name, arguments: args, agent: { session: { id: sessionId } } }
}

test('matchesVerification: a bare tool name matches case-insensitively', () => {
  assert.equal(matchesVerification(execCall('read'), ['read']), true)
  assert.equal(matchesVerification(execCall('Read'), ['read']), true)
  assert.equal(matchesVerification(execCall('write'), ['read']), false)
})

test('matchesVerification: bash:<glob> matches the command string, not the tool name', () => {
  assert.equal(matchesVerification(execCall('bash', { command: 'git status' }), ['bash:*status*']), true)
  assert.equal(matchesVerification(execCall('bash', { command: 'npm --version' }), ['bash:*--version*']), true)
  assert.equal(matchesVerification(execCall('bash', { command: 'ls -la' }), ['bash:ls*']), true)
  assert.equal(matchesVerification(execCall('bash', { command: 'rm -rf x' }), ['bash:ls*', 'bash:*status*']), false)
  assert.equal(matchesVerification(execCall('grep', { command: 'status' }), ['bash:*status*']), false) // wrong tool name
})

function tracked(name = 'tester') {
  return new Map([['child-1', { descriptor: { name } }]])
}

test('loop guard: N consecutive verification calls fire exactly once (remind), merging into next()\'s own decision', async () => {
  const state = createLoopGuardState()
  const post = createPostExecuteHandler(tracked(), state, CONFIG)
  // next() returns a decision with its OWN additionalContexts and a value —
  // the guard must not truncate the waterfall or drop them.
  const downstreamContext = { role: 'user', content: [{ type: 'text', text: 'downstream' }] }
  const next = async () => ({ kind: 'accept', value: 'downstream-value', additionalContexts: [downstreamContext] })

  let decision
  for (let i = 0; i < CONFIG.maxConsecutive; i += 1) {
    decision = await post(execCall('read'), { isError: false }, next)
  }
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.value, 'downstream-value') // downstream fields survive
  assert.equal(decision.additionalContexts.length, 2) // downstream's + ours, not just ours
  assert.equal(decision.additionalContexts[0], downstreamContext)
  assert.match(decision.additionalContexts[1].content[0].text, /Agent "tester"/)
  assert.equal(decision.additionalContexts[1].source.form, 'notice')
  assert.equal(typeof decision.additionalContexts[1].source.summary, 'string')

  // Firing resets the count; one more call does not fire again immediately.
  const after = await post(execCall('read'), { isError: false }, next)
  assert.deepEqual(after, { kind: 'accept', value: 'downstream-value', additionalContexts: [downstreamContext] })
})

test('loop guard: a non-matching (write) call resets the count', async () => {
  const state = createLoopGuardState()
  const post = createPostExecuteHandler(tracked(), state, CONFIG)
  const next = async () => ({ kind: 'accept' })

  await post(execCall('read'), {}, next)
  await post(execCall('read'), {}, next)
  await post(execCall('write'), {}, next) // resets
  const third = await post(execCall('read'), {}, next)
  assert.deepEqual(third, { kind: 'accept' }) // would have fired at count 3 without the reset
})

test('loop guard: a non-matching (write) call also clears a pending one-shot denial', async () => {
  // Reproduces the bug: fire the deny guard, then make a legitimate write —
  // the NEXT read must not still be denied because of the stale armed state.
  const state = createLoopGuardState()
  const config = { ...CONFIG, action: 'deny' }
  const post = createPostExecuteHandler(tracked(), state, config)
  const pre = createPreExecuteHandler(tracked(), state, config)
  const next = async () => ({ kind: 'accept' })
  const allow = async () => ({ kind: 'allow' })

  for (let i = 0; i < config.maxConsecutive; i += 1) await post(execCall('read'), {}, next)
  // pending is now armed for the next matching (read/grep/glob/bash) call —
  // but the child writes instead.
  await post(execCall('write'), {}, next)

  const decision = await pre(execCall('read'), allow)
  assert.deepEqual(decision, { kind: 'allow' }) // not denied: the write cleared pending
})

test('loop guard: an untracked caller (the parent) is never counted', async () => {
  const state = createLoopGuardState()
  const post = createPostExecuteHandler(new Map(), state, CONFIG)
  let nextCalled = 0
  const next = async () => { nextCalled += 1; return { kind: 'accept' } }
  for (let i = 0; i < 10; i += 1) await post(execCall('read'), {}, next)
  assert.equal(nextCalled, 10)
})

test('loop guard: maxConsecutive: 0 disables the guard entirely', async () => {
  const state = createLoopGuardState()
  const config = { ...CONFIG, maxConsecutive: 0 }
  const post = createPostExecuteHandler(tracked(), state, config)
  let nextCalled = 0
  const next = async () => { nextCalled += 1; return { kind: 'accept' } }
  for (let i = 0; i < 10; i += 1) await post(execCall('read'), {}, next)
  assert.equal(nextCalled, 10)
})

test('loop guard: action "deny" arms a one-shot pre-execute denial for the next matching call', async () => {
  const state = createLoopGuardState()
  const config = { ...CONFIG, action: 'deny' }
  const post = createPostExecuteHandler(tracked(), state, config)
  const pre = createPreExecuteHandler(tracked(), state, config)
  const next = async () => ({ kind: 'accept' })
  const allow = async () => ({ kind: 'allow' })

  for (let i = 0; i < config.maxConsecutive; i += 1) await post(execCall('read'), {}, next)

  const decision = await pre(execCall('read'), allow)
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /agent "tester"/)

  // One-shot: the next matching call is no longer denied.
  const second = await pre(execCall('read'), allow)
  assert.deepEqual(second, { kind: 'allow' })
})

test('loop guard: pre-execute leaves an untracked caller untouched', async () => {
  const state = createLoopGuardState()
  const pre = createPreExecuteHandler(new Map(), state, CONFIG)
  const decision = await pre(execCall('read'), async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'allow' })
})

test('isReadOnlyAgent: true when dshTools has no edit/write (bash included)', () => {
  assert.equal(isReadOnlyAgent({ dshTools: ['read', 'grep', 'glob'] }), true)
})

test('isReadOnlyAgent: true when dshTools includes bash but no edit/write — bash does not count', () => {
  // Matches the real roster: reviewer-type agents keep `bash` for read-only
  // shell use (git diff, cat, ls, ...) and are denied Edit/Write by the mask
  // guard via `disallowedTools:` — they ARE read-only in effect, so `bash`'s
  // mere presence must not disqualify the exemption (fixed: it used to).
  assert.equal(isReadOnlyAgent({ dshTools: ['read', 'grep', 'bash'] }), true)
})

test('isReadOnlyAgent: false when dshTools includes edit or write', () => {
  assert.equal(isReadOnlyAgent({ dshTools: ['read', 'edit'] }), false)
  assert.equal(isReadOnlyAgent({ dshTools: ['read', 'write'] }), false)
  assert.equal(isReadOnlyAgent({ dshTools: ['read', 'bash', 'edit'] }), false) // bash alongside edit: still not exempt, edit is what matters
})

test('isReadOnlyAgent: false (not exempt) when dshTools is empty — empty means unrestricted, not read-only', () => {
  assert.equal(isReadOnlyAgent({ dshTools: [] }), false)
})

test('isReadOnlyAgent: falls back to descriptor.tools (lowercased) when dshTools is absent', () => {
  assert.equal(isReadOnlyAgent({ tools: ['Read', 'Grep', 'Glob'] }), true)
  assert.equal(isReadOnlyAgent({ tools: ['Read', 'Edit'] }), false)
})

test('loop guard: read-only agents are exempt — post-execute never counts, pre-execute never denies', async () => {
  const state = createLoopGuardState()
  // Shaped exactly like the real roster's reviewer/qa-engineer/tester-type
  // agents: `tools: Read, Grep, Glob, Bash` + `disallowedTools: Edit, Write` ->
  // dshTools includes `bash`, which must NOT disqualify the exemption.
  const readOnly = new Map([['child-1', { descriptor: { name: 'reviewer', dshTools: ['read', 'grep', 'glob', 'bash'], dshDisallowedTools: ['edit', 'write'] } }]])
  const config = { ...CONFIG, action: 'deny' }
  const post = createPostExecuteHandler(readOnly, state, config)
  const pre = createPreExecuteHandler(readOnly, state, config)
  const next = async () => ({ kind: 'accept' })
  const allow = async () => ({ kind: 'allow' })

  // Far more than maxConsecutive matching calls — never fires.
  for (let i = 0; i < 20; i += 1) {
    const decision = await post(execCall('read'), {}, next)
    assert.deepEqual(decision, { kind: 'accept' })
  }
  const preDecision = await pre(execCall('read'), allow)
  assert.deepEqual(preDecision, { kind: 'allow' })
})
