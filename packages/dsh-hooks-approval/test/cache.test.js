import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPendingToolCache } from '../lib/cache.js'

test('cache: set then get returns the cached tool_input', () => {
  const cache = createPendingToolCache(1000)
  cache.set('call-1', { toolName: 'Bash', arguments: { command: 'pwd' }, sessionId: 'sess-1' })
  assert.deepEqual(cache.get('call-1'), { toolName: 'Bash', arguments: { command: 'pwd' }, sessionId: 'sess-1' })
})

test('cache: delete removes the entry (tools/post-execute path)', () => {
  const cache = createPendingToolCache(1000)
  cache.set('call-1', { toolName: 'Bash', arguments: {}, sessionId: 's' })
  cache.delete('call-1')
  assert.equal(cache.get('call-1'), undefined)
})

test('cache: a missing callId returns undefined', () => {
  const cache = createPendingToolCache(1000)
  assert.equal(cache.get('never-set'), undefined)
})

test('cache: entries older than maxAgeMs are evicted on get()/size() — NOT on set()', () => {
  let t = 0
  const cache = createPendingToolCache(1000, () => t)
  cache.set('call-1', { toolName: 'Bash', arguments: {}, sessionId: 's' })
  t = 500
  assert.deepEqual(cache.get('call-1'), { toolName: 'Bash', arguments: {}, sessionId: 's' })
  t = 1500
  assert.equal(cache.get('call-1'), undefined)
})

test('cache: set() does not sweep — it never consults the clock a second time for eviction', () => {
  let t = 0
  let nowCalls = 0
  const now = () => { nowCalls++; return t }
  const cache = createPendingToolCache(1000, now)
  cache.set('old', { toolName: 'Bash', arguments: {}, sessionId: 's' })
  t = 2000 // well past expiry
  const callsBeforeSecondSet = nowCalls
  cache.set('new', { toolName: 'Write', arguments: {}, sessionId: 's' })
  // set() must call now() exactly once (to stamp insertedAt); a second call
  // would mean it also ran sweep()'s own now()-based cutoff check.
  assert.equal(nowCalls, callsBeforeSecondSet + 1)
  // get()/size() DO sweep — the now-expired "old" entry is evicted there, not before.
  assert.equal(cache.get('old'), undefined)
  assert.ok(cache.get('new'))
})

test('cache: eviction only drops the expired entry, not fresher ones', () => {
  let t = 0
  const cache = createPendingToolCache(1000, () => t)
  cache.set('old', { toolName: 'Bash', arguments: {}, sessionId: 's' })
  t = 900
  cache.set('fresh', { toolName: 'Write', arguments: {}, sessionId: 's' })
  t = 1200
  assert.equal(cache.get('old'), undefined)
  assert.ok(cache.get('fresh'))
  assert.equal(cache.size(), 1)
})
