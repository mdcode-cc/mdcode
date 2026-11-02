# mdcode — design spec

Six cordis plugins that port a Claude Code workflow onto the DeepSeek Harness with DeepSeek
models only.

**Host read:** `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`.
The install moved from `0.2.0-rc.2` to **`0.2.1-rc.5` while this was being written** (a
concurrent upgrade). Every seam cited below was re-read on rc.5; where rc.2 and rc.5 disagree the
difference is called out, because two of them are material. Package paths in citations are
relative to that directory. `dsh --version` → `0.2.1-rc.5`.

**Status: implemented.** All six plugins are built and unit-tested (292 tests across the
workspace), and each has been activated on a real `dsh --profile headless` run (`dsh-commands-md`
by unit tests plus a read-only parse of the real command/skill files, not a live boot; see its
README — and `dsh-hooks-approval`'s `PermissionRequest` relay is verified with deny/allow fixture
hooks, with a live round-trip through an external approval daemon still pending, see its README).
Per-package test counts and real-run evidence: `README.md`.

---

## 1. What the host already gives us

Reading the install first, so we build only what is missing:

| need | first-party answer | enough? |
|---|---|---|
| global + project rules file | `dsh-agent-instructions` — `$DSH_HOME/AGENTS.md` then the project chain of `AGENTS.md`/`CLAUDE.md`/`*.local.md`, byte-budgeted | **yes**, with a path caveat (§5) |
| skills | `dsh-skill` + `dsh-skill-filesystem` — `SKILL.md` roots incl. `customSkillDirs` | **yes** for model-loaded skills; **no** for argument-taking commands (§4.4) |
| delegation | `dsh-subagent` + `dsh-subagent-spawn-in-process` + `dsh-tool-subagent` | **nearly** — see §4.2 |
| named agent compositions | `dsh-agent-preset` + `dsh-agent-preset-registry` + `dsh-persona` | **yes**, and `register()` is a public API (§4.1) |
| plan mode, compaction, tool-result pruning | `dsh-plan-mode`, `dsh-compaction-basic`, `dsh-compaction-tool-result-pruner` | yes |
| permissions / approval | `dsh-permission-presets` + `dsh-user-approval` | yes at session level; not per-agent (§6) |
| slash commands | `dsh-commands` — `ctx.commands.register()` | the registry, yes; the markdown loader, no (§4.4) |
| Claude Code hooks | `dsh-hooks-claude-code` | **yes, published at rc.5** — a host devDependency, not vendored, so it needs one explicit `dsh plugin --profile cc add` step (§6, Q4) |
| MCP servers | `dsh-mcp-client`, one row per server | yes |
| model retry | `dsh-llm-retry` + adapter `retryPolicy` | yes for 5 codes; not for 2 (§3a) |
| repeated-tool guard | `dsh-repeat-tool-reminder` | exact repeats only (§3c) |
| token measurement | `dsh-token-meter` — `ctx.tokenMeter.measure(session)` | yes |
| DeepSeek route | `dsh-llm-deepseek` + `-api-key`, Anthropic dialect at `https://api.deepseek.com/anthropic` | yes |
| plugin logs → a file sink | no shipped profile mounts a logger exporter | **no** — needed (§4.5) |

So: six plugins, not forty.

### Profile rules

Never declare a package the `dsh` install already ships (anything under
`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`, e.g.
`@deepseek-ai/dsh-base`, `dsh-mcp-client`, `@deepseek-ai/dsh-agent-preset-registry`,
`@deepseek-ai/dsh-agent-preset`) as a profile's own `package.json` direct dependency.
`dsh-app-boot`'s `routeLocalPackage` treats an installed direct dependency as a deliberate local
override and routes it to plain Node resolution, which can load a second copy of a module the
host keys state on by module-level identity (`@deepseek-ai/dsh-scope`'s `Symbol`) — see §7 Q7.
A `scripts/doctor.sh` check for this is planned, not yet written.

---

## 2. Asset mapping

| Claude Code asset | dsh mechanism | plugin |
|---|---|---|
| `~/.claude/CLAUDE.md` (global rules) | `dsh-agent-instructions` reads `$DSH_HOME/AGENTS.md`, then `<agentsHome>/AGENTS.md` (default `~/.agents/AGENTS.md`, `dsh-agent-instructions/README.md:34,40`) — the file must be **placed or symlinked at one of those two paths**; it does not read `~/.claude` | *none* (first-party + one setup step) |
| `<repo>/CLAUDE.md` | `dsh-agent-instructions` project chain (`instructionFileCandidates` already includes `CLAUDE.md`) | *none* (first-party) |
| `<repo>/.claude/PROJECT.md` | plain file read directly by the agent prompts; no host mechanism needed | *none* |
| `~/.claude/TEAM_WORKFLOW.md` | referenced from the global rules file; it is prose, not config | *none* |
| `~/.claude/agents/*.md` → an agent **identity + prompt** | one `dsh-agent-preset` per file via `ctx.agentPresets.register()`, each with a `dsh-persona` row carrying the body | **dsh-agents-md** |
| agent frontmatter `model: haiku\|sonnet\|opus` | `AgentOptions {provider, model, reasoningEffort}` on the child start request | **dsh-model-tiers** (table) + **dsh-task-tool** (applies it) |
| agent frontmatter `effort` | `reasoningEffort` (`off\|low\|high\|max`) | **dsh-model-tiers** |
| agent frontmatter `tools` / `disallowedTools` | `tools/pre-execute` deny guard keyed by child session (not a catalog mask — Q2) | **dsh-task-tool** |
| agent frontmatter `skills` | one appended line in the generated persona, naming the skills to load | **dsh-agents-md** |
| agent frontmatter `permissionMode` | **no equivalent** — a delegated child's approval policy is pinned to `never` at the boundary | recorded only; gap list |
| agent frontmatter `maxTurns` | **no equivalent** — no turn budget on `SubagentStartRequest` | advisory in prompt; gap list |
| the `Task` tool (`subagent_type`) | `ctx.subagents.startActivation({request: {agentPreset, agentOptions, prompt}})` | **dsh-task-tool** |
| `~/.claude/skills/*/SKILL.md` loaded by the model | `dsh-skill-filesystem` with `customSkillDirs: ['~/.claude/skills']` | *none* (first-party) |
| `~/.claude/skills/*` invoked as `/intake`, `/build`, `/ship` with arguments | `ctx.commands.register()` + `$ARGUMENTS` expansion + `agent.followup()` | **dsh-commands-md** |
| `~/.claude/commands/*.md` | same | **dsh-commands-md** |
| skill/command `allowed-tools` | **no per-command mask exists** | recorded only; gap list |
| `~/.claude/settings.json` `hooks` | `dsh-hooks-claude-code` `configPath` — published at `0.2.1-rc.5` on npm, but it is a **devDependency of the host `dsh` package**, so it is not vendored into `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`. Install it into the profile explicitly: `dsh plugin --profile cc add @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.5` | *none* (first-party, one `dsh plugin add` step) |
| `~/.claude/settings.json` `hooks` → `PermissionRequest` | answerer on `@deepseek-ai/dsh-user-approval`'s `approval/request` waterfall; `tool_input` recovered from a `tools/pre-execute` cache keyed by `callId` since `approval/request` carries no tool arguments of its own | **dsh-hooks-approval** |
| `~/.claude/settings.json` `hooks` → `SessionEnd` | runs its configured command hook, detached, on `@deepseek-ai/dsh-session`'s `session/disposed` (reason `other`) | **dsh-hooks-approval** |
| `~/.claude.json` `mcpServers` | one `dsh-mcp-client` row per server; tools surface as `mcp__<serverName>__<tool>`, the same naming shape | *none* (first-party; configured in the home-level patch) |
| `~/.claude/settings.json` `permissions` | `dsh-permission-presets` preset table + `/permission` | *none* (first-party, coarser) |
| `~/.claude/statusline-command.sh` | TUI `StatusBarConfig` field set is fixed; only a keyed `ctx.tuiStatus` line is addable | gap list |
| plugin logs (no CC equivalent — operational need) | `ctx.logger.exporter()` appends every `ctx.logger` message to a file; no shipped profile mounts one | **dsh-plugin-log** |

---

## 3. Hardening requirements

Evidence-driven, assigned to one owner each.

### (a) Retry on malformed tool-call JSON / `MALFORMED_RESPONSE` / `STREAM_CLOSED`

Three different failures wearing one name. Separating them:

1. **`MALFORMED_RESPONSE` / `STREAM_CLOSED`** — the DeepSeek adapter raises these for protocol
   violations (`dsh-llm-deepseek/README.md`, "Failures and recovery"). `dsh-llm-retry` in normal
   mode retries "`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`" and
   nothing else (`dsh-llm-retry/README.md`). **Primary fix is config, not code:**
   `retryPolicy.retryableCodes` is a real adapter field
   (`dsh-llm/lib/types/retry-policy.d.ts:26`), so adding the two codes to the `llm-deepseek` row
   buys durable, backoff-aware retries with `llm/retry` + `llm/retry-started` events. **Stated
   constraint: the home-level `~/.dsh/cordis.patch.yml` applies after every profile's own patch
   and replaces the row by id — it does not deep-merge.** A `retryPolicy` written only in
   `profiles/cc/cordis.patch.yml`'s `llm-deepseek` row is therefore silently dropped once the
   home-level `llm-deepseek` row applies on top of it in the real mount. Fix: the block lives in
   the home-level row instead (`~/.dsh/cordis.patch.yml`, where every profile — `web`, `dsh-tui`,
   `headless` — benefits from it, not just `cc`), and the profile's own row carries a comment
   pointing there instead of a competing `retryPolicy`.
2. **Fallback for a non-DeepSeek route** (a gateway `baseURL`, a future provider, or a deployment
   that cannot edit the adapter row) → **dsh-model-tiers**, via the `agent/request-error`
   waterfall returning `{kind: 'retry'}`. Strictly worse observability (no backoff, no durable
   retry event), so it logs every attempt and defaults to 2.
3. **Malformed tool-call JSON is neither.** "Model arguments are validated before execution;
   invalid input becomes a normal error result" (`dsh-tools/README.md`), with `ToolArgsError`
   exported at `dsh-tools/lib/types/index.d.ts:24`. It never reaches `agent/request-error` — the
   model sees the error and can fix it. The risk is looping on it, which is (c). The *rate* is a
   pilot metric, counted from the session log.

### (b) Per-subagent context cap ≈150k tokens → **dsh-task-tool**

`ctx.tokenMeter.measure(session).totalTokens` on each tracked child's `agent/pre-step`
(`dsh-token-meter/lib/types/index.d.ts:46`).

Honest framing: `deepseek-flash` carries a **1,048,576-token** window
(`dsh-llm-deepseek/README.md`, "each with the 1,048,576-token context window the official model
listing declares" — `1,000,000` is `defaultContextWindow`, the fallback for models *without* an
exact value, which does not apply here), and `dsh-compaction-basic`'s own trigger is
`floor(min(W × 0.8, W − O − 65536))` ≈ 800k. A 150k cap is therefore **cost and adherence policy,
not overflow protection** — a child that has read 800k of tokens has stopped following its spec
long before it runs out of room. Saying otherwise would be dressing a budget decision as a
technical constraint.

Action at the cap: `steer` (**default** — tell the child to write its findings and finish),
`compact` (opt-in — `ctx.compaction.compactIfNeeded(agent, 'pressure', signal)`, the per-step
pressure API `dsh-compaction-basic` itself calls from the same position, NOT `compactNow`, which
requires an idle agent and would throw `ManualCompactionError('busy', ...)` every time from inside
`agent/pre-step`; falls back to `steer` on any failure), or `stop` (interrupt and return a
truncation notice so the parent *knows*).

Implemented as specified and unit-tested in `dsh-task-tool/lib/context-cap.js` (see Q3): `compact`
calls `compactIfNeeded`, never `compactNow`, and falls back to `steer` both when `ctx.compaction`
is unavailable and when `compactIfNeeded` itself throws.

### (c) Loop guard on repeated verification-only tool calls → **dsh-task-tool**

`tools/post-execute`, counting consecutive calls per child whose tool name (or, for `bash`, whose
command string) matches a `verificationTools` pattern. Fires once at `maxConsecutive`.

Not covered by `dsh-repeat-tool-reminder`, which detects "only exact repeats (same tool, same
arguments regardless of property order)" and says so (`dsh-repeat-tool-reminder/README.md`). The
observed failure is a child re-reading and re-grepping with *varying* arguments and never writing.
Both are mounted; they catch different shapes.

Implemented with a read-only exemption, found necessary during build: an agent whose tool mask
has no `edit`/`write` tool is exempt from the guard entirely — `post-execute` never counts its
calls and `pre-execute` never denies one — because a read-only agent (reviewer, tester) is
*supposed* to call verification tools repeatedly; the loop risk only exists for an agent that
could instead be writing. Having `bash` in the mask does not by itself count as "not read-only" —
only `edit`/`write` do, since `bash` is used for running gates, not for a loop-risk pattern of its
own (`dsh-task-tool/lib/guards.js`, `isReadOnlyAgent`).

### (d) Log the resolved model id per request → **dsh-model-tiers**

`agent/request` waterfall: `await next()`, log `provider`/`model`/`reasoningEffort`, return
unchanged.

Why the session log is not enough: the loop writes `request/header` only "for the first request, a
changed envelope … and resume; **unchanged steps, retries, and ordinary later turns in the same
series inherit the latest header**", and `request/context` "only when one of those differs from the
latest snapshot" (`dsh-agent-loop/README.md`). So the durable log genuinely does not state the
route for every request, and an alias resolving differently than expected is invisible.

---

## 4. The six plugins

Full spec per plugin — every config key, every failure mode, the full test plan — is in its own
`packages/*/README.md`. Condensed here to purpose, seams and size.

### 4.1 `@markishh/dsh-agents-md` — 607 lines (`index.js` 120 + `lib/*.js` 487)

Parses `.claude/agents/*.md` and registers one dsh agent preset per agent; publishes the roster as
`ctx.agentsMd`. Seams: `ctx.agentPresets.register()` (`dsh-agent-preset-registry`), a
`@deepseek-ai/dsh-persona` row per preset, `ctx.provide('agentsMd', …)`. Passive after mount — no
agent-loop event. See `packages/dsh-agents-md/README.md`.

### 4.2 `@markishh/dsh-task-tool` — 613 lines (`index.js` 147 + `lib/*.js` 466)

One `Task(description, prompt, subagent_type, run_in_background?)` tool dispatching to the
registered presets. Owns hardening (b) and (c). `dsh-tool-subagent`'s `allowedAgentPresets` gets
most of the way for free but can't give per-agent model tier, Claude Code's parameter names, or a
per-agent tool mask — see the README for the full comparison and the rc.2→rc.5 removal of
`persona`/`toolFilter` from that row that forced this design. Seams: `ctx.tools.register()`,
`ctx.subagents.startActivation()`, `subagent/start`/`subagent/end`,
`tools/pre-execute`/`tools/post-execute`, `ctx.tokenMeter.measure()`. See
`packages/dsh-task-tool/README.md`.

### 4.3 `@markishh/dsh-model-tiers` — 296 lines (`index.js` 117 + `lib/*.js` 179)

The single place the model policy lives. Owns hardening (a)-fallback and (d). Config-only by
design, so the policy shows up in a `cordis.patch.yml` diff. Seams: `ctx.provide('modelTiers', …)`,
the `agent/request` and `agent/request-error` waterfalls. See `packages/dsh-model-tiers/README.md`.

### 4.4 `@markishh/dsh-commands-md` — 590 lines (`index.js` 114 + `lib/*.js` 476)

`/intake`, `/build`, `/ship`, `/trace`, `/daily-review` as real slash commands. A skill is *loaded
as instructions*; a command is *submitted as a turn with arguments* and lands in a different
position in history — see the README for why the first-party skill loader can't substitute.
Seams: `ctx.commands.register()`, `agent.followup()` with `recordInput: false`. See
`packages/dsh-commands-md/README.md`.

### 4.5 `@markishh/dsh-plugin-log` — 57 lines (`index.js` only, no `lib/`)

Plugin logs → a file sink, needed because no shipped profile mounts a logger exporter. Seam:
`ctx.logger.exporter()` — the same API `dsh-app-boot` itself uses internally. See
`packages/dsh-plugin-log/README.md`.

### 4.6 `@markishh/dsh-hooks-approval` — 392 lines (`index.js` 125 + `lib/*.js` 267)

Runs the two hooks `dsh-hooks-claude-code` does not bridge — `PermissionRequest` (an
approval-relay hook that blocks on an external allow/deny decision) and `SessionEnd` — straight
from `~/.claude/settings.json`. Seams:
`@deepseek-ai/dsh-user-approval`'s `approval/request` waterfall, `@deepseek-ai/dsh-session`'s
`session/disposed`, a `tools/pre-execute`/`tools/post-execute` tool-input cache,
`dsh-hook-protocol`'s `runHook`. See `packages/dsh-hooks-approval/README.md`.

---

## 5. Model alias table

| alias | provider | model | reasoningEffort | reachable from |
|---|---|---|---|---|
| `haiku` | `deepseek-official` | `deepseek-flash` | `low` | agent `model:` |
| `sonnet` | `deepseek-official` | `deepseek-flash` | `high` | agent `model:`, default |
| `opus` | `deepseek-official` | `deepseek-flash` | `max` | agent `model:` |
| `medium` | `deepseek-official` | `deepseek-flash` | `high` | agent `effort:` only |
| `review` | `deepseek-official` | `deepseek-v4-pro` | `max` | **explicit name only** |

Effort is the tier knob, not the model. Both DeepSeek defaults carry a 1,048,576-token window
(`dsh-llm-deepseek/README.md`; `1,000,000` is `defaultContextWindow`, the fallback for models
without an exact value, not the figure for these two), so the tier buys reasoning depth, not
capacity. DeepSeek's effort
ladder is `off | low | high | max` — there is **no `medium`**, which is why an
`effort: medium` agent folds into `high`.

`deepseek-flash` is the only default catalog entry declaring `systemPromptUpdate: in-history` and
`toolUpdate: addition-only`, which is what lets the loop append a changed prompt after cached
history instead of rewriting the leading system message (same README). Moving a lane to
`deepseek-v4-pro` therefore costs prefix-cache reuse on top of the ~4.5× input price. That is the
reason `review` is opt-in and not wired to any frontmatter key.

`provider: deepseek-official` is the API-key route; `deepseek-account` resolves only a stored
account grant and "neither route falls back to the other".

---

## 6. Gap list — Claude Code features consciously not ported in v1

| feature | why not |
|---|---|
| `settings.json` `hooks` | `dsh-hooks-claude-code` is published at `0.2.1-rc.5` but is a **devDependency of the host `dsh` package**, so it is not vendored into the install tree (a `find` for `*hooks*` under the host's own `node_modules/@deepseek-ai` returns only an unrelated `standardwebhooks`). Resolved (Q4): add it to the profile explicitly with `dsh plugin --profile cc add @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.5`. Once added, its supported-event set still leaves some hook types unreachable — see the next row. |
| Upstreaming `PermissionRequest`/tool-argument support into the first-party bridge | `docs/upstream/` holds a draft patch adding `PermissionRequest`/`SessionEnd` to `dsh-hooks-claude-code`'s bridged event set, plus tool arguments on approval requests — the two gaps `dsh-hooks-approval` (§4.6) works around from outside the bridge. It is a contribution candidate only: not applied to this repo and not submitted upstream. |
| `PreCompact` hook | Not in the rc.2 bridge's supported set either. `compaction/*` events exist on the host, so a native plugin could do it — out of scope for six packages. |
| `@path` imports inside `CLAUDE.md` | `dsh-agent-instructions` renders the file chain byte-for-byte with a byte budget; it has no import directive. A `@path` line would reach the model as literal text, which is worse than absent. |
| `/rewind` | Needs checkpoint + restore over the session log. `dsh-session-checkpoint-policy` exists; building a rewind UI is a project, not a plugin. |
| statusline | The TUI's `StatusBarConfig` field set is fixed and not extensible from a plugin; only a keyed `ctx.tuiStatus` line is addable (the mechanism a first-party balance-status plugin uses). A shell-command statusline has no seam. |
| per-command `allowed-tools` | No per-command or per-turn tool mask exists; `ctx.tools.restrict` is per-agent. Enforcing it would be a racy restrict/lift around a turn. Recorded and printed instead. |
| per-agent `permissionMode` | A delegated child's approval policy is pinned to `never` at the delegation boundary (`dsh-subagent/lib/types/child-agent.d.ts`, `DelegatedPolicyOverrides`: "a delegated child acts only within the sandbox scope fixed at delegation"). `acceptEdits` is already the effective behaviour; `plan` and `bypassPermissions` cannot be set per agent. |
| per-agent `maxTurns` as a hard cap | No turn budget on `SubagentStartRequest`. Rendered into the child's prompt as an advisory budget, and reported as advisory. |
| worktree isolation per lane | The reference implementation documents its own as partial (sandbox root and bash workdir stay the parent's). A multi-lane workflow already requires disjoint paths per lane, which is the honest version. |
| command attachments (screenshot `/intake`) | A command must declare `input.attachments`; v1 does not, so the executor rejects them before the handler runs. Path-as-text works today. |
| `~/.claude/settings.json` `permissions` allow/deny rules | `dsh-permission-presets` bundles a sandbox mode with an approval policy per preset — coarser than Claude Code's per-pattern rules, and the reserved names `custom`/`auto` constrain the table. First-party coverage accepted as-is. |
| MCP server rows generated from `~/.claude.json` | A home-level patch can already carry hand-written `dsh-mcp-client` rows for personal MCP servers; generating them from `~/.claude.json` would fight that file. |
| 15 agents × a fully independent tool surface | Every generated preset shares one `inheritPlugins` row set; the per-agent difference is the persona plus a deny guard. Truly per-agent compositions mean 15 preset definitions with 15 tool lists — defer until real usage shows the deny guard costs real steps. |

---

## 7. Open design questions

**Q1 — can a plugin register an agent preset programmatically? RESOLVED.**
Yes. `ctx.agentPresets.register(definition)` is public and returns a disposer; `plugins` is typed
as a cordis `EntryOptions[]`. This is why the design is "a real preset per agent" (§4.1), not a
prompt-prefix in the Task tool. (`dsh-agent-preset-registry/lib/types/index.d.ts:44`, `definition.d.ts`.)

**Q2 — can a per-call tool mask be a catalog mask instead of a deny guard? UNRESOLVED.**
`ctx.tools.restrict(filter)` exists but must be installed in the child's own registration scope,
and `startActivation` exposes no setup hook to reach it. Options on the table: accept the deny
guard (current choice, §4.2), move the mask into 15 per-agent presets (loses the single
`inheritPlugins`), or find whether `agent/created` can reach the child context in time — not
answerable from the `.d.ts` alone. (`dsh-tools/lib/types/index.d.ts:645`.)

**Q3 — is there a programmatic compaction trigger? RESOLVED — `compactNow` is the wrong one.**
Two exist. `compactNow` is idle-only — it calls `agent.runMaintenance` and throws
`ManualCompactionError('busy', …)` whenever the agent is mid-turn, so calling it from
`agent/pre-step` would throw on every single call. `compactIfNeeded(agent, trigger, signal)` is
the in-turn API `dsh-compaction-basic` uses on itself; `contextCapAction: 'compact'` calls that,
falling back to `steer` (the documented default) on any failure.
(`dsh-compaction/lib/types/index.d.ts:116,137`; `dsh-compaction-basic/lib/index.js:914,985`.)

**Q4 — where did `dsh-hooks-claude-code` go in rc.5? RESOLVED.**
Published at `0.2.1-rc.5` on npm, but listed as a **devDependency** of the host `dsh` package, so
it is never vendored into the install tree. Fix: install it into the profile explicitly —
`dsh plugin --profile cc add @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.5`. Whether its
`configPath` covers every hook type a project might configure is separately still unverified.
(`@deepseek-ai/dsh/package.json` `devDependencies`.)

**Q5 — `@deepseek-ai/dsh-agent-loop-testkit`. UNRESOLVED, not blocking.**
Exists at `0.2.1-rc.5` but is not vendored in the host install, so it could not be read. The test
plans above use `node:test` instead; it would be the right tool for an end-to-end
`agent/pre-step` → `tools/post-execute` test once it resolves from the registry.
(`dsh-compaction-basic/package.json` `devDependencies`.)

**Q6 — where do the global rules actually live? RESOLVED, one manual step required.**
`dsh-agent-instructions` never reads `~/.claude/CLAUDE.md` — the real chain is
`$DSH_HOME/AGENTS.md` **and** `~/.agents/AGENTS.md`. `$DSH_HOME` is `~/.dsh`, which this project
does not write to, so placing or symlinking the global rules file there is a manual setup step
outside this repo's scope — the one manual step the asset-mapping table marks.
(`dsh-agent-instructions/README.md:34,40`.)

**Q7 — does the `inheritPlugins` row set actually mount? RESOLVED.**
Yes — real-boot evidence in `profiles/cc/cordis.patch.yml:23-114`. Two findings on the way there:

1. Two first-party `.required()` config fields with no default (`dsh-tool-fs-search`'s
   `sampleOverCapGlobResults`, `dsh-tool-todo`'s `allowParallelInProgress`) threw `missing
   required value` on an empty `{}` row and took down all 15 presets at once. Fixed by copying
   known-good values from an existing local preset's own config.
   (`profiles/cc/cordis.patch.yml:239-263`.)
2. **Root cause of the TUI "prompt section ... is already registered" failure:**
   `profiles/cc/package.json` declared four packages the `dsh` install already ships
   (`dsh-base`, `dsh-mcp-client`, `dsh-agent-preset-registry`, `dsh-agent-preset`) as direct
   dependencies. `dsh-app-boot`'s `routeLocalPackage` treats an installed direct dependency as a
   deliberate override and routes it to plain Node resolution, loading a second copy of
   `@deepseek-ai/dsh-scope`; `dsh-scope` keys a preset's scope on a module-level `Symbol`, so read
   through the other copy `scopeOf()` returns `undefined` and every preset mounts as global
   instead of scoped — once per row. `headless` never hit this (no `node_modules` of its own to
   shadow with). **Fix: remove those four packages as direct dependencies** — now the standing
   rule, "Profile rules" (§1). After the fix, 16/16 presets mount and a live `Task` → `tester`
   returned `PONG` in the real TUI. Latent risk: `mdcode`'s own root `node_modules` still holds a
   *third* copy of `dsh-scope` — harmless until a `@markishh` plugin imports it directly. A `fork`
   provider was evaluated and rejected (`inheritsParentContext: true` loses per-agent tools,
   persona and context isolation at once). Separately, `dsh-tui`'s own bundled presets stay routed
   away regardless (`preset: cc-no-preset` is deliberate, `profiles/cc/cordis.patch.yml:136`);
   `DSH_TUI_PRESET=standard` did not reach the UI, why is unverified.

**Verified live in the real `cc` TUI:** boot; `/intake` in the command palette; model routing to
`deepseek-flash`; tools listed and a real `pwd` executed; `Task` → `tester` → `PONG`.
`subagent_type` takes the **un-prefixed** agent name (`tester`), not the preset id (`cc-tester`).
