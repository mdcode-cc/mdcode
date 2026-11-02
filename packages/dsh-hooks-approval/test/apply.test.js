/**
 * Full plugin wiring, through a fake cordis `ctx` (same pattern as the
 * sibling packages' tests) but a REAL settings.json on disk and the REAL
 * fixture scripts run through the REAL `runHook`/shell-adapter — only `ctx`
 * itself is faked, nothing about hook execution or decoding is.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config, name, apply as applyFn } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const ALLOW_SCRIPT = join(here, 'fixtures', 'allow.sh')
const DENY_SCRIPT = join(here, 'fixtures', 'deny.sh')

async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-approval-apply-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeSettings(dir, hooks) {
  const settingsPath = join(dir, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ hooks }))
  return settingsPath
}

function fakeCtx() {
  const listeners = {}
  const logs = { info: [], warn: [] }
  const disposers = []
  const ctx = {
    on(event, handler) {
      listeners[event] = handler
      return () => { delete listeners[event] }
    },
    effect(execute) {
      const disposer = execute()
      disposers.push(disposer)
      return disposer
    },
    get() {
      return undefined // no workingDirectory service composed — plugin falls back to process.cwd()
    },
    logger: {
      info: m => logs.info.push(m),
      warn: m => logs.warn.push(m),
    },
  }
  return {
    ctx,
    listeners,
    logs,
    dispose: async () => { await Promise.all(disposers.map(d => d?.())) },
  }
}

function resolvedConfig(overrides) {
  return { ...new Config({ configPath: '/dev/null', ...overrides }) }
}

function fakeExec(overrides = {}) {
  return {
    name: 'Bash',
    arguments: { command: 'pwd' },
    callId: 'call-1',
    agent: { session: { header: { id: 'sess-1' } } },
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('plugin shape: name, Config, apply, default export', async () => {
  assert.equal(name, 'dsh-hooks-approval')
  assert.equal(typeof Config, 'function')
  assert.equal(typeof apply, 'function')
  const mod = await import('../index.js')
  assert.equal(mod.default.name, 'dsh-hooks-approval')
  assert.equal(mod.default.apply, applyFn)
})

test('apply: unreadable configPath warns once and registers no listeners', () => {
  const { ctx, listeners, logs } = fakeCtx()
  apply(ctx, resolvedConfig({ configPath: '/nonexistent/settings.json' }))
  assert.equal(Object.keys(listeners).length, 0)
  assert.ok(logs.warn.some(line => line.includes('could not load hook config')))
})

test('apply: a non-command hook type is skipped and warned', async () => {
  await withTmp(async dir => {
    const settingsPath = writeSettings(dir, { PermissionRequest: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] })
    const { ctx, logs } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath }))
    assert.ok(logs.warn.some(line => line.includes('skipping unsupported "prompt" hook on PermissionRequest')))
  })
})

test('apply: events.permissionRequest=false registers no tool/approval listeners', async () => {
  await withTmp(async dir => {
    const settingsPath = writeSettings(dir, { PermissionRequest: [{ hooks: [{ type: 'command', command: ALLOW_SCRIPT }] }] })
    const { ctx, listeners } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath, events: { permissionRequest: false, sessionEnd: false } }))
    assert.equal(listeners['approval/request'], undefined)
    assert.equal(listeners['tools/pre-execute'], undefined)
    assert.equal(listeners['session/disposed'], undefined)
  })
})

test('approval/request end-to-end: allow fixture -> allowed-once, next() not called', async () => {
  await withTmp(async dir => {
    const settingsPath = writeSettings(dir, { PermissionRequest: [{ hooks: [{ type: 'command', command: ALLOW_SCRIPT }] }] })
    const { ctx, listeners, logs } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath }))

    const exec = fakeExec()
    await listeners['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))

    let nextCalled = false
    const outcome = await listeners['approval/request'](
      { agent: exec.agent, toolName: 'Bash', callId: 'call-1', signal: exec.signal },
      async () => { nextCalled = true; return 'unavailable' },
    )
    assert.equal(outcome, 'allowed-once')
    assert.equal(nextCalled, false)
    assert.ok(logs.info.some(line => line.includes('PermissionRequest relay for "Bash" -> allow (allowed-once)')))
  })
})

test('approval/request end-to-end: deny fixture -> rejected', async () => {
  await withTmp(async dir => {
    const settingsPath = writeSettings(dir, { PermissionRequest: [{ hooks: [{ type: 'command', command: DENY_SCRIPT }] }] })
    const { ctx, listeners } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath }))

    const exec = fakeExec()
    await listeners['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
    const outcome = await listeners['approval/request'](
      { agent: exec.agent, toolName: 'Bash', callId: 'call-1', signal: exec.signal },
      async () => 'unavailable',
    )
    assert.equal(outcome, 'rejected')
  })
})

test('approval/request: matcher filters by tool name — a non-matching tool falls through to fallback', async () => {
  await withTmp(async dir => {
    const settingsPath = writeSettings(dir, { PermissionRequest: [{ matcher: 'Write', hooks: [{ type: 'command', command: DENY_SCRIPT }] }] })
    const { ctx, listeners } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath }))

    const exec = fakeExec({ name: 'Bash' })
    await listeners['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
    let nextCalled = false
    const outcome = await listeners['approval/request'](
      { agent: exec.agent, toolName: 'Bash', callId: 'call-1', signal: exec.signal },
      async () => { nextCalled = true; return 'unavailable' },
    )
    assert.equal(nextCalled, true)
    assert.equal(outcome, 'unavailable')
  })
})

test('approval/request: no PermissionRequest hooks configured + fallback "next" (default) delegates', async () => {
  await withTmp(async dir => {
    const settingsPath = writeSettings(dir, { SessionEnd: [{ hooks: [{ type: 'command', command: ALLOW_SCRIPT }] }] })
    const { ctx, listeners } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath }))

    let nextCalled = false
    const outcome = await listeners['approval/request'](
      { toolName: 'Bash', callId: 'call-1', signal: new AbortController().signal },
      async () => { nextCalled = true; return 'unavailable' },
    )
    assert.equal(nextCalled, true)
    assert.equal(outcome, 'unavailable')
  })
})

test('approval/request: no PermissionRequest hooks configured + fallback "deny" rejects outright', async () => {
  await withTmp(async dir => {
    const settingsPath = writeSettings(dir, {})
    const { ctx, listeners } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath, fallback: 'deny' }))

    let nextCalled = false
    const outcome = await listeners['approval/request'](
      { toolName: 'Bash', callId: 'call-1', signal: new AbortController().signal },
      async () => { nextCalled = true; return 'unavailable' },
    )
    assert.equal(nextCalled, false)
    assert.equal(outcome, 'rejected')
  })
})

test('approval/request: an aborted signal mid-hook-run kills the process and falls back to next()', async () => {
  await withTmp(async dir => {
    const settingsPath = writeSettings(dir, { PermissionRequest: [{ hooks: [{ type: 'command', command: 'sleep 5' }] }] })
    const { ctx, listeners } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath, timeoutMs: 5000 })) // long enough that only the abort explains a fast return

    const exec = fakeExec()
    await listeners['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    let nextCalled = false
    const started = Date.now()
    const outcome = await listeners['approval/request'](
      { agent: exec.agent, toolName: 'Bash', callId: 'call-1', signal: controller.signal },
      async () => { nextCalled = true; return 'unavailable' },
    )
    assert.ok(Date.now() - started < 2000, 'the abort should kill the sleeping hook well before its own 5s sleep or the 5s timeoutMs')
    assert.equal(nextCalled, true)
    assert.equal(outcome, 'unavailable')
  })
})

test('approval/request: two concurrent approvals for different tool calls resolve independently (no cross-talk)', async () => {
  await withTmp(async dir => {
    const settingsPath = writeSettings(dir, {
      PermissionRequest: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: DENY_SCRIPT }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: ALLOW_SCRIPT }] },
      ],
    })
    const { ctx, listeners } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath }))

    const execBash = fakeExec({ name: 'Bash', callId: 'call-bash', arguments: { command: 'rm -rf /' } })
    const execWrite = fakeExec({ name: 'Write', callId: 'call-write', arguments: { path: '/tmp/x' } })
    await listeners['tools/pre-execute'](execBash, async () => ({ kind: 'allow' }))
    await listeners['tools/pre-execute'](execWrite, async () => ({ kind: 'allow' }))

    const [bashOutcome, writeOutcome] = await Promise.all([
      listeners['approval/request']({ agent: execBash.agent, toolName: 'Bash', callId: 'call-bash', signal: execBash.signal }, async () => 'unavailable'),
      listeners['approval/request']({ agent: execWrite.agent, toolName: 'Write', callId: 'call-write', signal: execWrite.signal }, async () => 'unavailable'),
    ])
    assert.equal(bashOutcome, 'rejected')
    assert.equal(writeOutcome, 'allowed-once')
  })
})

/**
 * `echo.sh` denies and carries the EXACT received stdin as its message —
 * `reconcilePermissionDecision` folds that into the merged outcome's
 * `reason`, but `approval/request`'s return value is only the outcome
 * string (`'rejected'`), not the reason. So these two tests instead
 * redirect the hook's stdin straight to a file (`cat > "<path>"`) and read
 * that file back — proof of the EXACT payload the real wiring sent,
 * independent of any logging shape.
 */
function captureHookCommand(receivedPath) {
  return `cat > ${JSON.stringify(receivedPath)} && echo '{"hookSpecificOutput":{"decision":{"behavior":"deny"}}}'`
}

test('tools/post-execute evicts the cache through the real wiring — a later approval/request for the same callId gets tool_input {}', async () => {
  await withTmp(async dir => {
    const receivedPath = join(dir, 'received.json')
    const settingsPath = writeSettings(dir, { PermissionRequest: [{ hooks: [{ type: 'command', command: captureHookCommand(receivedPath) }] }] })
    const { ctx, listeners } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath }))

    const exec = fakeExec({ arguments: { command: 'pwd' } })
    await listeners['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
    await listeners['tools/post-execute'](exec, { content: [] }, async () => ({ kind: 'accept' })) // evicts the cache entry

    const outcome = await listeners['approval/request'](
      { agent: exec.agent, toolName: 'Bash', callId: 'call-1', signal: exec.signal },
      async () => 'unavailable',
    )
    assert.equal(outcome, 'rejected')
    const received = JSON.parse(readFileSync(receivedPath, 'utf8'))
    assert.deepEqual(received.tool_input, {}, 'cache entry was evicted by tools/post-execute — no cached tool_input to send')
  })
})

test('tools/pre-execute cache (not evicted): approval/request payload carries the cached tool_input verbatim', async () => {
  await withTmp(async dir => {
    const receivedPath = join(dir, 'received.json')
    const settingsPath = writeSettings(dir, { PermissionRequest: [{ hooks: [{ type: 'command', command: captureHookCommand(receivedPath) }] }] })
    const { ctx, listeners } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath }))

    const exec = fakeExec({ arguments: { command: 'pwd' } })
    await listeners['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
    // NOTE: no tools/post-execute call here — the cache entry is still live.

    const outcome = await listeners['approval/request'](
      { agent: exec.agent, toolName: 'Bash', callId: 'call-1', signal: exec.signal },
      async () => 'unavailable',
    )
    assert.equal(outcome, 'rejected')
    const received = JSON.parse(readFileSync(receivedPath, 'utf8'))
    assert.deepEqual(received.tool_input, { command: 'pwd' }, 'the pre-execute cache entry is still live — its tool_input must reach the hook')
  })
})

test('approval/request: cwd is threaded as both the hook\'s spawn cwd and CLAUDE_PROJECT_DIR, not just reported in the JSON payload', async () => {
  await withTmp(async dir => {
    const receivedPath = join(dir, 'received.json')
    const envPath = join(dir, 'project-dir-env.txt')
    const command = `cat > ${JSON.stringify(receivedPath)} && printenv CLAUDE_PROJECT_DIR > ${JSON.stringify(envPath)} && pwd >> ${JSON.stringify(envPath)} && echo '{"hookSpecificOutput":{"decision":{"behavior":"deny"}}}'`
    const settingsPath = writeSettings(dir, { PermissionRequest: [{ hooks: [{ type: 'command', command }] }] })
    const { ctx, listeners } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath }))

    const exec = fakeExec()
    await listeners['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
    const outcome = await listeners['approval/request'](
      { agent: exec.agent, toolName: 'Bash', callId: 'call-1', signal: exec.signal },
      async () => 'unavailable',
    )
    assert.equal(outcome, 'rejected')

    const received = JSON.parse(readFileSync(receivedPath, 'utf8'))
    const [envValue, spawnedCwd] = readFileSync(envPath, 'utf8').trim().split('\n')
    // ctx.get('workingDirectory') is undefined in this fake ctx, so the
    // plugin's own fallback is process.cwd() — all three must agree.
    assert.equal(received.cwd, process.cwd())
    assert.equal(envValue, process.cwd())
    assert.equal(spawnedCwd, process.cwd())
  })
})

test('session/disposed: an immediate dispose() (normal quit) does NOT kill the hook before it finishes', async () => {
  await withTmp(async dir => {
    // A hook that needs a brief moment to run — e.g. an approval relay
    // connecting to its socket — proven by a marker file written only
    // AFTER the sleep.
    // SessionEnd has no decision semantics to assert on (it's fire-and-forget,
    // see README "Known deviations"), so this is the only unambiguous signal
    // that the process ran to completion rather than being killed early. If
    // SessionEnd used `detached.signal` directly, calling dispose() right
    // after session/disposed fires would abort that signal BEFORE awaiting
    // (dsh-hook-protocol's drain(): `controller.abort(); while (inflight.size
    // > 0) await ...`) and our own abort handler SIGKILLs immediately — the
    // marker would never get written.
    const markerPath = join(dir, 'session-end-ran')
    const settingsPath = writeSettings(dir, { SessionEnd: [{ hooks: [{ type: 'command', command: `sleep 0.3 && touch ${JSON.stringify(markerPath)}` }] }] })
    const { ctx, listeners, logs, dispose } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath, events: { permissionRequest: false, sessionEnd: true } }))

    listeners['session/disposed']({ header: { id: 'sess-1', cwd: '/tmp' } })
    await dispose() // called IMMEDIATELY — no delay — simulating a normal quit right after session end fires
    assert.ok(existsSync(markerPath), 'the SessionEnd hook was killed before it finished sleeping')
    assert.ok(!logs.warn.some(line => line.includes('SessionEnd hook failed')), `unexpected warning: ${JSON.stringify(logs.warn)}`)
  })
})

test('session/disposed: runs the SessionEnd hook detached and logs on completion', async () => {
  await withTmp(async dir => {
    const settingsPath = writeSettings(dir, { SessionEnd: [{ hooks: [{ type: 'command', command: ALLOW_SCRIPT }] }] })
    const { ctx, listeners, logs, dispose } = fakeCtx()
    apply(ctx, resolvedConfig({ configPath: settingsPath, events: { permissionRequest: false, sessionEnd: true } }))

    listeners['session/disposed']({ header: { id: 'sess-1', cwd: '/tmp' } })
    await dispose() // awaits detached.drain(), which awaits the tracked run
    assert.ok(logs.info.some(line => line.includes('SessionEnd relay for session "sess-1"')))
  })
})
