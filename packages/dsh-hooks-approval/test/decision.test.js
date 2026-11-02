import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeHookOutputs } from '@deepseek-ai/dsh-hook-protocol'
import { outcomeFor, reconcilePermissionDecision } from '../lib/decision.js'

function genericOutput({ exitCode, stdout = '', stderr = '' }) {
  // What @deepseek-ai/dsh-hook-protocol's own parseHookOutput would produce:
  // it never recognizes PermissionRequest's nested `decision.behavior`, so
  // `.decision` stays undefined for exitCode 0 regardless of stdout shape.
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

test('reconcilePermissionDecision: decodes the nested allow shape an approval relay emits', () => {
  const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  const out = reconcilePermissionDecision(genericOutput({ exitCode: 0, stdout }))
  assert.equal(out.decision, 'allow')
})

test('reconcilePermissionDecision: decodes the nested deny shape with its message as reason', () => {
  const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied by relay' } } })
  const out = reconcilePermissionDecision(genericOutput({ exitCode: 0, stdout }))
  assert.equal(out.decision, 'deny')
  assert.equal(out.reason, 'Denied by relay')
})

test('reconcilePermissionDecision: exit 2 (blocking) is left as the generic codec decoded it', () => {
  const out = reconcilePermissionDecision({ exitCode: 2, stdout: '', stderr: 'blocked', decision: 'block', reason: 'blocked' })
  assert.equal(out.decision, 'block')
  assert.equal(out.reason, 'blocked')
})

test('reconcilePermissionDecision: non-zero, non-2 exit with no JSON stays undecided', () => {
  const out = reconcilePermissionDecision(genericOutput({ exitCode: 127, stderr: 'command not found' }))
  assert.equal(out.decision, undefined)
})

test('reconcilePermissionDecision: exit 0 but unparseable stdout stays undecided', () => {
  const out = reconcilePermissionDecision(genericOutput({ exitCode: 0, stdout: 'not json at all' }))
  assert.equal(out.decision, undefined)
})

test('reconcilePermissionDecision: exit 0, valid JSON, but no hookSpecificOutput.decision stays undecided', () => {
  const out = reconcilePermissionDecision(genericOutput({ exitCode: 0, stdout: '{"continue":true}' }))
  assert.equal(out.decision, undefined)
})

test('reconcilePermissionDecision: an unrecognized behavior value stays undecided', () => {
  const stdout = JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'ask' } } })
  const out = reconcilePermissionDecision(genericOutput({ exitCode: 0, stdout }))
  assert.equal(out.decision, undefined)
})

test('outcomeFor: allow -> allowed-once, deny -> rejected', () => {
  assert.equal(outcomeFor({ decision: 'allow' }, 'next'), 'allowed-once')
  assert.equal(outcomeFor({ decision: 'deny' }, 'next'), 'rejected')
})

test('outcomeFor: fallback "next" delegates on an undecided ("none") merge', () => {
  assert.equal(outcomeFor({ decision: 'none' }, 'next'), 'next')
})

test('outcomeFor: fallback "deny" rejects on an undecided ("none") merge', () => {
  assert.equal(outcomeFor({ decision: 'none' }, 'deny'), 'rejected')
})

test('end-to-end: mergeHookOutputs + outcomeFor across two hooks (deny wins over allow)', () => {
  const allow = reconcilePermissionDecision(genericOutput({ exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow' } } }) }))
  const deny = reconcilePermissionDecision(genericOutput({ exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'deny', message: 'no' } } }) }))
  const merged = mergeHookOutputs([allow, deny])
  assert.equal(merged.decision, 'deny')
  assert.equal(outcomeFor(merged, 'next'), 'rejected')
})
