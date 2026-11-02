/**
 * Tool schema + the core dispatch call: validate `subagent_type`, resolve
 * `agentOptions` through `ctx.modelTiers`, start the child, and shape the
 * result. Kept free of `ctx` so it is unit-testable against fakes.
 */

import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'

/** One `- name: description` line per catalog entry, for the enum's own description. */
function describeRoster(list) {
  if (list.length === 0) return 'No agents are configured (ctx.agentsMd is empty); every call is rejected.'
  return `Available:\n${list.map((d) => `- ${d.name}: ${d.description}`).join('\n')}`
}

/**
 * `defineTool` parameters for the `Task` tool. `subagent_type`'s enum (and
 * its description) is rebuilt from the live roster on every call site —
 * callers re-run this whenever `ctx.agentsMd.revision` changes.
 *
 * `agentsMd.list()` is async (it checks each preset's live activation
 * status before excluding a broken one — see dsh-agents-md's `createCatalog`).
 */
export async function buildParameters(agentsMd, config) {
  const list = await agentsMd.list()
  const names = list.map((d) => d.name)
  return {
    description: { type: 'string', required: true, description: 'A short (3-5 word) label for the delegated task; becomes the activation label.' },
    prompt: { type: 'string', required: true, description: "The task, delivered as the child's first user message." },
    subagent_type: {
      type: 'string',
      required: true,
      ...(names.length > 0 ? { enum: names } : {}),
      description: `Which agent to delegate to. ${describeRoster(list)}`,
    },
    ...(config.enableRunInBackground ? {
      run_in_background: {
        type: 'boolean',
        description: 'Run the subagent in the background and return its activation id immediately instead of waiting for its final answer.',
      },
    } : {}),
  }
}

/**
 * `agentOptions` for the child, or `undefined` when `ctx.modelTiers` is
 * absent (logged once) or when the resolver itself omits them (its
 * documented `model: inherit` case).
 *
 * Uses `modelTiers.resolveAgent({model, effort})` — the two-key form real
 * agent frontmatter uses. That method folds the agent file's own `effort:`
 * (e.g. `medium` -> `high`) over the tier default on the model-tiers side,
 * AND (as of this round) `dsh-agents-md` itself fills in a model-less
 * descriptor's `model` from its own configured `defaultModel`
 * (`dsh-agents-md/lib/catalog.js`) — so `descriptor.model` is never
 * `undefined` for a descriptor that came from the real catalog, and this
 * package does not carry a second fallback default of its own.
 */
export function resolveAgentOptions(descriptor, modelTiers, warnOnce) {
  if (modelTiers === undefined) {
    warnOnce('no-model-tiers', 'ctx.modelTiers is unavailable; agentOptions omitted, child inherits the parent route')
    return undefined
  }
  return modelTiers.resolveAgent({ model: descriptor.model, effort: descriptor.effort })
}

/** The child's final assistant text, joined from its text content blocks. */
export function extractText(blocks) {
  const text = (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
  return text === '' ? '(no output)' : text
}

/** Clear every piece of per-child state this plugin keeps, in one place. */
function untrackChild(childId, tracked, loopGuardState, forgetContextCap) {
  tracked.delete(childId)
  loopGuardState?.reset(childId)
  forgetContextCap?.(childId)
}

/**
 * Run one `Task` call: validate, resolve options, start the child, and
 * return either its final text (foreground) or `started <childId>`
 * (background). Throws on any failure — `defineTool`'s own pipeline turns a
 * thrown error into a normal errored tool result, never a crashed turn.
 *
 * @param deps `{agentsMd, modelTiers, subagents, config, tracked,
 *   loopGuardState, forgetContextCap, verifyIdentity, warnOnce}` —
 *   `tracked` is the shared `childSessionId -> {descriptor, parentAgent}`
 *   map the guards and the context cap read; `loopGuardState`/
 *   `forgetContextCap` are cleared for a child once it untracks, so a
 *   later, unrelated session id can never inherit a stale armed-denial or
 *   already-acted marker; `verifyIdentity(childId)` (optional) is called
 *   once a child is tracked, for the one-time guard-identity check (see
 *   `index.js`).
 * @param args validated tool arguments.
 * @param exec the calling `ToolRunContext` (`exec.agent`, `exec.signal`).
 */
export async function dispatchTask(deps, args, exec) {
  const { agentsMd, modelTiers, subagents, config, tracked, loopGuardState, forgetContextCap, verifyIdentity, warnOnce } = deps

  // agentsMd.get/.list/.presetId are async: a broken preset's activation
  // status is checked live, not cached at registration time.
  const descriptor = await agentsMd.get(args.subagent_type)
  if (descriptor === undefined) {
    const names = (await agentsMd.list()).map((d) => d.name)
    throw new Error(`unknown subagent_type "${args.subagent_type}"; available: ${names.join(', ') || '(none)'}`)
  }

  const presetId = await agentsMd.presetId(args.subagent_type)
  const agentOptions = resolveAgentOptions(descriptor, modelTiers, warnOnce)
  const runInBackground = config.enableRunInBackground === true && args.run_in_background === true

  // Reserve the child's identity BEFORE starting it (the `childId` overload
  // of `startActivation`, `dsh-subagent/lib/types/index.d.ts:135-139`) and
  // track it immediately — not after `startActivation` resolves. The
  // previous shape (`tracked.set(activation.childId, ...)` only after
  // `await subagents.startActivation(...)`) left a real window, between the
  // child actually starting its first turn and this call resolving, during
  // which the mask guard, the loop guard, and the context cap would all
  // silently no-op for it (DESIGN.md §4.2 names this gap).
  const childId = SessionId(randomUUID())
  tracked.set(childId, { descriptor, parentAgent: exec.agent })

  let activation
  try {
    activation = await subagents.startActivation({
      provider: config.provider,
      label: args.description,
      childId,
      signal: exec.signal,
      delivery: runInBackground ? 'caller' : 'parent',
      request: {
        parent: exec.agent,
        prompt: [{ type: 'text', text: args.prompt }],
        ...(presetId === undefined ? {} : { agentPreset: presetId }),
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(config.maxDepth === undefined ? {} : { maxDepth: config.maxDepth }),
        // No `signal` here: `SubagentActivationSpec.signal` (above) is the one
        // the host actually honours — every cancellation wire-up in
        // dsh-subagent/lib/index.js reads `spec.signal`, never `request.signal`
        // — so a second copy on `request` was dead weight, not redundancy.
      },
    })
  } catch (error) {
    untrackChild(childId, tracked, loopGuardState, forgetContextCap) // never started: nothing to guard
    throw error
  }

  verifyIdentity?.(childId)
  const untrack = () => untrackChild(childId, tracked, loopGuardState, forgetContextCap)

  if (runInBackground) {
    activation.result.then(untrack, untrack)
    return `started ${childId}`
  }

  let result
  try {
    result = await activation.result
  } finally {
    untrack()
  }
  if (result.stopReason !== 'completed') {
    const suffix = result.diagnostic ? `: ${result.diagnostic}` : ''
    throw new Error(`subagent "${args.subagent_type}" ended with stopReason "${result.stopReason}"${suffix}`)
  }
  return extractText(result.output)
}
