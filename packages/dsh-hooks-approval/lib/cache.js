/**
 * Cache of in-flight tool calls, keyed by `callId`. `approval/request`
 * carries no tool arguments (dsh-user-approval's `ApprovalRequestEvent` has
 * `agent`/`toolName`/`callId`/`reason` only — no `arguments`), so the
 * PermissionRequest relay needs `tool_input` from here instead, populated on
 * `tools/pre-execute` and read when the approval waterfall fires. Evicted on
 * `tools/post-execute` (the normal path) or after `maxAgeMs` of no matching
 * post-execute (a call that errors before dispatch, or a dropped event).
 */
export function createPendingToolCache(maxAgeMs, now = () => Date.now()) {
  const entries = new Map()

  function sweep() {
    const cutoff = now()
    for (const [callId, entry] of entries) {
      if (cutoff - entry.insertedAt > maxAgeMs) entries.delete(callId)
    }
  }

  return {
    set(callId, value) {
      entries.set(callId, { ...value, insertedAt: now() })
    },
    get(callId) {
      sweep()
      const entry = entries.get(callId)
      if (entry === undefined) return undefined
      return { toolName: entry.toolName, arguments: entry.arguments, sessionId: entry.sessionId }
    },
    delete(callId) {
      entries.delete(callId)
    },
    size() {
      sweep()
      return entries.size
    },
  }
}
