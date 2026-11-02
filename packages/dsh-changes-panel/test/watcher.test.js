import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWatcher } from '../lib/watcher.js'

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('getSnapshot: identity is stable across calls with no change', () => {
  const watcher = createWatcher({ collect: async () => ({ ok: true, repo: true }), cwd: '/x' })
  const a = watcher.getSnapshot()
  const b = watcher.getSnapshot()
  assert.equal(a, b)
})

test('getSnapshot: identity changes after a refresh produces new data', async () => {
  let call = 0
  const watcher = createWatcher({
    collect: async () => ({ ok: true, repo: true, call: ++call }),
    cwd: '/x',
  })
  const before = watcher.getSnapshot()
  await watcher.refresh()
  const after = watcher.getSnapshot()
  assert.notEqual(before, after)
  assert.equal(after.call, 1)
})

test('subscribe: listener is notified after a refresh resolves', async () => {
  const watcher = createWatcher({ collect: async () => ({ ok: true, repo: true }), cwd: '/x' })
  let notified = 0
  const unsubscribe = watcher.subscribe(() => { notified += 1 })
  await watcher.refresh()
  assert.equal(notified, 1)
  unsubscribe()
})

test('refresh: overlapping calls are coalesced into one in-flight collect()', async () => {
  let collectCalls = 0
  const gate = deferred()
  const watcher = createWatcher({
    collect: async () => {
      collectCalls += 1
      await gate.promise
      return { ok: true, repo: true }
    },
    cwd: '/x',
  })
  const first = watcher.refresh()
  const second = watcher.refresh() // should coalesce, not start a 2nd collect()
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(collectCalls, 1)
})

test('refresh: a refresh started again after the first settles runs collect() again', async () => {
  let collectCalls = 0
  const watcher = createWatcher({
    collect: async () => { collectCalls += 1; return { ok: true, repo: true } },
    cwd: '/x',
  })
  await watcher.refresh()
  await watcher.refresh()
  assert.equal(collectCalls, 2)
})

test('dispose: drops a late in-flight result instead of notifying after disposal', async () => {
  const gate = deferred()
  const watcher = createWatcher({
    collect: async () => { await gate.promise; return { ok: true, repo: true, late: true } },
    cwd: '/x',
  })
  let notified = 0
  watcher.subscribe(() => { notified += 1 })
  const pending = watcher.refresh()
  const before = watcher.getSnapshot()
  watcher.dispose()
  gate.resolve()
  await pending
  assert.equal(notified, 0)
  assert.equal(watcher.getSnapshot(), before)
  assert.notEqual(watcher.getSnapshot().late, true)
})

test('setCwd: repoints the watcher and triggers a refresh for the new cwd', async () => {
  const seenCwds = []
  const watcher = createWatcher({
    collect: async ({ cwd }) => { seenCwds.push(cwd); return { ok: true, repo: true, cwd } },
    cwd: '/first',
  })
  await watcher.refresh()
  watcher.setCwd('/second')
  // allow the refresh triggered by setCwd to settle
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(seenCwds, ['/first', '/second'])
  assert.equal(watcher.getSnapshot().cwd, '/second')
})

test('setCwd: a no-op call with the same cwd does not trigger a refresh', () => {
  let collectCalls = 0
  const watcher = createWatcher({
    collect: async () => { collectCalls += 1; return { ok: true, repo: true } },
    cwd: '/same',
  })
  watcher.setCwd('/same')
  assert.equal(collectCalls, 0)
})

test('a newer request (cwd change) during an in-flight refresh is not dropped', async () => {
  // Reproduces the real mount sequence: an initial refresh() for the
  // OLD cwd is still in flight when setCwd() repoints to a NEW cwd and
  // calls refresh() again — that second call used to coalesce into the
  // first (same `inFlight` promise) and schedule nothing, leaving the
  // snapshot stuck on `loading` for the new cwd until the next poll tick.
  const gate = deferred()
  const seenCwds = []
  const watcher = createWatcher({
    collect: async ({ cwd }) => {
      seenCwds.push(cwd)
      if (cwd === '/first') await gate.promise // only the first call blocks
      return { ok: true, repo: true, cwd }
    },
    cwd: '/first',
  })

  const firstRefresh = watcher.refresh() // in flight for /first
  watcher.setCwd('/second') // coalesces — must not be silently dropped

  gate.resolve()
  await firstRefresh
  // Give the automatically re-triggered refresh (for /second) a tick to settle.
  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(seenCwds, ['/first', '/second'])
  assert.equal(watcher.getSnapshot().cwd, '/second')
  assert.equal(watcher.getSnapshot().loading, false)
})
