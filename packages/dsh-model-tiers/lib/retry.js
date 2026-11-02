/**
 * (a) fallback retry: a per-(agent, turn, step) attempt counter for the
 * protocol codes the host's own `dsh-llm-retry` leaves terminal
 * (`MALFORMED_RESPONSE`, `STREAM_CLOSED`). See ../README.md "(a) Retry on
 * protocol violations".
 *
 * This is a bare re-run with no backoff and no durable `llm/retry` log entry
 * — strictly worse observability than the adapter-config route, which is why
 * it exists only as a fallback and never touches the five codes
 * `dsh-llm-retry` already owns.
 *
 * Keyed on `${sessionId}:${turn}:${step}`, NOT just `${turn}:${step}`:
 * `agent/request-error` dispatches to every agent in the process unless a
 * listener is scope-filtered (dsh-agent/lib/types/runtime-types.d.ts,
 * "agent/request-error" — "Scope-filtered dispatch... agent-scoped
 * listeners receive only that agent"), and this plugin registers one
 * process-wide listener, not an agent-scoped one. Two concurrent subagents
 * both failing at turn=1 step=1 would otherwise share and exhaust one
 * budget, under-retrying whichever one lost the race on the shared counter.
 * The caller passes `agent.session.id` (`dsh-session/lib/types/index.d.ts`,
 * `Session.id` — "the session identity, derived from its durable header's
 * single copy").
 */

/** No agent/turn-end hook clears a key, so the Map is bounded by LRU eviction instead. */
const MAX_TRACKED_STEPS = 1000

/** Build a tracker bound to one `retry` config ({codes, maxAttempts}). */
export function createRetryTracker(retryConfig) {
  const codes = new Set(retryConfig.codes)
  const maxAttempts = retryConfig.maxAttempts
  const attempts = new Map() // insertion-ordered; re-inserted on touch to track recency

  /** Current count for `key` (0 if absent), moved to most-recently-used position. */
  function touch(key) {
    const existing = attempts.get(key)
    if (existing !== undefined) {
      attempts.delete(key)
      attempts.set(key, existing)
      return existing
    }
    if (attempts.size >= MAX_TRACKED_STEPS) {
      attempts.delete(attempts.keys().next().value) // evict least-recently-used
    }
    return 0
  }

  /**
   * Whether attempt N for `(sessionId, turn, step)` failing with `code`
   * should be retried. Each distinct key starts its own count, so a new
   * step — or a different agent at the same turn/step — always gets a
   * fresh budget.
   */
  function shouldRetry(sessionId, turn, step, code) {
    if (maxAttempts <= 0) return false
    if (!codes.has(code)) return false
    const key = `${sessionId}:${turn}:${step}`
    const count = touch(key) + 1
    attempts.set(key, count)
    return count <= maxAttempts
  }

  return { shouldRetry }
}
