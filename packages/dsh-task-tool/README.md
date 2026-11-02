# @mdcode-cc/dsh-task-tool

**Status: implemented.** 71/71 unit tests pass. Real `dsh` run verifies dispatch end-to-end
(`PONG`, see "Implementation notes"); hardening (b) the context cap and (c) the loop guard are
**unit-tested only** — no real run has exercised a child crossing the context cap or tripping the
loop guard, because reliably forcing either condition from a live model turn was out of scope for
the 5-run budget this task used on dispatch + an unrelated environment bug (also in
"Implementation notes").

Written against host `0.2.1-rc.5` (`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`).

## Purpose

One model-facing `Task` tool with Claude Code's parameter names, dispatching to the agent presets
`@mdcode-cc/dsh-agents-md` registered. It owns two of the four hardening requirements: the
per-subagent context cap and the verification-loop guard.

## Why not just configure `@deepseek-ai/dsh-tool-subagent`

In `0.2.1-rc.5` that row already exposes a model-selectable preset: `allowedAgentPresets` is "a
non-empty allowlist exposing `agent_preset` to the model"
(`dsh-tool-subagent/lib/types/preset-selection.d.ts`). That gets 80% of the way there with zero
code, and the `cc` profile mounts it as a fallback. Three things it cannot do:

1. **Per-agent model tier.** Its `agentOptions` is one value for the whole row
   (`dsh-tool-subagent/lib/types/index.d.ts`, "Agent options applied to every child"). The roster
   needs `haiku`/`sonnet`/`opus` per agent, which means the `agentOptions` must be computed from
   the selected agent at call time.
2. **Claude Code's parameter contract.** `description`, `prompt`, `subagent_type` — so ported
   `~/.claude/skills/*` bodies and existing muscle memory keep working.
3. **The tool mask.** `tools` / `disallowedTools` per agent file.

So this package calls `ctx.subagents.startActivation()` directly.

## Inputs

No files. Everything comes from `ctx.agentsMd` (the catalog) and `ctx.modelTiers` (the alias
resolver). The tool's parameter enum is rebuilt whenever `ctx.agentsMd.revision` changes.

## Tool contract

```
Task(description: string, prompt: string, subagent_type: string,
     run_in_background?: boolean)
```

- `description` — 3–5 word label; becomes the activation's `label`.
- `prompt` — the task, delivered as the child's first user message.
- `subagent_type` — an agent name from `ctx.agentsMd.list()`. The schema carries the enum and
  each agent's `description`, the way Claude Code's own Task tool does.
- `run_in_background` — foreground waits for the child's final text; background returns the
  activation id. Gated by config.

## dsh seams used

| seam | kind | why | verified in |
|---|---|---|---|
| `ctx.tools.register(defineTool({…}))` | tool registration | the `Task` tool | `dsh-tools/README.md` "Register a tool"; `defineTool` exported at `dsh-tools/lib/types/index.d.ts:24`, declared `schema.d.ts:248` |
| `ctx.subagents.startActivation(spec)` | service call | start the child | `dsh-subagent/lib/types/index.d.ts:135,145` |
| `SubagentActivationSpec` `{provider, label, request, signal, delivery}` | type | the start spec | `dsh-subagent/lib/types/types.d.ts` |
| `SubagentStartRequest` `{prompt, parent, signal, agentPreset?, agentOptions?, cwd?, outputSchema?, maxDepth?}` | type | the per-call overrides available | same file — note there is **no** `persona` and **no** `toolFilter` field; those moved to the preset in rc.5 (`child-agent.d.ts`: `ChildComposition.persona` / `.toolFilter` are "reapplied only during cold resume") |
| spawn provider `capabilities.agentPreset === true` | capability | independent preset selection is legal on `spawn` | `dsh-subagent-spawn-in-process/lib/index.js:23`; README: "Only spawn supports this choice. Persona and tools belong in the preset definition." |
| ~~`ctx.on('subagent/start')` / `ctx.on('subagent/end')`~~ **not used** | — | `startActivation()`'s own return already carries `childId` synchronously at the call site, and `activation.result` settling is the untrack signal — binding/unbinding `tracked` there is race-free for concurrent dispatches in a way correlating a global event by arrival order is not. See "Implementation notes". | — |
| `ctx.on('tools/pre-execute')` | waterfall (allow/deny/ask) | enforce the per-agent tool mask for a child | `dsh-tools/README.md` "Enforce policy on calls" |
| `ctx.on('tools/post-execute')` | waterfall | count verification-only calls for the loop guard | same |
| `ctx.tokenMeter.measure(session)` → `{totalTokens, surfaceTokens, nodes}` | service call | measure the child's context pressure | `dsh-token-meter/README.md` "Measuring pressure"; `lib/types/index.d.ts:46` |
| ~~`ctx.subagents.listChildren(parentSessionId, signal?)`~~ **not used** | — | `agent/pre-step`'s own payload already carries the live child `Agent` (`payload.agent`) when that agent IS the tracked child — no separate discovery call is needed to reach it for measurement. | — |
| `ctx.effect(…)` | cleanup | dispose the tool, the listeners and any live activation | cordis cleanup seam |

## Config schema (schemastery)

```ts
export const Config = z.object({
  provider: z.string().description('ctx.subagents provider to start children on.').default('spawn'),
  toolName: z.string().description('Model-facing tool name.').default('Task'),
  enableRunInBackground: z.boolean().description('Expose run_in_background.').default(true),
  maxDepth: z.natural().description('Absolute delegation depth cap; 0 forbids delegation.').default(1),

  // hardening (b)
  subagentContextCap: z.natural().description('Per-child total-token ceiling before action; 0 disables.').default(150000),
  contextCapAction: z.union(['compact', 'steer', 'stop']).description('What to do at the cap.').default('steer'),

  // hardening (c)
  loopGuard: z.object({
    verificationTools: z.array(z.string()).description('Tool-name patterns treated as verification-only.').default(['read', 'grep', 'glob', 'bash:*status*', 'bash:*--version*', 'bash:ls*']),
    window: z.natural().description('Max recent call descriptions retained for the reminder text (not itself a counting threshold — see maxConsecutive).').default(8),
    maxConsecutive: z.natural().description('Count at which the guard fires; 0 disables.').default(6),
    action: z.union(['remind', 'deny']).description('Inject a reminder, or deny the next verification call.').default('remind'),
  }).default({}),
})
```

## Behaviour

**Dispatch.**
1. Validate `subagent_type` against `ctx.agentsMd`. An unknown name is a normal errored tool
   result listing the available names — never a throw.
2. Resolve `agentOptions` from the descriptor's `model` + `effort` through
   `ctx.modelTiers.resolveAgent({model, effort})` — the two-key form, not `resolve(name)`; when
   `ctx.modelTiers` is absent, omit `agentOptions` entirely so the child inherits the parent route
   (documented degradation, logged once).
3. `startActivation({ provider, label: description, signal: exec.signal,
   delivery: run_in_background ? 'caller' : 'parent',
   request: { parent: exec.agent, prompt: [{type:'text', text: prompt}],
              agentPreset: ctx.agentsMd.presetId(subagent_type),
              agentOptions, maxDepth } })` — no `signal` on `request` itself: every cancellation
   wire-up in `dsh-subagent/lib/index.js` reads the outer `spec.signal`, never `request.signal`,
   so a second copy there was dead weight.
4. Foreground: `await activation.result` and return its final assistant text. Background: return
   `started <childId>`. Either way, `activation.childId` (returned synchronously by
   `startActivation`, not learned later from an event) is recorded in `tracked` immediately and
   removed once `activation.result` settles — never via `subagent/start`/`subagent/end`.

**Tool mask.** At dispatch time (see above — not on a `subagent/start` event), record
`childSessionId → descriptor`. A `tools/pre-execute` listener whose calling agent's session id is
in that map denies any tool outside `dshTools` or inside `dshDisallowedTools` — `dsh-agents-md`'s
dsh-tool-name-normalized versions of the agent file's `tools`/`disallowedTools` (its own CC names
like `Bash`/`Edit` don't match any real dsh tool name) — with a reason naming the agent file. This
is a **deny guard, not a catalog mask** — the child still *sees* the tool in its schema list and
will sometimes try it and get denied, costing one wasted step. The faithful alternative is
`ctx.tools.restrict(filter)` (`dsh-tools/lib/types/index.d.ts:645`), but a restriction must be
installed in the child's own registration scope, and `startActivation` exposes no setup hook to
reach it — so a per-call mask needs the mask to live in the preset instead. See DESIGN Q2.

**(b) Per-child context cap.** On each `agent/pre-step` for a tracked child agent, measure the
child's session with `ctx.tokenMeter.measure(session).totalTokens`. Above `subagentContextCap`:
- `steer` (**default**) — `agent.steer(...)` one message telling the child to write its findings
  and finish. Documented as the inverse control in `dsh-agent/lib/types/runtime-types.d.ts`
  (`agent/turn-stopping`: "a listener that objects steers (`agent.steer(...)`)").
- `compact` (**opt-in**) — `ctx.compaction.compactIfNeeded(agent, 'pressure', signal)`, **not**
  `compactNow`: `compactNow` wraps `agent.runMaintenance` and requires an idle agent, throwing
  `ManualCompactionError('busy', ...)` whenever the agent has active turn work
  (`dsh-compaction-basic/lib/index.js` ~985-1010; `dsh-agent-loop/lib/index.js` ~822-823) — exactly
  the state an `agent/pre-step` listener always runs in. `compactIfNeeded(agent, trigger, signal)`
  is the per-step pressure API `dsh-compaction-basic` itself calls from this same position with
  trigger `'pressure'`/`'context-overflow'` and does not require idleness
  (`dsh-compaction/lib/types/index.d.ts:116`). Any failure (including the above, were this ever
  pointed at `compactNow`) falls back to `steer` rather than failing the child's step.
- `stop` — interrupt the child through `ctx.subagents` interrupt and settle the Task result with
  a truncation notice, so the parent learns the child was cut off rather than silently thinned.

Note: with `deepseek-flash`'s 1,048,576-token window (`dsh-llm-deepseek/README.md`; the
`1,000,000` figure is that package's `defaultContextWindow`, the fallback for models without an
exact value — not this model's), the host's own compaction trigger
`floor(min(W × 0.8, W − O − 65536))` lands around 800k. A 150k cap is therefore **this plugin's
policy, not a capacity limit** — its purpose is cost and adherence, not avoiding overflow. That
is the honest framing and it belongs in the pilot's cost column.

**(c) Verification-loop guard.** A `tools/post-execute` listener counts consecutive calls, per
child agent, whose tool name matches `verificationTools` (bash commands matched on the command
string, hence the `bash:*` pattern form). Any non-matching call (a write/edit) resets the count
**and** clears any armed one-shot denial — a legitimate write must not leave the next read denied.
A new user/steer message also resets the count (`agent/pre-step` with non-empty `messages`). At
`maxConsecutive` the guard either injects one reminder naming the last N calls and asking for a
decision, or arms a one-shot denial enforced on the next matching call via `tools/pre-execute`.
**Skipped entirely for a read-only agent** — one whose normalized `dshTools` (or, absent that, its
raw `tools`) contains no `edit`/`write` tool (`bash` does NOT count — every real
reviewer/researcher agent keeps `bash` for read-only shell use while the mask guard separately
denies it `edit`/`write`, so counting `bash` against the exemption would have exempted nobody on
the real roster; see "Third pass") — since that agent's job IS to read many things and answer in
its own final text; nagging it every `maxConsecutive` calls is noise, not signal.

This is deliberately **not** `@deepseek-ai/dsh-repeat-tool-reminder`, which fires only on *exact*
repeats — "same tool, same arguments regardless of property order", and explicitly warns that
"near-identical variants must be caught" is out of scope
(`dsh-repeat-tool-reminder/README.md`). The observed failure is a child re-reading and
re-grepping with *varying* arguments and never writing anything. Both can be mounted; they catch
different shapes.

## Failure modes

- **`ctx.agentsMd` empty.** The tool registers with an empty enum and every call returns an
  errored result saying no agents are configured. It does not refuse to mount — a profile with no
  agent files must still start.
- **Provider lacks `agentPreset`.** `fork` does not advertise it
  (`dsh-subagent-fork-in-process/README.md`: "independent preset selection is unsupported"). With
  such a provider the tool omits `agentPreset`, so the child joins the parent's composition and
  gets **no persona** — the agent's prompt is lost. The tool must detect this at mount from the
  provider's declared capabilities and refuse to mount rather than silently degrade, because a
  persona-less child that still answers is the exact kind of quiet failure that is invisible in a
  transcript.
- **Depth cap reached.** `startActivation` rejects; return an errored tool result verbatim. The
  tool stays visible at the cap by host design ("the tool remains model-visible so runtime policy
  owns rejection", `dsh-tool-subagent/lib/types/index.d.ts`).
- **`ACTIVATION_LIMIT_REACHED`.** The host caps live continuable children at `maxActiveSubagents`
  (default 8) and does not queue (`dsh-subagent/README.md`). Surface the code as the tool result
  and say to wait; do not retry in a loop.
- **Child fails or is cancelled.** `SubagentResult.stopReason` plus the provider diagnostic go
  into the tool result unchanged. No summarising, no re-dispatch.
- **`tools/post-execute` ordering.** Several plugins can rewrite a tool result on this waterfall
  and the host offers no priority primitive beyond registration order and a `prepend` flag. The
  `@dsh-cc` stack coordinates a dozen such listeners purely through YAML row order and code
  comments. This guard therefore `await next()`s first and only ever ADDS its reminder to
  `additionalContexts` on top of whatever the rest of the waterfall produced — it never returns a
  bespoke decision in its place — so its own position in registration order cannot matter. (An
  earlier draft returned its own decision without calling `next()` first, which *did* truncate the
  waterfall; fixed — see "Implementation notes".)

## What it explicitly does NOT do

- Does not parse agent markdown (that is `dsh-agents-md`) or resolve model names (that is
  `dsh-model-tiers`).
- Does not register the presets it dispatches to.
- Does not implement worktree isolation. `@dsh-cc/subagent-task` does, and documents its own
  version as partial ("the child's `header.cwd`, the harness sandbox root, and the bash default
  workdir stay the parent's — only the session-cwd overlay moves"). A partial isolation that
  reads as real is worse than none; the `cc` profile runs lanes in the main tree with disjoint
  paths, as a single-tree lane workflow already requires.
- Does not enforce `permissionMode`. A delegated child's approval policy is pinned to `never` at
  the delegation boundary (`dsh-subagent/lib/types/child-agent.d.ts`,
  `DelegatedPolicyOverrides`).
- Does not enforce `maxTurns` as a hard cap — `SubagentStartRequest` has no turn budget. The
  context cap is the de-facto bound, and the descriptor's `maxTurns` is rendered into the child's
  prompt as a budget statement instead. That is advisory and must be reported as advisory.

## Test plan

`node:test` with a fake `ctx` (`tools`, `subagents`, `agentsMd`, `tokenMeter`, `logger`), because
the whole surface is "given these service calls, make those service calls".

1. **Dispatch**: a known `subagent_type` produces exactly one `startActivation` with the expected
   `agentPreset`, `agentOptions`, `label`, `delivery`; an unknown one returns an errored result
   and starts nothing; `run_in_background: false` awaits `result`, `true` does not.
2. **Schema refresh**: bumping `agentsMd.revision` changes the advertised enum.
3. **Degradations**: no `ctx.modelTiers` → `agentOptions` omitted and warned once; provider
   without `agentPreset` → mount refused with a message naming the provider.
4. **Tool mask**: a child in the map calling an out-of-allowlist tool is denied with the agent
   name in the reason; the same call from the parent is untouched; `disallowedTools` wins over
   `tools`.
5. **(b) Context cap**: a stubbed `tokenMeter` crossing the cap triggers exactly one action per
   child (not once per step, and `acted` is only marked after the action completes — a failed
   attempt is free to retry on the next pre-step); each of `steer` / `stop` takes its path;
   `compact` calls `compactIfNeeded(agent, 'pressure', signal)` (never `compactNow`) and falls back
   to `steer` on any failure, including a stubbed `ManualCompactionError`; `forget(childId)`
   clears the per-child marker.
6. **(c) Loop guard**: 6 consecutive verification calls fire once; a write resets the count; a
   new user message resets it; `bash` matched on its command string, not its tool name;
   `maxConsecutive: 0` disables.
7. **Failure passthrough**: a rejecting `startActivation` and a failing child both surface their
   code and diagnostic verbatim in the tool result.
8. **Teardown**: `ctx.effect` disposers unregister the tool and every listener; a live background
   activation is disposed.

`@deepseek-ai/dsh-agent-loop-testkit@0.2.1-rc.5` would be the right tool for an end-to-end
pre-step/post-execute test and is worth adding once it resolves from the registry; it is **not**
vendored in the host install, so the plan above does not depend on it.

## Estimated size

~520 lines: `index.js` (mount, tool, dispatch — ~180), `mask.js` (~70),
`context-cap.js` (~90), `loop-guard.js` (~120), `render.js` (~60).

## Implementation notes (post-build)

Actual size (after the review-round fixes below): `index.js` 147, `lib/dispatch.js` 142,
`lib/guards.js` 39, `lib/context-cap.js` 95, `lib/loop-guard.js` 143 — one fewer file than
estimated (`guards.js` absorbed the "render" bits; there was never enough presentation logic to
earn its own file).

### Deviations from this spec, and why

- **No `lib/mask.js`** — named `lib/guards.js` instead, per the task's explicit instruction to
  split by "dispatch, guards, context-cap, loop-guard" (not "mask, render").
- **No `subagent/start`/`subagent/end` listeners.** `ctx.subagents.startActivation()` already
  resolves with `activation.childId` synchronously at the call site, and `activation.result` is
  the exact signal needed to untrack a child — so `tracked` (`childSessionId -> {descriptor,
  parentAgent}`) is populated and cleared directly inside `dispatchTask`, never by listening for
  a global event. Using the global event would have meant correlating *which* `subagent/start`
  belongs to *which* concurrent `Task` call purely by arrival order, which the event payload does
  not disambiguate when two different `subagent_type`s are dispatched concurrently. The direct
  approach is race-free and simpler; `ctx.subagents.listChildren()` was never needed either.
- **`ctx.modelTiers.resolveAgent({model, effort})`, not `resolve(name)`.** The spec's seam table
  named `resolve()`; the real sibling (confirmed by reading `dsh-model-tiers/lib/aliases.js` after
  it landed mid-task) exposes a *third* function, `resolveAgent({model, effort})`, built exactly
  for this two-key case and already folding `effort: medium -> high` over the tier default. This
  package calls that function and does not re-implement the fold.
- **`ctx.agentsMd.list()` / `.get()` / `.presetId()` are async**, not sync as the original stub
  implied. `dsh-agents-md` moved its broken-preset check out of `apply()` (a documented deadlock
  hazard) into a lazy, per-call `await ctx.agentPresets.resolve(presetId)` inside the catalog.
  Every call site here awaits them; the tool's schema refresh (`doRefresh()` in `index.js`) is
  serialised through one promise chain so an overlapping revision bump cannot race a
  dispose/register pair.
- **`console.error` mirroring is opt-in** (`mirrorLogsToConsole`, default `false`), not
  unconditional as an early draft had it — the coordinator flagged that the profile is getting its
  own logger-exporter row, so a permanent console mirror would double-log once that lands.
- **`createUserMessage` from `@deepseek-ai/dsh-llm`** builds every message this plugin hands to
  `agent.steer()` or returns as `additionalContexts` (the context-cap wrap-up nudge, the loop-guard
  reminder) — a plain object literal has no `id`, which the real `UserMessage` type requires.
- **Tool-name vocabulary gap — RESOLVED this round, no longer a limitation.** `dsh-agents-md`
  landed `dshTools`/`dshDisallowedTools` on its descriptor (its own `lib/tool-names.js`, a verified
  CC-name -> dsh-name table). `lib/guards.js` now matches against those normalized fields with an
  exact (not case-folded) comparison, never the raw CC `tools`/`disallowedTools`. See "Second pass"
  below.
- **`model: inherit`** is handled (`resolveAgentOptions` passes the resolver's `undefined` straight
  through so `agentOptions` is omitted), matching `dsh-model-tiers`' documented `INHERIT` case, even
  though no agent file in the real roster uses it today.

### Real integration run

`DSH_HOME=$HOME/.dsh dsh --profile headless --patch /tmp/task-tool.overlay.yml "Use the Task tool
with subagent_type 'tester' and prompt 'reply with the single word PONG'. Then reply with exactly
what the subagent returned."` — final model output: **`PONG`**.

Getting there took the full 5-real-run budget because of one genuine, pre-existing environment
problem found along the way, **not a dsh-task-tool bug**: `dsh-agents-md`'s own documented
`inheritPlugins` row set (its README's "Q7 — real-mount verification (resolved)", copied verbatim
into `/tmp/agents-md.overlay.yml`) does not actually mount clean on this host snapshot. A
diagnostic probe plugin (`ctx.agentPresets.resolve('cc-tester')`, called with no changes to any
package in this repo) returned:

```
"broken": "e17e059a (@deepseek-ai/dsh-tool-fs-search): invalid config:\n  - $.sampleOverCapGlobResults missing required value (at sampleOverCapGlobResults)\n8df5bc5a (@deepseek-ai/dsh-tool-todo): invalid config:\n  - $.allowParallelInProgress missing required value (at allowParallelInProgress)"
```

`dsh-tool-fs-search`'s `sampleOverCapGlobResults` and `dsh-tool-todo`'s `allowParallelInProgress`
are both declared with **no default** in this host install ("an explicit deployment choice" per
the former's own doc comment), so every one of the 15 real presets failed to activate for the
identical reason and `ctx.agentsMd.list()` returned `[]` for all of them — which is exactly the
"unknown subagent_type \"tester\"; available: (none)" error the first real run of this task
produced. This is a `dsh-agents-md`/host-config gap, confirmed by probing `ctx.agentPresets`
directly with no `dsh-task-tool` code involved, and it is reported here rather than patched in
that package (out of scope for this task). The fix applied only to this task's own scratch overlay
(`/tmp/task-tool.overlay.yml`, not any file in this repo): add explicit `config: {
sampleOverCapGlobResults: false }` / `config: { allowParallelInProgress: false }` to those two
`inheritPlugins` rows. With that, the roster populated and the run above produced `PONG`.

A second, smaller finding along the way: `ctx.agentPresets.resolve(id)` can throw
`RemoteError: Unknown agent preset: <id>` when called immediately after mount, before the registry
has settled — a one-shot probe plugin hit this on its first call and got a real answer (broken or
not) only after a short delay. `dsh-task-tool` itself never calls `ctx.agentPresets` directly (it
only reads `ctx.agentsMd`, which is `dsh-agents-md`'s problem to settle), so this did not surface
in the tool's own dispatch path, but it is worth flagging for whoever owns that catalog.

**What was verified, and how:**

- **Activation**: the final run above returned `PONG`, the bare completion text of a child agent
  given the prompt "reply with the single word PONG" — proof the `Task` tool call, the
  `startActivation()` call, the `cc-tester` preset's mount, and the foreground `await
  activation.result` path all worked end to end on the real host.
- **Whether the model called `Task`**: yes, confirmed both by the failing first run (whose error
  text — "unknown subagent_type" — can only come from `dispatchTask()` actually executing) and by
  the successful final run's output.
- **The child preset activated**: `cc-tester` (`presetIdPrefix: 'cc-'` + agent name `tester`, per
  `dsh-agents-md`'s `presetId()`). Not independently re-logged in the final run (`ctx.logger` has
  no console exporter in this profile, confirmed by the sibling packages' own implementation
  notes, and this package does not mirror info-level activation detail to console by design —
  only warnings, and only when `mirrorLogsToConsole` is set); inferred from the successful `PONG`
  result plus the diagnostic run's direct confirmation that `cc-tester` resolves cleanly once the
  two config fields above are supplied.
- **Resolved model/effort for `tester`**: confirmed by calling the real, unmodified
  `dsh-model-tiers` resolver directly (`node -e "...createResolver(...).resolveAgent({model:
  'sonnet', effort: 'medium'})"`, no `dsh` process, no LLM call — not part of the 5-run budget) —
  `{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"high"}`, i.e.
  **sonnet -> deepseek-flash/high**, exactly as expected from `tester.md`'s `model: sonnet` /
  `effort: medium` frontmatter. This is the real sibling function; nothing about this call was
  mocked or simulated.
- **What could not be verified directly**: the per-request `model-tiers: turn=... provider=...
  model=... effort=...` log line and the `dsh-agents-md: registered N preset(s): ...` line are both
  `ctx.logger.info` calls, invisible on this profile's stdout/stderr by the same host fact the
  sibling packages' own READMEs document (no console exporter wired for `ctx.logger` in shipped
  profiles) — confirmed again here, not assumed. Within the 5-real-run budget, no run was spent
  installing a throwaway logger exporter to capture those lines verbatim (the siblings' own
  verification sections did this once each; repeating it for this package was not worth a 6th run
  given the two facts above were independently confirmable without one).

## Second pass (review findings fixed)

Ten numbered findings from a coordinator review, fixed in this package only (plus
`docs/DESIGN.md` lines ~113/~227, explicitly authorized). File:line references are against the
state right before this pass; see the sections above for the corrected text/code.

1. **`lib/context-cap.js:59` (BLOCKING) — `compactNow()` requires an idle agent.** Fixed: the
   `compact` branch now calls `compaction.compactIfNeeded(agent, 'pressure', signal)` — the
   per-step pressure API `dsh-compaction-basic` itself calls from the same `agent/pre-step`-style
   position, confirmed by reading `dsh-compaction-basic/lib/index.js` (`compactIfNeeded` works
   directly on `agent.session`, never calls `agent.runMaintenance`, unlike `compactNow`). Wrapped
   in try/catch falling back to `steerToWrapUp(agent)`. `acted.add(sessionId)` moved to run only
   after `applyCapAction` completes (was: before). Test:
   `test/context-cap.test.js` — "a failed action still marks 'acted'" and "compact falls back to
   steer when compactIfNeeded throws (e.g. a ManualCompactionError)".
2. **`index.js:27` (BLOCKING) — default `contextCapAction` must be `'steer'`.** Fixed in
   `index.js` (`Config`) and in this README's two copies of that schema line. `docs/DESIGN.md:113`
   (the only stale copy; `:227` already said `steer`) rewritten to match and to describe
   `compactIfNeeded`, not `compactNow`.
3. **`lib/loop-guard.js:72-73` — a non-matching call must also clear `pending`.** Fixed: the
   `else` branch (non-matching call) now sets `s.pending = false` alongside the count reset. Test:
   `test/loop-guard.test.js` — "a non-matching (write) call also clears a pending one-shot denial".
4. **Loop-guard exemption for read-only agents.** Added `isReadOnlyAgent(descriptor)` in
   `lib/loop-guard.js`, checked at the top of both `createPostExecuteHandler` and
   `createPreExecuteHandler`. Reads `descriptor.dshTools` (landed this round from
   `dsh-agents-md`), falling back to lowercased `descriptor.tools` when `dshTools` is absent.
   Exempt only when the list is **non-empty** and contains no `edit`/`write` tool — an *empty*
   list means "inherits everything" per `dsh-agents-md`'s own README, which includes write tools,
   so it is deliberately NOT treated as read-only.
   **UPDATE (third pass): `bash` was originally in the write-capable check too**, which — as
   flagged here in the second pass — exempted nobody on the real roster, since every
   reviewer/researcher-shaped agent (`reviewer`, `qa-engineer`, `security-reviewer`,
   `strategy-reviewer`, `hygiene-reviewer`, `product-specialist`, `db-steward`, `measurer`,
   `release-engineer`, `tester`) keeps `bash` in its `tools:` allowlist for read-only shell use
   (`git diff`, `cat`, ...) while excluding `Edit`/`Write` via `disallowedTools:`. Confirmed
   correct by the coordinator and fixed: `WRITE_CAPABLE_DSH_TOOLS` is now `{edit, write}` only —
   `bash`'s presence no longer disqualifies the exemption. This is a roster *convention*
   (`bash` kept for read-only shell use), not a dsh-host sandboxing guarantee — the mask guard
   (`lib/guards.js`) is what actually blocks a reviewer's `edit`/`write` calls; this exemption
   only decides whether the loop guard nags it. Tests: `test/loop-guard.test.js` —
   `isReadOnlyAgent` unit tests (now asserting `bash`-present-without-edit/write IS exempt) and
   the "read-only agents are exempt" integration test, now using a `reviewer`-shaped descriptor
   WITH `bash` in `dshTools` — matching the real `reviewer.md` shape exactly, not a hypothetical
   one.
5. **`lib/dispatch.js:115` — `untrack` must also clear loop-guard/context-cap state.**
   `createContextCapHandler` now returns `{handle, forget}` (was: a bare function); `forget(childId)`
   deletes that child's `acted` marker. `dispatchTask`'s `untrack` (both the foreground `finally`
   and the background `.then(untrack, untrack)` paths) now also calls
   `loopGuardState?.reset(childId)` and `forgetContextCap?.(childId)`. `index.js` threads
   `loopGuardState` and `contextCap.forget` into the `dispatchTask` deps. Tests:
   `test/dispatch.test.js` — "untrack also clears loopGuardState and the context-cap 'acted'
   marker" (foreground and background variants) and a tolerance test for the deps being absent
   (optional chaining).
6. **`lib/loop-guard.js:80-83` — the `remind` branch truncated the `tools/post-execute`
   waterfall.** Fixed: it now `await next()`s first, then returns
   `{...downstream, additionalContexts: [...(downstream.additionalContexts ?? []), reminder]}` —
   adding to whatever the rest of the waterfall produced rather than replacing it outright. Fixed
   the matching README claim (the "`tools/post-execute` ordering" failure mode, previously implying
   this was already true by construction when the code did not actually guarantee it). Test:
   `test/loop-guard.test.js` — the remind test now asserts `next()`'s own `value` and
   `additionalContexts` both survive alongside the guard's own addition.
7. **`lib/dispatch.js:7` + `:52-56` — `DEFAULT_MODEL_ALIAS` and its comment were stale.**
   `dsh-agents-md` now applies its own `defaultModel` to a model-less descriptor
   (`lib/catalog.js:54`, confirmed by reading the current source). Deleted the constant, the
   fallback (`descriptor.model ?? DEFAULT_MODEL_ALIAS` -> `descriptor.model`), the comment
   claiming otherwise, and the vacuous unit test
   (`test/dispatch.test.js:50-55`, "falls back to the sonnet alias...") that only exercised this
   package's own now-removed workaround.
8. **Deny guard switched to `dshTools`/`dshDisallowedTools`.** `lib/guards.js` reads those two
   normalized fields (confirmed exact field names and shape — arrays of real lowercase dsh tool
   names like `'bash'`, `'edit'` — by reading `dsh-agents-md/lib/catalog.js` and
   `lib/tool-names.js`, both landed this round) instead of the raw CC `tools`/`disallowedTools`,
   with an exact (not case-folded) name comparison now that both sides use the same vocabulary.
   **Verified on the real host** (see "Real integration runs, second pass" below): a real `tester`
   child's attempt to call `send_message` (not in its `dshTools`) was denied with
   `"send_message" is not in the tools allowlist for agent "tester"`, while its `bash` call (in
   its `dshTools`) went through and returned real `pwd` output.
9. **`index.js` 1 Hz `setInterval` — prefer `ctx.agentsMd.onChange(cb)`.** `dsh-agents-md` had not
   landed `onChange` as of this pass (`grep -rn onChange` on its current source: no match), so
   `index.js` checks `typeof ctx.agentsMd.onChange === 'function'` at mount and subscribes if
   present; otherwise it falls back to a plain interval, now at **5000ms** (was 1000ms) via
   `FALLBACK_REFRESH_INTERVAL_MS`. Both paths' disposers are unified under one `stopWatching()`
   called from `ctx.effect`. Tests: `test/smoke.test.js` — "subscribes to
   ctx.agentsMd.onChange(refresh) when present, instead of polling" and "falls back to a 5s
   polling interval when ... absent".
10. **Minor cleanup:**
    - Dropped `signal` from `request` in `lib/dispatch.js` (`SubagentActivationSpec.signal`, the
      top-level one, is what every cancellation wire-up in `dsh-subagent/lib/index.js` actually
      reads — confirmed by grepping that file for `spec.signal` vs `request.signal`: only the
      former appears).
    - `lib/context-cap.js` and `lib/loop-guard.js` now build every message with
      `form: 'notice', summary: boundContextSummary(...)` instead of an invented `form` string —
      `ContextForm` is a closed union (`instructions | catalog | snapshot | notice | relay |
      recall`, `dsh-llm/lib/types/message.d.ts:46-58`) and `'notice'` specifically requires a
      `summary` field, confirmed by reading that file's `ContextFormed` discriminated type.
    - README staleness fixed: the seam-table rows for `subagent/start`/`subagent/end` and
      `listChildren` now say **not used** and why (direct binding at the `startActivation()` call
      site; `agent/pre-step`'s own payload already carries the live child `Agent`); the status
      header now says hardening (b)/(c) are **unit-tested, not run-verified** (this pass's 2 real
      runs exercised dispatch + the mask guard, not the context cap or the loop guard — forcing
      either from a live model turn reliably was out of scope for a 2-run budget); the `window`
      config description (`index.js`, README's Config-schema block, and the test-plan prose) now
      says it bounds the reminder text's retained call descriptions, not a counting threshold
      (`maxConsecutive` is the counting threshold).
    - **Left alone, out of the authorized scope**: `docs/DESIGN.md:424` (the Q3 section) still
      describes `contextCapAction: 'compact'` as `ctx.compaction.compactNow(agent, signal)` — also
      stale after fix 1 above, but this pass's authorization was "`docs/DESIGN.md` lines ~113 and
      ~227 only," so it is reported here rather than touched.

### Real integration runs, second pass

Both runs reused `/tmp/task-tool.overlay.yml` (a shared scratch file; another concurrent session
had since flipped `allowParallelInProgress` to `true` and added its own unrelated
`diagnose-presets.mjs` row — both harmless to this verification and left as found).

**Run 1 — regression check**, same prompt as the first pass:

```
$ DSH_HOME=$HOME/.dsh dsh --profile headless --patch /tmp/task-tool.overlay.yml \
    "Use the Task tool with subagent_type 'tester' and prompt 'reply with the single word PONG'. \
     Then reply with exactly what the subagent returned."
...
PONG

(Note: I attempted to send this result to the parent agent via `send_message`, but that tool is
not in this agent's allowlist — the call was rejected with: `"send_message" is not in the tools
allowlist for agent "tester"`. The parent will need to read this reply directly.)
```

Unplanned but valuable: the child itself tried `send_message` (a real dsh tool, not in Claude
Code's or `tester.md`'s vocabulary) and the mask guard denied it live, by name, using the new
`dshDisallowedTools`/`dshTools` fields — direct proof finding 8 works against a real descriptor,
not just a fake one in a unit test. The Task tool's own foreground path still returned the child's
final text correctly despite that denied side call.

**Run 2 — legitimate allowed call**, to confirm the mask guard's *allow* path alongside run 1's
*deny* evidence:

```
$ DSH_HOME=$HOME/.dsh dsh --profile headless --patch /tmp/task-tool.overlay.yml \
    "Use the Task tool with subagent_type 'tester' and prompt 'Run the shell command: pwd — then \
     reply with exactly its output, nothing else.'. Then reply with exactly what the subagent \
     returned."
...
/path/to/the/repo
```

The child's real `bash` call (`pwd`, in `tester`'s `dshTools`) was not denied and its output
round-tripped correctly through `dispatchTask`'s foreground `await activation.result` path.

**What these two runs did NOT exercise** (budget was 2 runs for this pass): the context cap
(`compactIfNeeded`/`steer`/`stop` branches) and the loop guard (counting, reminding, denying,
read-only exemption) — neither condition is reliably forced by a short prompt. Those remain
unit-tested only, stated plainly in the status header above, not glossed over.

## Third pass (two follow-ups + the authorized DESIGN.md Q3 rewrite)

1. **Mask guard denied harness-internal tools with no Claude Code counterpart.** The live run in
   "Second pass" caught `tester`'s own `send_message` call being denied
   (`"send_message" is not in the tools allowlist for agent "tester"`) even though no Claude Code
   tool concept names `send_message` at all — an agent file's `tools:`/`disallowedTools:` cannot
   express an opinion about a tool it has no vocabulary for, so treating "absent from a CC-shaped
   allowlist" as "denied" was denying the child its own plumbing by omission.

   Fixed in `lib/guards.js`: the deny guard now applies only when `exec.name` is a member of
   `KNOWN_DSH_TOOL_NAMES` — the flattened codomain of `dsh-agents-md`'s
   `CC_TO_DSH_TOOL_NAMES` table (`read`, `read_image`, `edit`, `write`, `grep`, `glob`, `bash`,
   `skill`, `web_fetch`, `web_search`, `todo_write`, `Task`). Anything outside that set (`send_message`,
   `ask_user_question` if a composition's `dsh-tool-ask-user` row is ever reached through this
   guard, any other dsh-tui preset-row tool with no CC counterpart) passes through untouched,
   regardless of `dshTools`/`dshDisallowedTools`.

   **Why this is a duplicated constant, not an import**, checked empirically rather than assumed:
   `@mdcode-cc/dsh-agents-md`'s `package.json` `exports` map publishes only `"."` and
   `"./package.json"` — `import('@mdcode-cc/dsh-agents-md/lib/tool-names.js')` rejects with
   `ERR_PACKAGE_PATH_NOT_EXPORTED`, and `Object.keys(await import('@mdcode-cc/dsh-agents-md'))` is
   `['Config', 'apply', 'default', 'inject', 'name']` — no re-export of the table, and
   `ctx.agentsMd` itself (`list`/`get`/`presetId`/`revision`) exposes no such accessor either.
   Both import paths the finding suggested were tried and both are genuinely closed today, so
   `KNOWN_DSH_TOOL_NAMES` in `lib/guards.js` is a hand-kept duplicate with a comment pointing at
   `dsh-agents-md/lib/tool-names.js` as the source of truth — syncing it is a cross-package
   follow-up outside this plugin's own scope (this plugin was authorized to touch only itself plus
   the two named `DESIGN.md` locations).

   Tests: `test/guards.test.js` — "a harness-internal tool with no CC counterpart (send_message)
   is never denied", "...even when dshDisallowedTools would otherwise match" (defence in depth:
   the codomain check runs first), and "a CC-mapped tool (bash) is still masked normally" (proving
   the fix is scoped, not a blanket bypass of the whole guard).

   **Re-run, same PONG overlay, confirmed no deny line for `send_message`:**

   ```
   $ DSH_HOME=$HOME/.dsh dsh --profile headless --patch /tmp/task-tool.overlay.yml \
       "Use the Task tool with subagent_type 'tester' and prompt 'reply with the single word PONG'. \
        Then reply with exactly what the subagent returned."
   ...
   PONG
   ```

   (Second-pass run 1 produced `PONG` plus a parenthetical note about the denied `send_message`
   call. This run — same overlay, same prompt, only the code changed — produced bare `PONG` with
   no such note.)

2. **Read-only exemption: `bash` must not disqualify it.** Confirmed the second pass's own caveat
   was right and fixed it: `WRITE_CAPABLE_DSH_TOOLS` in `lib/loop-guard.js` is now `{edit, write}`
   only, `bash` removed. Documented in both `lib/loop-guard.js` (the module header, the constant's
   own comment, and `isReadOnlyAgent`'s doc comment) and in this README (the "(c) Verification-loop
   guard" paragraph in "Behaviour" above, and finding 4 in "Second pass"). Tests:
   `test/loop-guard.test.js` — `isReadOnlyAgent` now asserts `bash`-present-without-`edit`/`write`
   IS exempt, and the integration test's `reviewer`-shaped fake descriptor now includes `bash` in
   `dshTools` (matching `reviewer.md`'s real frontmatter shape) to prove the exemption actually
   fires for it now, not despite it.

3. **`docs/DESIGN.md` Q3 (~line 424) rewritten.** Now states plainly that `compactNow` is
   idle-only — cites `dsh-compaction-basic/lib/index.js:985-1010`, quoting its own
   `ManualCompactionError("busy", "manual compaction requires an idle agent with no waking queued
   work", ...)` message verbatim from line 1009 — and that `compactIfNeeded(agent, trigger,
   signal)` (`dsh-compaction/lib/types/index.d.ts:116`, implemented at
   `dsh-compaction-basic/lib/index.js:914`) is the in-turn call this plugin actually uses, matching
   `lib/context-cap.js`'s real code (fixed in the second pass) rather than the first pass's
   `compactNow` description that `docs/DESIGN.md`'s Q3 had still been carrying.

### Test count after this pass

`node --test test/*.test.js` — **56/56 passing** (was 53; +3 for the mask-guard codomain
restriction).

## Fourth pass (third review round — eight findings)

New file: `lib/schema-sync.js` (extracted from `index.js` to stay under its line cap after this
pass's additions — the tool-registration/refresh/onChange-vs-interval scaffolding, unchanged in
behavior). `packages/dsh-agents-md/package.json`'s `exports` map also changed (authorized — see
finding 4).

1. **`lib/context-cap.js` (BLOCKING) — `stop` calls `interrupt()`, which throws `SubagentError`
   tagged `UNAUTHORIZED` in three real paths when `authority.kind === 'ancestor'`
   (`dsh-subagent/lib/types/manager.js:133-152`: the stored `parentAgent` is no longer the exact
   live agent, it IS the target itself, or the target isn't in its tracked ancestry). Unguarded,
   and with `acted.add()` running only after a successful action, this would rethrow on every
   single `agent/pre-step` for that child. Fixed: `applyCapAction`'s `stop` branch now wraps
   `interrupt()` in try/catch, falling back to `steerToWrapUp(agent)` on any failure — matching
   the `compact` branch's existing shape. Tests: `test/context-cap.test.js` — "stop falls back to
   steer when interrupt() throws" and "a failed stop action still marks 'acted' via the handler
   (does not retry forever)".
2. **`lib/schema-sync.js` (`createSchemaSync`'s `doRefresh`, formerly `index.js`) — a throwing
   `ctx.tools.register()` left a stale disposer.** If `ctx.tools.register(...)` throws, the
   assignment `unregisterTool = ctx.tools.register(...)` never completes, so `unregisterTool`
   silently RETAINS its previous value — the already-disposed disposer from the prior successful
   registration — rather than becoming `undefined`. Fixed: `unregisterTool?.(); unregisterTool =
   undefined;` now runs, as two separate statements, immediately before the registration attempt,
   so a throw there leaves the truthful state ("nothing registered") instead of a stale reference.
   Test: `test/schema-sync.test.js` — "a registration failure does not leave a stale disposer that
   blocks the next retry (item 2)" (triggers a failing `register()`, then a second successful one,
   and asserts the tool count recovers to 1).
3. **Spec deviation (`DESIGN.md` §4.2) — an untracked window between `startActivation` resolving
   and `tracked.set()`.** Fixed in `lib/dispatch.js`: generates its own child identity up front
   (`SessionId(randomUUID())`, matching exactly what `dsh-subagent`'s own manager does internally
   when a caller omits `childId` — `dsh-subagent/lib/types/manager.js:322`:
   `spec.childId ?? brandString(randomUUID())`), calls `tracked.set(childId, ...)` **before**
   `startActivation`, and passes that `childId` on the spec using the reserved-id overload
   (`dsh-subagent/lib/types/index.d.ts:135-139`). On a rejecting `startActivation`, the
   pre-reservation is undone (`untrackChild` then rethrow) rather than left dangling. Every guard
   and the context cap can now see the child from the moment it is *asked* to start, not from the
   moment that call happens to resolve. New peer dependency: `@deepseek-ai/dsh-session` (for the
   `SessionId` brand function — `node:crypto`'s `randomUUID` supplies the raw id). Tests:
   `test/dispatch.test.js` — "the reserved childId is tracked BEFORE startActivation resolves — no
   untracked window" (the fake provider asserts `tracked.has(spec.childId)` from *inside* its own
   call, before returning) and "a rejecting startActivation untracks the reserved childId instead
   of leaking it".
4. **`lib/guards.js`'s `KNOWN_DSH_TOOL_NAMES` duplication — resolved via an authorized exports-map
   edit.** Added `"./lib/tool-names.js": "./lib/tool-names.js"` to
   `packages/dsh-agents-md/package.json`'s `exports` map (verified: `import('@mdcode-cc/dsh-agents-md/lib/tool-names.js')`
   now resolves, where it previously threw `ERR_PACKAGE_PATH_NOT_EXPORTED`). `lib/guards.js` now
   imports the real `CC_TO_DSH_TOOL_NAMES` and derives `KNOWN_DSH_TOOL_NAMES =
   new Set(Object.values(CC_TO_DSH_TOOL_NAMES).flat())` — no more hand-kept duplicate, and the set
   grows automatically as that table does (confirmed: between the second pass and this one, the
   table itself grew — `job_output`/`job_list`/`job_kill`/`exit_plan_mode`/`ask_user_question` rows
   were added by a concurrent session — and the derived set picked them up with zero changes
   here). Test: `test/guards.test.js` — "KNOWN_DSH_TOOL_NAMES equals the live
   CC_TO_DSH_TOOL_NAMES codomain from dsh-agents-md", importing both modules directly and
   asserting the flattened codomains are set-equal.
5. **`lib/loop-guard.js`'s `WRITE_CAPABLE_DSH_TOOLS` — added `str_replace_editor`.** It is a real
   registered tool name on this host (`dsh-tool-str-replace-editor/lib/index.js:267`,
   `defineTool({ name: "str_replace_editor", ... })`), so a future preset row mounting it would
   otherwise silently bypass the read-only exemption. The constant's own comment, and the
   `isReadOnlyAgent` doc comment, now say explicitly that this set is **hand-kept and NOT
   exhaustive** — it is not derived live the way the mask guard's `KNOWN_DSH_TOOL_NAMES` is (that
   derivation is sound because the mapping table itself states "no CC concept names this tool";
   this set instead has to know which *mapped* dsh tools actually mutate a file, which the mapping
   table does not record).
6. **`index.js` — `ctx.effect` disposer registered too late.** Moved to the first statement in
   `apply()` after the per-plugin state (`tracked`, `loopGuardState`, `schemaSync` placeholder) is
   declared — before the provider-capability check that can throw, matching `dsh-agents-md`'s own
   `apply()` ("Registered before any await, so a later throw ... still disposes whatever got
   mounted up to that point instead of leaking"). The cleanup closure reads `schemaSync` by
   reference, so registering it before that variable is assigned is safe. Test:
   `test/smoke.test.js` — "the ctx.effect cleanup is registered before the provider check can
   throw" (the provider check rejects `apply()`, then `runTeardown()` is asserted not to throw).
7. **Known limitation, now narrowed rather than fully fixed: `compactIfNeeded` may run the host's
   thresholds, not the child's.** `lib/context-cap.js` now has `resolveCompaction(agent,
   getCompaction)`, which tries `agent.ctx.get('compaction')` — the child's OWN scoped service,
   when its preset mounts one in an isolate (the `cc-agents-md` `inheritPlugins` shape does
   exactly that) — **before** falling back to `getCompaction()` (this plugin's own host-level
   `ctx`). So when the child's preset carries its own `compaction` isolate group, the cap now acts
   on the child's own engine and thresholds. The limitation is narrower, not gone: a preset
   without that isolate group (or a provider whose child exposes no `.ctx` at all) still falls
   back to the host-level instance, which runs the HOST's own configured thresholds against the
   CHILD's session — correct mechanically (compaction still targets `agent.session`), but the
   *policy* (retention tokens, compaction-trigger specifics) is the host's, not necessarily what
   that child's own composition would have chosen for itself. Tests: `test/context-cap.test.js` —
   "compact prefers the child's own agent.ctx compaction service over the host-level one" and two
   fallback-path tests (no child service; no `.ctx` at all).
8. **One-time runtime identity assertion, logged at `info` (mirrored to console when
   `mirrorLogsToConsole` is set — `ctx.logger.info` has the same no-console-exporter host fact as
   `ctx.logger.warn`, so a new `info()` helper parallels `warn()`'s existing mirror).**
   `index.js`'s `verifyGuardIdentity(childId)`, called once from `dispatchTask` right after a
   successful `startActivation`, resolves the live child Agent via `ctx.get('agents').get(childId)`
   (`AgentRegistry.get(id: SessionId): Agent | undefined`, `dsh-agent/lib/types/index.d.ts:343` —
   the exact service `dsh-subagent`'s own manager uses internally, e.g.
   `this.ctx.agents.get(caller.id)` in the very `interrupt()` code finding 1 cites) and compares
   `liveChild.session.id` to the `childId` this plugin tracked it under. Logs **"guard identity
   verified"** on a match or **warns "guard identity MISMATCH"** otherwise — this is the ground
   truth static review could not confirm: it is independent of any guard's own `tracked`
   lookup (a Map miss there cannot by itself distinguish "untracked caller" from "key-space
   mismatch"), because it reads the live Agent object directly rather than going through any
   guard's own code path. If the live agent is not yet resolvable (an external/non-resident
   provider), the check is skipped and retried on the next dispatch rather than logging a false
   mismatch. Test: `test/dispatch.test.js` — "verifyIdentity is called once with the reserved
   childId after a successful start".

### Test count after this pass

`node --test test/*.test.js` — **71/71 passing** (was 56; +15 across the eight findings above).
Also re-ran `packages/dsh-agents-md/test/*.test.js` after its `exports` map edit — **66/66 still
passing**, confirming that change broke nothing there.

### Real integration run, fourth pass

One run, as budgeted:

```
$ DSH_HOME=$HOME/.dsh dsh --profile headless --patch /tmp/task-tool.overlay.yml \
    "Use the Task tool with subagent_type 'tester' and prompt 'reply with the single word PONG'. \
     Then reply with exactly what the subagent returned."
DIAGNOSE: 17 ok, 0 broken, 17 total
DIAGNOSE ok: cc-data-engineer
...
DIAGNOSE ok: standard
[11/02/26 02:58:28] INFO     Processing request of type            server.py:733
                             ListToolsRequest
[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)
dsh: reasoning:
The user wants me to use the Task tool with subagent_type 'tester' and prompt 'reply with the single word PONG'.
...
Let me call it.
dsh-task-tool: guard identity verified — tracked childId matches exec.agent.session.id
PONG
```

The identity line fired exactly once, logging **verified** (not a mismatch) — direct, live confirmation that the `childId` this plugin tracked really is the same value every guard (mask/loop-guard/context-cap) later looks the child up by. `DIAGNOSE: 17 ok, 0 broken, 17 total` (a third-party diagnostic row left in the shared `/tmp/task-tool.overlay.yml` by a concurrent session) also confirms the `dsh-agents-md` `package.json` `exports` edit (finding 4) did not disturb preset activation for any of the 17 real presets now in the roster.

**One retry was needed to get this output.** The first attempt at this run produced only the overlay dump plus a bare `ListToolsRequest` line before exiting 0 with no model output, no `DIAGNOSE` lines, and no identity line — truncated, not informative either way (not a crash signature, not a success signature). A quick `dsh --version` sanity check came back normal immediately, so this was treated as a transient loss (most likely output lost across a background pipe boundary, not a real failure) rather than evidence of a regression, and the run was repeated writing directly to a file instead of through a `tail` pipe. The second attempt produced the complete, decisive output above. Reported both attempts rather than only the one that happened to work.
