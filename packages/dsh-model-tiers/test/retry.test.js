import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRetryTracker } from '../lib/retry.js'

const RETRY_CONFIG = { codes: ['MALFORMED_RESPONSE', 'STREAM_CLOSED'], maxAttempts: 2 }
const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

test('retry: a configured code retries up to maxAttempts, then delegates', () => {
  const tracker = createRetryTracker(RETRY_CONFIG)
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), true) // attempt 1
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), true) // attempt 2
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), false) // attempt 3 -> delegate
})

test('retry: an unconfigured code always delegates (left to dsh-llm-retry)', () => {
  const tracker = createRetryTracker(RETRY_CONFIG)
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'RATE_LIMIT'), false)
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'RATE_LIMIT'), false)
})

test('retry: maxAttempts 0 always delegates', () => {
  const tracker = createRetryTracker({ ...RETRY_CONFIG, maxAttempts: 0 })
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), false)
})

test('retry: the counter is per (sessionId, turn, step) and resets for a new step', () => {
  const tracker = createRetryTracker(RETRY_CONFIG)
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), true)
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), true)
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), false) // step 1 exhausted

  // A different step starts its own budget from zero.
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 2, 'MALFORMED_RESPONSE'), true)
  assert.equal(tracker.shouldRetry(SESSION_A, 2, 1, 'MALFORMED_RESPONSE'), true)
})

test('retry: two concurrent agents at the same (turn, step) do not share a budget', () => {
  // This is the CRITICAL fix: agent/request-error dispatches to every agent
  // in the process (not scope-filtered here), so two subagents that both
  // reach turn=1 step=1 must not exhaust one shared counter.
  const tracker = createRetryTracker(RETRY_CONFIG)

  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), true) // A attempt 1
  assert.equal(tracker.shouldRetry(SESSION_B, 1, 1, 'MALFORMED_RESPONSE'), true) // B attempt 1 (own budget)
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), true) // A attempt 2
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), false) // A exhausted
  // B is unaffected by A's exhaustion — still has its own budget left.
  assert.equal(tracker.shouldRetry(SESSION_B, 1, 1, 'MALFORMED_RESPONSE'), true) // B attempt 2
  assert.equal(tracker.shouldRetry(SESSION_B, 1, 1, 'MALFORMED_RESPONSE'), false) // B exhausted
})

test('retry: the tracked-step map is bounded by a small LRU, not unbounded growth', () => {
  const tracker = createRetryTracker(RETRY_CONFIG)
  // Flood well past the internal cap (1000) with distinct (turn, step) keys.
  for (let step = 1; step <= 1500; step += 1) {
    tracker.shouldRetry(SESSION_A, 1, step, 'MALFORMED_RESPONSE')
  }
  // The earliest keys were evicted, so they behave like a fresh step again
  // (first attempt returns true) instead of inheriting stale state.
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1, 'MALFORMED_RESPONSE'), true)
  // A very recent key is still tracked past its budget: the flood loop
  // already spent its first attempt (count=1), so exactly one more `true`
  // (attempt 2 of 2) remains before it exhausts.
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1500, 'MALFORMED_RESPONSE'), true)
  assert.equal(tracker.shouldRetry(SESSION_A, 1, 1500, 'MALFORMED_RESPONSE'), false)
})
