/**
 * Claude Code hook stdin payloads for PermissionRequest/SessionEnd, following
 * dsh-hooks-claude-code's own `base()` convention (lib/index.js:357-363):
 * `transcript_path` is always `''` — dsh has no real transcript file to
 * point at.
 */

function base(sessionId, event) {
  return { session_id: sessionId ?? '', transcript_path: '', hook_event_name: event }
}

/** PermissionRequest payload — mirrors dsh-hooks-claude-code's `preToolPayload` fields. */
export function permissionRequestPayload({ sessionId, toolName, toolInput, callId, reason, cwd }) {
  return {
    ...base(sessionId, 'PermissionRequest'),
    cwd,
    tool_name: toolName,
    tool_input: toolInput ?? {},
    tool_use_id: callId,
    ...(reason !== undefined ? { reason } : {}),
  }
}

/**
 * SessionEnd payload. Claude Code's real `reason` field
 * (`clear`/`logout`/`prompt_input_exit`/`other`) has no dsh equivalent for a
 * generic `session/disposed` — always `'other'`.
 */
export function sessionEndPayload({ sessionId, cwd }) {
  return {
    ...base(sessionId, 'SessionEnd'),
    cwd,
    reason: 'other',
  }
}
