/**
 * Real subprocess test: spawns the fixture scripts through the SAME
 * runner (`runHook` from @deepseek-ai/dsh-hook-protocol) and the SAME
 * `{resolve, execute}` adapter (`lib/shell-adapter.js`) production uses —
 * no mock, no stub, a real child process.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mergeHookOutputs, runHook } from '@deepseek-ai/dsh-hook-protocol'
import { createShellAdapter } from '../lib/shell-adapter.js'
import { outcomeFor, reconcilePermissionDecision } from '../lib/decision.js'
import { permissionRequestPayload } from '../lib/payload.js'

const here = dirname(fileURLToPath(import.meta.url))
const ALLOW_SCRIPT = join(here, 'fixtures', 'allow.sh')
const DENY_SCRIPT = join(here, 'fixtures', 'deny.sh')
const NO_READ_SCRIPT = join(here, 'fixtures', 'exit-without-reading-stdin.sh')

async function runFixture(scriptPath) {
  const bash = createShellAdapter()
  const payload = permissionRequestPayload({ sessionId: 's', toolName: 'Bash', toolInput: { command: 'pwd' }, callId: 'c1', cwd: '/tmp' })
  const { output } = await runHook(bash, { command: scriptPath }, {
    payload,
    signal: new AbortController().signal,
    trailingNewline: true,
    defaultTimeoutMs: 5000,
    expectedEventName: 'PermissionRequest',
  }, () => performance.now())
  return output
}

test('subprocess: allow fixture -> exit 0, decoded as allow, outcome allowed-once', async () => {
  const output = await runFixture(ALLOW_SCRIPT)
  assert.equal(output.exitCode, 0)
  const decoded = reconcilePermissionDecision(output)
  assert.equal(decoded.decision, 'allow')
  const merged = mergeHookOutputs([decoded])
  assert.equal(outcomeFor(merged, 'next'), 'allowed-once')
})

test('subprocess: deny fixture -> exit 0, decoded as deny with message, outcome rejected', async () => {
  const output = await runFixture(DENY_SCRIPT)
  assert.equal(output.exitCode, 0)
  const decoded = reconcilePermissionDecision(output)
  assert.equal(decoded.decision, 'deny')
  assert.equal(decoded.reason, 'Denied by fixture')
  const merged = mergeHookOutputs([decoded])
  assert.equal(outcomeFor(merged, 'next'), 'rejected')
})

test('subprocess: a missing script (spawn failure) decodes to no decision, not a thrown error', async () => {
  const output = await runFixture(join(here, 'fixtures', 'does-not-exist.sh'))
  const decoded = reconcilePermissionDecision(output)
  assert.equal(decoded.decision, undefined)
})

test('subprocess: a >64KB stdin payload to a hook that exits without reading it does not crash (EPIPE on child.stdin)', async () => {
  // Without an 'error' listener on child.stdin, Node throws this EPIPE as an
  // UNCAUGHT exception — it would crash the whole host process, not just
  // fail this test. Prove the fix by catching one explicitly: if it fires,
  // fail the assertion instead of taking the whole test run down with it.
  let uncaught
  const onUncaught = error => { uncaught = error }
  process.on('uncaughtException', onUncaught)
  try {
    const bash = createShellAdapter()
    const bigToolInput = { command: 'x'.repeat(100_000) } // JSON payload well over the 64KB pipe-buffer threshold
    const payload = permissionRequestPayload({ sessionId: 's', toolName: 'Bash', toolInput: bigToolInput, callId: 'c1', cwd: '/tmp' })
    assert.ok(JSON.stringify(payload).length > 64 * 1024, 'fixture payload must exceed 64KB to reproduce the pipe-buffer EPIPE')
    const { output } = await runHook(bash, { command: NO_READ_SCRIPT }, {
      payload,
      signal: new AbortController().signal,
      trailingNewline: true,
      defaultTimeoutMs: 5000,
      expectedEventName: 'PermissionRequest',
    }, () => performance.now())
    assert.equal(uncaught, undefined, `uncaughtException fired: ${uncaught?.stack ?? uncaught}`)
    assert.equal(output.exitCode, 0)
  } finally {
    process.off('uncaughtException', onUncaught)
  }
})

test('subprocess: an already-firing abort signal kills the process promptly and reports an undecided outcome', async () => {
  const bash = createShellAdapter()
  const payload = permissionRequestPayload({ sessionId: 's', toolName: 'Bash', callId: 'c1', cwd: '/tmp' })
  const controller = new AbortController()
  const started = performance.now()
  setTimeout(() => controller.abort(), 50)
  const { output } = await runHook(bash, { command: 'sleep 5' }, {
    payload,
    signal: controller.signal,
    trailingNewline: true,
    defaultTimeoutMs: 5000, // long enough that only the abort — not the timeout — can explain a fast return
    expectedEventName: 'PermissionRequest',
  }, () => performance.now())
  assert.ok(performance.now() - started < 2000, 'abort should kill the process well before the 5s sleep or the 5s default timeout')
  const decoded = reconcilePermissionDecision(output)
  assert.equal(decoded.decision, undefined)
})

test('subprocess: timeout kills the process and reports an undecided outcome', async () => {
  const bash = createShellAdapter()
  const payload = permissionRequestPayload({ sessionId: 's', toolName: 'Bash', callId: 'c1', cwd: '/tmp' })
  const { output } = await runHook(bash, { command: 'sleep 5' }, {
    payload,
    signal: new AbortController().signal,
    trailingNewline: true,
    defaultTimeoutMs: 100,
    expectedEventName: 'PermissionRequest',
  }, () => performance.now())
  const decoded = reconcilePermissionDecision(output)
  assert.equal(decoded.decision, undefined)
})
