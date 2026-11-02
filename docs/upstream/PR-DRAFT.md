# PR draft: PermissionRequest + SessionEnd in dsh-hooks-claude-code, approval requests carry tool arguments

**Status: draft only. Not applied anywhere live, not pushed, no fork/PR opened on GitHub.**

Applies to `github.com/deepseek-ai/deepseek-harness` at commit
`b830ec950faba0a46dda564be3e2d854afed94f1` (tag `dsh-v0.2.1-rc.5`, merge of
"release(dsh): 0.2.1-rc.5", 2026-10-29). Both patches were verified with
`git apply --check` against a pristine checkout of that exact commit and
applied cleanly in sequence.

Two patches, in order:

- `0001-approval-request-carries-tool-arguments.patch` — `dsh-user-approval`
  + `dsh-tools`. Independent of 0002; could land on its own.
- `0002-hooks-claude-code-permission-request-session-end.patch` —
  `dsh-hooks-claude-code` + `dsh-hook-protocol`. **Depends on 0001**: the new
  `PermissionRequest` payload builder reads `req.arguments`, a field 0001
  adds to `ApprovalRequestEvent`/`ApprovalRequest`. Apply 0001 first.

## Title

`feat(hooks-claude-code): support PermissionRequest and SessionEnd; carry tool arguments through approval requests`

## Motivation

`dsh-hooks-claude-code` bridges an existing Claude Code `hooks.json` onto the
harness's interception points, but its own README lists `PermissionRequest`
and `SessionEnd` among the 23 (now 21) unsupported events, and
`dsh-user-approval`'s README says the approval request "carries no tool
arguments."

Two concrete gaps that follow from that:

- **Users with an existing `PermissionRequest` hook** — most commonly an
  approval-relay script (forward the pending call to Slack/a ticket
  queue/a human, wait for allow/deny) — get silent config-drop today: the
  event is parsed-and-ignored before group registration, so the hook never
  runs and the bridge falls back to whatever `PreToolUse`/the approval seam's
  own fail-closed `unavailable` decides. There's no warning beyond the
  one-time "skipping unsupported hook" log.
- **SessionEnd for session trackers** — anything that logs "a session
  ended" (usage/billing counters, cleanup jobs, external session-state
  mirrors) has no hook to attach to; `SessionStart` has no paired teardown
  signal in this bridge.
- **Approval UIs/relays that want to show what they're approving** — today
  an answerer on `approval/request` sees `toolName`, `reason`, and an
  optional `callId`, but never the call's actual arguments. A human
  approving "run bash" with no visibility into *which command* is being
  asked about is the practical cost named in the package's own "Known
  Limitations" section.

## Behavior

### `dsh-user-approval` + `dsh-tools` (0001)

- `ApprovalRequestEvent` (and therefore the readonly `ApprovalRequest`
  passed to `ApprovalService.request()`) gains an optional
  `arguments?: unknown` field — the tool call's input, when the asker has
  it. `unknown` because the seam does not validate a tool's own argument
  shape (same posture as `ToolExecution.arguments` upstream).
- `dsh-tools`' `serviceAsk` (the `ask`-decision → approval-seam bridge) now
  passes `arguments: exec.arguments` — the call's already-validated, frozen,
  losslessly-JSON-serializable parsed arguments — through to
  `approval.request()`.
- The field is optional and never persisted to the `approval/asked` audit
  event (same posture as the existing `displayReason` field), so:
  - Existing answerers that destructure a fixed set of fields (the ACP
    bridge, the browser `ui-approval` client) are unaffected — they simply
    don't read the new field.
  - An asker written before this field existed (or one with no call to
    attach, e.g. a bare permission-policy check) still produces a valid
    request with `arguments: undefined`.

### `dsh-hooks-claude-code` + `dsh-hook-protocol` (0002)

- **`PermissionRequest`**: a new `ctx.on('approval/request', ...)` waterfall
  listener. On each ask, it builds the Claude Code payload
  `{session_id, transcript_path: '', hook_event_name: 'PermissionRequest',
  cwd, tool_name, tool_input, tool_use_id}` (`tool_input` from the
  request's new `arguments` field, `tool_use_id` from `callId`), runs the
  matching `PermissionRequest` hook groups (matcher subject = tool name,
  same as `PreToolUse`/`PostToolUse`), and maps the result:
  `hookSpecificOutput.decision.behavior: "allow"` → `'allowed-once'`,
  `"deny"` → `'rejected'`, anything else (no decision, a hook that only
  emits `additionalContext`, etc.) → delegates via `next()` so a later
  composed answerer (or the service's fail-closed `'unavailable'`) still
  gets to decide.
  - This decision shape is genuinely different from `PreToolUse`'s flat
    `hookSpecificOutput.permissionDecision` string, so `dsh-hook-protocol`'s
    shared codec (`parseHookOutput`/`applyStructured`) gained a small,
    additive parser for the nested `hookSpecificOutput.decision.behavior`
    object, folding into the same `HookOutput.decision` enum (`'allow'` /
    `'deny'` only — this shape has no `'ask'`). This is shared, dialect-
    neutral parsing, consistent with how `permissionDecision` is handled
    today; the Codex bridge is unaffected (it never emits this shape).
- **`SessionEnd`**: a new `ctx.on('session/disposed', ...)` detached emit
  listener (observe-only, like `SubagentStop`). Payload:
  `{session_id, transcript_path: '', hook_event_name: 'SessionEnd', reason:
  'other'}`. `reason` is hardcoded to `'other'` — documented as a known
  limitation, not a bug — because:
  - `session/disposed` fires with a `Session`, not an `Agent`, and by the
    time listeners run the session has already left the live registry
    (`SessionStore.dispose()` deletes it from the store *before* emitting
    `session/disposed`). There is no live Agent to ask "why did this end,"
    and the harness's disposal path does not record a reason taxonomy
    (`clear`/`logout`/`prompt_input_exit`/`other`) anywhere upstream of
    this event.
  - Same no-Agent consequence: the payload's `cwd` falls back to the
    process cwd (not the session's own directory — `runPoint()`'s existing
    "no agent ⇒ no workdir lookup" branch, unchanged), and the hook gets no
    `hook/invoked`/`hook/result` audit pair (that pairing requires an
    `Agent.session` to append to; appending to an already-disposed session
    would be the exact crash-tail-garbage failure mode the codebase's
    `ApprovalService.request()` precondition comment warns about for
    appends outside a session's live window).
- Both new events are added to the config parser's allowlist
  (`CLAUDE_EVENTS` in `config.ts`): `PermissionRequest` keeps its matcher
  subject (tool name, like `PreToolUse`); `SessionEnd` is added to the
  no-matcher-subject list alongside `UserPromptSubmit`/`Stop` (a stray
  `matcher` field in a `SessionEnd` hooks.json entry is now silently
  discarded rather than the event staying unsupported).
- README (`README.md` + `README.zh.md`, kept in lockstep per this package's
  translation-pairing convention) updated: the "what your hooks can do"
  table, the hook-point-mapping / matcher-subjects / detached-runs /
  payloads-and-environment prose in "Understand the implementation", and
  the "Known Limitations" list (unsupported-event count 23 → 21, two new
  partial-support bullets for `PermissionRequest` and `SessionEnd`).
  `dsh-user-approval`'s README "no tool arguments" limitation line is
  reworded to describe the new optional, asker-supplied field instead.

## Limitations (explicitly not attempted)

- **No `reason` taxonomy for `SessionEnd`** — always `'other'`. Giving this
  real values needs the harness's session-disposal path to carry *why* a
  session ended, which is out of scope for a hooks-bridge patch.
- **No `permission_mode` / `updatedInput` for `PermissionRequest`** — the
  payload omits `permission_mode` (not tracked anywhere the bridge can read
  it, same gap as `PreToolUse`/`PostToolUse` already have per the README's
  "Common payload and output fields are partial" bullet), and a hook's
  `decision.updatedInput` / `decision.message` are not honored or surfaced —
  same posture as the existing, already-shipped `PreToolUse.updatedInput`
  (logged+warned, not applied). Not attempted here; would need the same
  input-rewrite design work the existing Agent Note defers.
- **`PermissionRequest` only fires when something else already asked** —
  it answers the `approval/request` seam, which only exists once a `PreToolUse`
  hook (or another seam) already returned `ask`. It does not make the bridge
  raise approval requests at points Claude Code would that this harness
  doesn't already gate through that seam.
- **Generated docs/catalogs not regenerated** — `packages/extensions/tool-cordis/src/api-catalog.ts`
  (the `ApprovalRequestEvent`/`ApprovalRequest` declaration strings baked in
  by `scripts/gen-cordis-catalog.ts`), `docs/config-catalog.md`, and the
  `.i18n.yaml` translation-pairing hashes for both touched READMEs are
  regenerated by repo tooling (`pnpm run gen-cordis-catalog`, `gen-config-catalog`,
  `verify-translation-pairing --write`) that this patch does not run — it's
  monorepo-wide generator infrastructure, out of scope for a scoped feature
  patch, and normally a maintainer/CI step before merge. Flagging so it
  isn't mistaken for "forgotten": the source-of-truth TS/README changes are
  complete and tested; only the generated-artifact regeneration step is
  left to the maintainers' usual process.
- **`pnpm-lock.yaml`** — updated via `pnpm install --no-frozen-lockfile` for
  the one new workspace edge (`dsh-hooks-claude-code` → `dsh-user-approval`
  devDependency/peerDependency). Minimal diff (5 lines), included in patch
  0002.

## Test evidence

Toolchain worked end-to-end: `pnpm install` (full monorepo, ~1402 packages,
~91s) succeeded after regenerating the lockfile for the new workspace edge.

Ran with `npx vitest run <paths>` (vitest 4.1.11) from the repo root:

```
packages/experimental/hooks-claude-code   Test Files  6 passed (6)    Tests  74 passed (74)
packages/experimental/hook-protocol       Test Files included below
packages/interaction/user-approval        Test Files included below
packages/core/tools                       Test Files included below

Combined (hook-protocol + user-approval + core/tools):
 Test Files  19 passed (19)
      Tests  542 passed (542)
```

Re-ran the `hooks-claude-code` suite 3x in a row after fixing an initial
test-only race (a `cat > file` capture script could be observed by
`existsSync` before its write flushed; fixed with the same
write-to-`.tmp`-then-`mv` pattern the package's own `coverage-cases.ts`
already uses) — stable at 74/74 each time.

Also ran, outside the normal test script: `npx tsc -b` (project-references
build mode) across `hooks-claude-code` + `user-approval` + `core/tools`
tsconfigs — zero errors after fixing one real issue the vitest run didn't
catch (vitest's esbuild transform doesn't type-check): the bridge imported
`ApprovalRequestEvent`, which `dsh-user-approval`'s main entry point does
not re-export (only `ApprovalRequest`, structurally identical for this
purpose, is) — fixed by importing `ApprovalRequest` instead. And
`npx oxlint <touched files>` — exit 0, no findings, across all touched
source and test files in both patches.

New/changed tests, by file:

- `packages/experimental/hooks-claude-code/tests/bridge.spec.ts` — 7 new
  end-to-end tests (real agent loop, real bash executor, real shell hook
  scripts): `PermissionRequest` allow/deny/delegate-to-next-answerer/payload-
  shape (4 tests, new `describe` block, using a new `harnessWithApproval`
  helper that additionally mounts `ApprovalService`), and `SessionEnd`
  fires-on-disposal-with-correct-payload / matcher-is-ignored-and-still-runs
  (2 tests, new `describe` block, driving `session/disposed` directly the
  same way the existing `SubagentStart`/`SubagentStop` tests drive their
  lifecycle events).
- `packages/experimental/hooks-claude-code/tests/config.spec.ts` — 3 new/
  extended unit tests: `SessionEnd` added to the existing "discards matcher
  fields on events without matcher subjects" case, plus two new standalone
  tests (`PermissionRequest` keeps its matcher, `SessionEnd` has none).
- `packages/experimental/hook-protocol/tests/codec.spec.ts` — 2 new unit
  tests for the nested `hookSpecificOutput.decision.behavior` parser
  (allow/deny/ask-is-ignored/non-object-is-ignored, and that it overrides
  `permissionDecision` when both are present on the same block — mirrors
  the existing "permissionDecision OVERRIDES the legacy top-level decision"
  test one level up).
- `packages/interaction/user-approval/tests/approval.spec.ts` — 2 new unit
  tests: `arguments` passed through to the answerer untouched and never
  audited; `arguments` absent (undefined, key not present) when the asker
  never set it.
- `packages/core/tools/tests/tools.spec.ts` — 1 new assertion added to the
  existing "dispatches the tool when the answerer grants allowed-once,
  forwarding the ask fields" test: `seen[0]?.arguments` equals the call's
  parsed arguments.

## Files changed

### 0001-approval-request-carries-tool-arguments.patch (7 files, +49/-3)

| File | +/- |
|---|---|
| `packages/interaction/user-approval/src/types.ts` | +9 |
| `packages/interaction/user-approval/src/index.ts` | +2/-1 |
| `packages/interaction/user-approval/README.md` | +1/-1 |
| `packages/interaction/user-approval/README.zh.md` | +1/-1 |
| `packages/interaction/user-approval/tests/approval.spec.ts` | +31 |
| `packages/core/tools/src/index.ts` | +1 |
| `packages/core/tools/tests/tools.spec.ts` | +4 |

### 0002-hooks-claude-code-permission-request-session-end.patch (11 files, +319/-25)

| File | +/- |
|---|---|
| `packages/experimental/hooks-claude-code/src/index.ts` | +50/-2 |
| `packages/experimental/hooks-claude-code/src/config.ts` | +6/-2 |
| `packages/experimental/hooks-claude-code/package.json` | +3/-1 |
| `packages/experimental/hooks-claude-code/README.md` | +9/-5 |
| `packages/experimental/hooks-claude-code/README.zh.md` | +9/-5 |
| `packages/experimental/hooks-claude-code/tests/bridge.spec.ts` | +178 |
| `packages/experimental/hooks-claude-code/tests/config.spec.ts` | +20 |
| `packages/experimental/hook-protocol/src/codec.ts` | +17 |
| `packages/experimental/hook-protocol/src/types.ts` | +9/-6 |
| `packages/experimental/hook-protocol/tests/codec.spec.ts` | +15 |
| `pnpm-lock.yaml` | +5 |

**Total: 18 files changed, 368 insertions(+), 28 deletions(-).**

## Commit this applies to

`b830ec950faba0a46dda564be3e2d854afed94f1` — tag `dsh-v0.2.1-rc.5`,
"Merge pull request #7572 from deepseek-harness/worktree/release-dsh-0.2.1-rc.5"
(merging "release(dsh): 0.2.1-rc.5"), 2026-10-29. This is the exact commit
the version string `0.2.1-rc.5` (matching the task's reference version)
resolves to in `packages/experimental/hooks-claude-code/package.json` at
that tag.
