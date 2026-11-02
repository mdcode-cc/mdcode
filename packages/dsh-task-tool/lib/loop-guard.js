/**
 * Hardening (c): the verification-loop guard. Counts consecutive
 * verification-only tool calls per tracked child on `tools/post-execute`;
 * at `maxConsecutive` it either injects a reminder or arms a one-shot deny
 * for the next matching call, enforced on `tools/pre-execute`. Skipped
 * entirely for an agent with no `edit`/`write` tool at all (see
 * `isReadOnlyAgent` below — `bash` does NOT count, see its comment) — a
 * reviewer/researcher's job IS to read many things and answer in its final
 * text, so nagging it every N calls is noise, not signal.
 *
 * Deliberately distinct from `@deepseek-ai/dsh-repeat-tool-reminder`, which
 * only catches exact repeats — "same tool, same arguments regardless of
 * property order", and explicitly warns that "near-identical variants must
 * be caught" is out of scope (`dsh-repeat-tool-reminder/README.md`). The
 * observed failure is a child re-reading and re-grepping with *varying*
 * arguments and never writing anything. Both can be mounted; they catch
 * different shapes.
 */

import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'

// `bash` is deliberately NOT in this set. Every real reviewer/researcher
// agent in a typical roster keeps `bash` in its `tools:` allowlist for
// read-only shell use (git diff, cat, ls, ...) while the mask guard already
// denies it `edit`/`write` outright via `disallowedTools:` — so treating
// `bash`'s mere presence as "can write" exempted nobody in practice (found
// while testing this exemption against a real roster; see README "Second
// pass" finding 4 / "Third pass"). An agent can still `bash > file`, so this
// is a convention the roster follows, not a sandboxing guarantee the dsh
// host enforces — the mask guard (`lib/guards.js`) is what actually blocks
// `edit`/`write`, not this exemption.
//
// NOT EXHAUSTIVE — this is a hand-kept list of dsh tool names that can
// mutate a file, unlike `lib/guards.js`'s `KNOWN_DSH_TOOL_NAMES` (which is
// derived live from dsh-agents-md's full CC->dsh table and therefore tracks
// every future row automatically). `str_replace_editor` is included because
// it is a REAL registered tool name on this host
// (`dsh-tool-str-replace-editor/lib/index.js:267`,
// `defineTool({ name: "str_replace_editor", ... })`) even though no CC name
// in the current roster maps to it yet. Any other mutating tool a future
// preset row adds needs a manual entry here too — this set does not grow
// itself the way the mask guard's does.
const WRITE_CAPABLE_DSH_TOOLS = new Set(['edit', 'write', 'str_replace_editor'])

/**
 * Whether `descriptor` has no edit/write (-equivalent) tool at all, so the
 * loop guard should never fire for its children. Reads `dshTools` (the
 * dsh-agents-md normalized names the deny guard also uses); falls back to
 * the raw Claude-Code `tools` list, lowercased, when `dshTools` is not on
 * the descriptor yet (an older/fake descriptor). An EMPTY list means "no
 * allowlist — inherits every tool" (dsh-agents-md README, "absent means
 * inherit everything"), which includes write tools, so it is treated as
 * NOT read-only — only a non-empty, explicitly write-free list exempts.
 * `bash` does not count as write-capable here (see the comment above) —
 * only the names in `WRITE_CAPABLE_DSH_TOOLS` do, and that set is a
 * hand-kept list, not exhaustive over every tool that could ever write.
 */
export function isReadOnlyAgent(descriptor) {
  const toolNames = descriptor.dshTools ?? (descriptor.tools ?? []).map((t) => t.toLowerCase())
  if (toolNames.length === 0) return false
  return !toolNames.some((t) => WRITE_CAPABLE_DSH_TOOLS.has(t))
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globToRegExp(glob) {
  return new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`, 'i')
}

/** Whether one call matches a `verificationTools` pattern: a bare tool name, or `tool:glob` matched against that tool's `command` argument. */
export function matchesVerification(exec, patterns) {
  for (const pattern of patterns) {
    const sep = pattern.indexOf(':')
    if (sep === -1) {
      if (pattern.trim().toLowerCase() === exec.name.toLowerCase()) return true
      continue
    }
    const toolName = pattern.slice(0, sep)
    const glob = pattern.slice(sep + 1)
    if (toolName.toLowerCase() !== exec.name.toLowerCase()) continue
    const command = exec.arguments?.command
    if (typeof command === 'string' && globToRegExp(glob).test(command)) return true
  }
  return false
}

function describeCall(exec) {
  const command = exec.arguments?.command
  return typeof command === 'string' ? `${exec.name}: ${command}` : exec.name
}

/** Fresh per-child state: `childSessionId -> {count, names, pending}`. Exported so index.js shares one store across both handlers. */
export function createLoopGuardState() {
  const perChild = new Map()
  return {
    get(id) { return perChild.get(id) ?? { count: 0, names: [], pending: false } },
    set(id, state) { perChild.set(id, state) },
    reset(id) { perChild.delete(id) },
    clear() { perChild.clear() },
  }
}

function reminderText(agentName, names) {
  return `dsh-task-tool: ${names.length} consecutive verification-only calls (${names.slice(-3).join('; ')}). `
    + `Agent "${agentName}": decide now — report your findings, or make the next call a write/edit.`
}

/** `tools/post-execute`: count, and act once at `maxConsecutive`. */
export function createPostExecuteHandler(tracked, state, config) {
  return async (exec, _result, next) => {
    const sessionId = exec.agent?.session?.id
    const entry = sessionId === undefined ? undefined : tracked.get(sessionId)
    if (entry === undefined || config.maxConsecutive <= 0 || isReadOnlyAgent(entry.descriptor)) return next()

    const s = state.get(sessionId)
    if (matchesVerification(exec, config.verificationTools)) {
      s.count += 1
      s.names = [...s.names, describeCall(exec)].slice(-config.window)
    } else {
      // A non-matching (e.g. write/edit) call resets the count AND clears any
      // armed one-shot denial — otherwise a legitimate write right after the
      // guard fired would still leave the NEXT read denied for no reason.
      s.count = 0
      s.names = []
      s.pending = false
    }

    if (s.count >= config.maxConsecutive) {
      const firedState = { count: 0, names: [], pending: config.action === 'deny' }
      state.set(sessionId, firedState)
      if (config.action === 'remind') {
        // Run the rest of the waterfall first, then ADD the reminder context
        // rather than replacing the decision outright — a `tools/post-execute`
        // listener earlier/later in the chain may also want to touch
        // `additionalContexts`, and short-circuiting here would silently drop
        // whatever `next()` would have produced.
        const downstream = await next()
        const reminder = createUserMessage({
          content: [{ type: 'text', text: reminderText(entry.descriptor.name, s.names) }],
          source: { kind: 'dsh-task-tool', form: 'notice', summary: boundContextSummary(`Verification-loop guard fired for "${entry.descriptor.name}".`) },
        })
        return { ...downstream, additionalContexts: [...(downstream.additionalContexts ?? []), reminder] }
      }
      return next()
    }
    state.set(sessionId, s)
    return next()
  }
}

/** `tools/pre-execute`: enforce the one-shot deny armed by the post-execute handler above. */
export function createPreExecuteHandler(tracked, state, config) {
  return async (exec, next) => {
    const sessionId = exec.agent?.session?.id
    const entry = sessionId === undefined ? undefined : tracked.get(sessionId)
    if (entry === undefined || isReadOnlyAgent(entry.descriptor)) return next()

    const s = state.get(sessionId)
    if (s.pending && config.action === 'deny' && matchesVerification(exec, config.verificationTools)) {
      state.set(sessionId, { ...s, pending: false })
      return { kind: 'deny', reason: `dsh-task-tool: verification-loop guard — agent "${entry.descriptor.name}" repeated ${config.maxConsecutive} verification-only calls; decide or write before calling "${exec.name}" again` }
    }
    return next()
  }
}
