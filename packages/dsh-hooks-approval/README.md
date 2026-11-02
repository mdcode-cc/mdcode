# @markishh/dsh-hooks-approval

Runs the `PermissionRequest` (blocking approval relay) and `SessionEnd`
command hooks from a Claude Code `settings.json` — the two hook events
`@deepseek-ai/dsh-hooks-claude-code` does not bridge (its `CLAUDE_EVENTS`
list: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
`SubagentStart`/`Stop` — no `PermissionRequest`, no `SessionEnd`).

## Why

A Claude Code `~/.claude/settings.json` can configure four hooks:
`SessionStart`, `UserPromptSubmit` (both run by the first-party bridge),
`PermissionRequest` and `SessionEnd` (both silently dropped by it — no
supported-event equivalent in `dsh` host `0.2.1-rc.5`). This plugin runs
those last two. A common reference use case for `PermissionRequest` is an
approval relay that blocks for a human decision — e.g. a hook process that
waits on a human to approve or deny a tool call out-of-band and then prints
the decision to stdout.

- **PermissionRequest** is wired as a PREPENDED answerer on dsh's
  `approval/request` waterfall (`@deepseek-ai/dsh-user-approval`,
  `ctx.on(..., true)` — cordis's unshift shorthand): when a tool call needs
  a human/machine decision, this plugin runs the configured command hook and
  maps its `allow`/`deny` back onto the waterfall, same as a TUI approval
  prompt would. Prepending matters: dsh-tui's own answerer parks every ask
  for its human prompt and only calls `next()` on rejection, so an answerer
  registered AFTER it (the default, appended order) would never be
  consulted at all — the configured hook would simply never fire.
- **SessionEnd** runs its configured command hook, detached (bounded to its
  own 5s timeout, independent of plugin disposal — see **Known deviations**
  below), when `@deepseek-ai/dsh-session` emits `session/disposed`. This
  fires for subagent child sessions too (`session.header.origin ===
  'subagent'`), symmetric with the first-party bridge's own `SessionStart`
  (its `agent/created` listener has no origin filter either — every agent
  creation fires it, subagents included). Not filtered here either, to match
  that default; a daemon that keys sessions by pane/tty and would over-fire
  on a subagent sharing its parent's pane can add
  `if (session.header.origin === 'subagent') return` as the first line of
  the `session/disposed` listener.

## Config

| key | default | notes |
| --- | --- | --- |
| `configPath` | `path.join(os.homedir(), '.claude', 'settings.json')` | Absolute path to a Claude Code `settings.json` whose `hooks` key configures `PermissionRequest`/`SessionEnd`. |
| `events.permissionRequest` | `true` | Run the approval relay. |
| `events.sessionEnd` | `true` | Run the SessionEnd hook. |
| `timeoutMs` | `600000` (10 min, `DEFAULT_HOOK_TIMEOUT_MS` from `dsh-hook-protocol`) | Default per-hook timeout; a per-hook `timeout` (seconds) in settings.json overrides it. |
| `fallback` | `'next'` | What the approval relay does when the hook fails, times out, or expresses no allow/deny: `'next'` delegates to the next answerer (e.g. a TUI prompt); `'deny'` rejects outright. |
| `cacheMaxAgeMs` | `300000` (5 min) | How long a cached `tools/pre-execute` tool-input survives without a matching `tools/post-execute`. |

```yaml
- name: '@markishh/dsh-hooks-approval'
  config:
    # Default: path.join(os.homedir(), '.claude', 'settings.json') — pass an
    # explicit path only to point at a different settings.json.
    configPath: '~/.claude/settings.json'
```

## How it works

- `lib/settings.js` parses `settings.json`'s `hooks` key for
  `PermissionRequest`/`SessionEnd` only, same group/matcher shape as the
  first-party bridge's own parser. `SessionEnd` has no matcher subject (like
  the bridge's `UserPromptSubmit`/`Stop`) — its matcher is always discarded.
  `PermissionRequest` fires per tool call, so its matcher is matched against
  the tool name at request time (`selectHookGroups`, `'claude-code'` mode).
- `lib/cache.js` caches `{toolName, arguments, sessionId}` by `callId` on
  `tools/pre-execute` (without changing its decision — always `next()`), read
  on `approval/request` (which carries no tool arguments of its own), evicted
  on `tools/post-execute` or after `cacheMaxAgeMs`.
- `lib/payload.js` builds the Claude Code JSON payload, following
  `dsh-hooks-claude-code`'s own `base()` convention (`transcript_path: ''`).
- `lib/decision.js` maps the hook's output to an `ApprovalOutcome` —
  see **Known deviation** below, this is the one non-obvious part.
- `lib/shell-adapter.js` runs the configured command — see **Known
  deviation** below.
- `index.js` wires it all through `runHook`/`selectHookGroups`/
  `mergeHookOutputs` (`@deepseek-ai/dsh-hook-protocol`), `ctx.on('tools/pre-
  execute' | 'tools/post-execute' | 'approval/request' | 'session/disposed',
  ...)`, and `createDetachedRuns()` for the SessionEnd fire-and-forget path.

## Known deviations (read before trusting this in production)

1. **PermissionRequest's decision shape is NOT the shared codec's shape.**
   `@deepseek-ai/dsh-hook-protocol`'s `parseHookOutput` only recognizes the
   flat `hookSpecificOutput.permissionDecision: 'allow'|'deny'|'ask'` field —
   it was built only for the events the first-party bridge supports
   (`PreToolUse` et al.), not `PermissionRequest`. Claude Code's real
   `PermissionRequest` contract (and a real approval-relay hook's own
   stdout) nests the decision instead:
   `hookSpecificOutput.decision.behavior`/`.message`. So `runHook`'s generic
   `output.decision` is always `undefined` for a real `PermissionRequest`
   hook; `lib/decision.js`'s `reconcilePermissionDecision()` re-derives it
   from the raw `output.stdout` `runHook` still preserves verbatim, then
   hands the result to `mergeHookOutputs` so precedence/reason-joining still
   apply unchanged. **Verified against a real headless run** (see below) —
   this is not a guess, the generic codec genuinely misses this nested shape
   and the reconciliation fixes it.
   Exit code 2 (the shared "blocking" convention across every Claude Code
   hook type) is left as the generic codec already decoded it — **not**
   independently verified against an official `PermissionRequest` spec
   section for that exact exit code, just assumed consistent with every
   other hook type's documented exit-2 convention.
   `async: true` on a hook entry (commonly set on `SessionStart`/
   `SessionEnd`, not `PermissionRequest`) is parsed but **ignored** — same
   as the first-party bridge, which doesn't read it either. `SessionEnd`
   already runs detached/fire-and-forget regardless of this field; a
   `PermissionRequest` hook marked `async: true` would still block exactly
   like one without it, since blocking IS the point of an approval relay.

2. **Hook commands run through a thin `node:child_process` adapter
   (`lib/shell-adapter.js`), not the host's real `ctx.shell`.**
   `dsh-hooks-claude-code` runs hook commands through `ctx.shell`
   (`@deepseek-ai/dsh-shell`'s `ShellExecutor` — credential scrub, sandbox,
   process-group cancellation). `ShellExecutor` is an abstract cordis
   `Service`; its concrete implementations (`dsh-bash-local`/
   `dsh-bash-sandbox`) need a full cordis Context to construct
   (`ctx.subprocess`, sandbox config, timeouts), which is out of scope for
   this small relay plugin and its tests. This adapter implements only the
   exact surface `runHook` calls (`bash.execute(bash.resolve(request))
   .result()` → `{exitCode, stdout:{text}, stderr:{text}}`, confirmed by
   reading `dsh-hook-protocol`'s actual `runHook` implementation) via a plain
   spawned child process — **no credential scrubbing, no sandbox, no
   process-group kill** (best-effort `SIGKILL` on timeout/abort only).
   Hook commands here run at the same trust level any configured Claude
   Code hook command already runs at — not a new privilege boundary.
   Production (`index.js`) and tests (`test/subprocess.test.js`) use this
   exact module; there is no second implementation, so there is no
   divergence between what's tested and what runs.
   `child.stdin` carries an explicit no-op `'error'` listener: a hook that
   exits without reading stdin (or never reads it) hits a closed pipe on the
   write — EPIPE — which without that listener is an UNCAUGHT exception on
   `child.stdin` (no `'error'` handler on a Writable throws uncaught in
   Node), crashing the WHOLE host process, not just this one hook run.
   Reproduced directly (`test/fixtures/exit-without-reading-stdin.sh` + a
   >64KB payload) and proven fixed in `test/subprocess.test.js`.

3. **No `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` substitution.**
   The first-party bridge substitutes these tokens into hook commands;
   `lib/settings.js` does not. Not part of the approval-relay contract this
   was built against, and out of scope for a two-event relay.

4. **`ask` is not a recognized PermissionRequest outcome.** Only
   `allow`/`deny` are decoded (matching a real approval-relay hook's
   contract); a hook that nests `decision.behavior: 'ask'` is treated as
   undecided and falls to `fallback`. A `PermissionRequest` hook asking back
   doesn't have an obvious meaning — the request itself *is* the ask.

5. **SessionEnd uses its own bounded `AbortSignal.timeout(5000)`, NOT
   `createDetachedRuns()`'s `detached.signal`.** `dsh-hook-protocol`'s
   `drain()` (run on plugin disposal) `controller.abort()`s that signal
   BEFORE awaiting in-flight runs (`lib/index.js`: `controller.abort(); while
   (inflight.size > 0) await Promise.allSettled(...)`), and this plugin's own
   abort handler `SIGKILL`s on fire. Using `detached.signal` directly would
   mean a normal quit kills the SessionEnd hook the INSTANT disposal starts
   — before an async notifier hook even finishes connecting to its socket.
   The run is still `detached.track()`ed, so `drain()` still *awaits* it; it just no
   longer *aborts* it early. Proven both ways in `test/apply.test.js`
   (`session/disposed: an immediate dispose() ... does NOT kill the hook`),
   including a before/after regression check against the old behavior.

## Tests

`node --test test/*.test.js` — 51 tests:

- `test/settings.test.js` — settings.json parsing, matcher semantics
  (`selectHookGroups`), non-command skip, bare event map, invalid regex.
- `test/cache.test.js` — set/get/delete, time-based eviction, and that
  `set()` itself never sweeps (only `get()`/`size()` do — proven by spying
  on the `now` clock's call count, not just by behavior).
- `test/payload.test.js` — payload field shape for both events.
- `test/decision.test.js` — `reconcilePermissionDecision` against a real
  approval-relay hook's nested shape (allow/deny/exit-2/malformed/
  unrecognized), `outcomeFor` mapping including both fallback values.
- `test/subprocess.test.js` — **real subprocess** runs through the real
  `runHook` + the real `lib/shell-adapter.js` (the same module production
  uses): `allow.sh`/`deny.sh`, a missing script, a timeout kill, an aborted
  signal kill, and a >64KB-payload EPIPE regression test (fails without the
  `child.stdin` error-listener fix, verified by temporarily reverting it).
- `test/apply.test.js` — full plugin wiring through a fake `ctx` (settings
  load failure, skipped hook type, disabled events, matcher filtering,
  both fallback values, two concurrent approvals for different tool calls,
  an aborted mid-run approval falling back to `next()`, `tools/pre-execute`
  caching AND `tools/post-execute` eviction proven by inspecting the exact
  `tool_input` a real hook process received, `cwd`/`CLAUDE_PROJECT_DIR`
  threading proven the same way, and the `session/disposed` immediate-
  dispose regression test above) — hook execution itself is still the real
  fixture scripts/inline commands through the real runner; only `ctx` is
  faked.

## Real verification (headless, since headless has no approval UI)

Ran `DSH_HOME=$HOME/.dsh DSH_PERMISSION_MODE=read-only dsh --profile
headless --patch <overlay> "run the shell command: touch <marker path>"`
against a real build (temporarily adding this package +
`@markishh/dsh-plugin-log` as `headless` profile dependencies, reverted
after):

1. **Deny variant** (`test/fixtures/deny.sh` as the configured
   `PermissionRequest` hook) — the model's `touch` was denied by the
   read-only sandbox, it retried with an escalation, and that escalation was
   denied: `plugins.log` recorded
   `PermissionRequest relay for "bash" -> deny (rejected)`. The marker file
   was never created.
2. **Allow variant** (`test/fixtures/allow.sh`) — same flow, but the
   escalation retry succeeded: `plugins.log` recorded
   `PermissionRequest relay for "bash" -> allow (allowed-once)`. The marker
   file was created.
3. **A real approval-relay hook with no live daemon listening** — the
   hook's own connect attempt failed and it exited 0 with no stdout (its own
   socket-error-swallowing path); this plugin correctly decoded that as no
   decision and fell back (`fallback: 'next'`): `plugins.log` recorded
   `PermissionRequest relay for "bash" -> none (next)`, and with no other
   answerer composed in headless, the model reported `no approval channel is
   available`. This proves the relay's *failure path* against a real
   approval-relay hook binary; it does **not** prove a live round-trip
   through an actual running daemon — no live daemon was running to test
   that against.

`SessionEnd` was verified only through the fake-`ctx` test
(`test/apply.test.js`), not a real boot — `dsh --profile headless` doesn't
keep a session open long enough after the single task to observe
`session/disposed` cleanly in a scripted run, and forcing it was judged not
worth a real-run slot.

4. **Fix re-verification (deny fixture only)** — after the
   `ctx.on(..., true)` prepend, `cwd`/`CLAUDE_PROJECT_DIR` threading, bounded
   SessionEnd signal, and `child.stdin` EPIPE guard fixes, re-ran the same
   deny-fixture scenario once: the escalation was again denied, and
   `plugins.log` recorded the same
   `PermissionRequest relay for "bash" -> deny (rejected)` line, confirming
   the fixes didn't change the observable relay behavior (as expected — they
   fix ordering/robustness/timing, not the deny path's outcome).
