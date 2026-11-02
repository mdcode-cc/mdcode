/**
 * The per-agent tool mask: a `tools/pre-execute` deny guard keyed by the
 * calling child's session id. Not a catalog mask (Q2 in DESIGN.md) — the
 * child still sees the tool in its schema and pays one denied call to find
 * out it can't use it.
 *
 * Matches against `dshTools` / `dshDisallowedTools` — the real dsh tool
 * names (`read`, `edit`, `bash`, ...) dsh-agents-md normalizes Claude Code's
 * `tools:`/`disallowedTools:` frontmatter into — never the raw `tools` /
 * `disallowedTools` CC names, which do not match anything a real dsh child
 * actually calls (e.g. CC's `Bash` vs the host's registered `bash`).
 *
 * SCOPE: an agent file's `tools:`/`disallowedTools:` only ever expresses
 * Claude Code tool concepts. It says nothing about harness-internal tools a
 * child needs to function at all — `send_message` (the continuable-child
 * reporting path), whatever `ask_user_question`-style or other preset-row
 * tool a composition mounts with no CC counterpart, and so on. Denying one
 * of those because it is merely absent from a CC-shaped allowlist would be
 * denying the child its own plumbing by omission, not enforcing a policy
 * the agent file ever stated. So this guard applies ONLY to a tool name
 * that is a real member of `dsh-agents-md`'s CC->dsh mapping codomain
 * (`KNOWN_DSH_TOOL_NAMES` below, derived live from its actual table) —
 * anything else passes through untouched, regardless of
 * `dshTools`/`dshDisallowedTools`. Caught live: a real `tester` child's own
 * `send_message` call was denied before this fix (`"send_message" is not
 * in the tools allowlist for agent "tester"`) even though no Claude Code
 * tool concept maps to it at all — see README "Second/Third pass".
 */

import { CC_TO_DSH_TOOL_NAMES } from '@mdcode-cc/dsh-agents-md/lib/tool-names.js'

/**
 * The codomain of `dsh-agents-md`'s `CC_TO_DSH_TOOL_NAMES` — every dsh tool
 * name any Claude Code `tools:`/`disallowedTools:` entry can resolve to,
 * flattened and deduplicated. Derived from the live table (imported via
 * that package's `./lib/tool-names.js` subpath export, added to its
 * `package.json` `exports` map for exactly this purpose) rather than
 * hand-copied, so this set tracks the table automatically as it grows —
 * no more manual sync, and no more drift like the second pass's duplicate
 * silently missing `str_replace_editor` or any future row.
 */
export const KNOWN_DSH_TOOL_NAMES = new Set(Object.values(CC_TO_DSH_TOOL_NAMES).flat())

function matchesToolName(dshName, name) {
  return dshName === name
}

/**
 * @param tracked shared `childSessionId -> {descriptor, parentAgent}` map.
 * @returns a `tools/pre-execute` handler: `(exec, next) => Promise<PreToolDecision>`.
 */
export function createMaskGuard(tracked) {
  return async (exec, next) => {
    const sessionId = exec.agent?.session?.id
    const entry = sessionId === undefined ? undefined : tracked.get(sessionId)
    if (entry === undefined) return next()
    if (!KNOWN_DSH_TOOL_NAMES.has(exec.name)) return next() // harness-internal tool: no CC concept names it, so no CC-shaped allowlist can deny it

    const { name, descriptor } = { name: exec.name, descriptor: entry.descriptor }
    const dshTools = descriptor.dshTools ?? []
    const dshDisallowedTools = descriptor.dshDisallowedTools ?? []
    if (dshDisallowedTools.some((t) => matchesToolName(t, name))) {
      return { kind: 'deny', reason: `dsh-task-tool: "${name}" is in disallowedTools for agent "${descriptor.name}"` }
    }
    if (dshTools.length > 0 && !dshTools.some((t) => matchesToolName(t, name))) {
      return { kind: 'deny', reason: `dsh-task-tool: "${name}" is not in the tools allowlist for agent "${descriptor.name}"` }
    }
    return next()
  }
}
