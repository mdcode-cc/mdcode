/**
 * PermissionRequest's decision shape is NOT the flat `permissionDecision`
 * field @deepseek-ai/dsh-hook-protocol's shared codec parses (that codec was
 * only built for the events dsh-hooks-claude-code bridges: SessionStart,
 * UserPromptSubmit, PreToolUse, PostToolUse, Stop, Subagent). Claude Code
 * nests it instead — `hookSpecificOutput.decision.behavior`/`.message` — the
 * same shape a configured approval-relay hook emits:
 *
 *   {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
 *     "decision":{"behavior":"allow"|"deny","message"?}}}
 *
 * So `runHook`'s generic `output.decision` is always `undefined` here; this
 * module re-derives it from the raw `output.stdout` it still preserves
 * verbatim, then hands back a `HookOutput`-shaped object so
 * `mergeHookOutputs`' deny>ask>allow precedence and reason-joining apply
 * unchanged across multiple matched hooks.
 *
 * Exit code 2 ("blocking" exit, shared across every Claude Code hook type)
 * is left as the generic codec already decoded it (`decision: 'block'`,
 * `reason` from stderr) — not verified against an official PermissionRequest
 * spec section, but consistent with every other hook type's documented
 * exit-2 convention.
 */
export function reconcilePermissionDecision(output) {
  if (output.exitCode !== 0) return output
  if (!output.stdout.startsWith('{')) return output
  let parsed
  try {
    parsed = JSON.parse(output.stdout)
  } catch {
    return output
  }
  const hso = parsed?.hookSpecificOutput
  if (typeof hso !== 'object' || hso === null) return output
  const behavior = hso.decision?.behavior
  if (behavior !== 'allow' && behavior !== 'deny') return output
  const reason = typeof hso.decision?.message === 'string' ? hso.decision.message : output.reason
  return { ...output, decision: behavior, ...(reason !== undefined ? { reason } : {}) }
}

/**
 * Map a merged PermissionRequest outcome to the `approval/request` waterfall
 * vocabulary: `'allowed-once'`/`'rejected'` to answer outright, or the
 * `fallback` config ('next' to delegate, 'deny' to reject) when no hook
 * expressed allow/deny — missing hook, non-zero exit, no/unparseable JSON,
 * or a decision this plugin doesn't recognize.
 */
export function outcomeFor(merged, fallback) {
  if (merged.decision === 'allow') return 'allowed-once'
  if (merged.decision === 'deny') return 'rejected'
  return fallback === 'deny' ? 'rejected' : 'next'
}
