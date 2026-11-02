# @markishh/dsh-model-tiers

**Status: implemented.** `index.js` + `lib/aliases.js` + `lib/retry.js`, tested with `node:test`
(39 passing tests) and verified with one real `dsh --profile headless` call. This file is the
spec; see the end of this file for implementation notes and verified deviations.

Written against host `0.2.1-rc.5` (`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`).

## Purpose

One place where the model policy lives. It answers "what does `model: opus` mean on this
deployment" with a DeepSeek route, logs the route actually used on every request, and retries the
two protocol-level failures the host's own retry policy leaves terminal.

Owns hardening requirements **(a)** and **(d)**.

## Inputs

No files. Config only — deliberately, so the policy is reviewable in the profile's
`cordis.patch.yml` diff rather than scattered across agent markdown.

## The alias table

| alias | provider | model | reasoningEffort | why |
|---|---|---|---|---|
| `haiku` | `deepseek-official` | `deepseek-flash` | `low` | mechanical steps; effort is the tier knob, not the model |
| `sonnet` | `deepseek-official` | `deepseek-flash` | `high` | the default build/test lane |
| `opus` | `deepseek-official` | `deepseek-flash` | `max` | judgment, architecture, review |
| `medium` | `deepseek-official` | `deepseek-flash` | `high` | `effort: medium` appears in real agent rosters; DeepSeek has no `medium` (`off`/`low`/`high`/`max`), so it folds into `high` |
| `review` | `deepseek-official` | `deepseek-v4-pro` | `max` | **opt-in only.** Not reachable from any `model:` key; a caller must name `review` explicitly |

DeepSeek only. `deepseek-flash` carries the same 1,048,576-token window as `deepseek-v4-pro`
(`dsh-llm-deepseek/README.md`: "the text- and image-capable `deepseek-flash` alongside the
text-only `deepseek-v4-pro`, each with the 1,048,576-token context window the official model
listing declares" — `1,000,000` is that package's `defaultContextWindow`, the fallback for models
*without* an exact value, not the figure for either of these two), so the tier choice buys
reasoning depth, not capacity. `deepseek-flash` is also the only default entry declaring
`systemPromptUpdate: in-history` and `toolUpdate: addition-only` — which is what lets the loop
append a changed prompt after cached history instead of rewriting the leading system message
(same README, "Endpoint and wire format"). Moving a lane to `deepseek-v4-pro` therefore costs
prefix-cache reuse as well as money. That is the reason `review` is opt-in.

`provider: deepseek-official` is the route name the DeepSeek adapter registers; the alternative
`deepseek-account` resolves only a stored account grant and "neither route falls back to the
other" (same README, "Account credentials").

## dsh seams used

| seam | kind | why | verified in |
|---|---|---|---|
| `ctx.provide('modelTiers', {resolve, resolveDetailed, aliases})` | service publish | `dsh-task-tool` and any profile row reads the policy from here | cordis service pattern |
| `ctx.on('agent/request', (payload, next) => …)` | **waterfall** returning `LlmCallConfig` | (d) read the resolved route and log it; optionally stamp an alias-derived effort | `dsh-agent/lib/types/runtime-types.d.ts:327` — payload `{agent, turn, step, signal}`, `next()` yields "the config the machine would use (agent options on the first request, the logged header afterwards)" |
| `ctx.on('agent/request-error', (payload, next) => …)` | **waterfall** returning `RequestErrorAction` | (a) return `{kind:'retry'}` for the configured codes | `dsh-agent/lib/types/runtime-types.d.ts:348` — payload `{agent, turn, step, provider, failure, retryPolicy, signal}`; `RequestErrorAction` at `:101`; "A listener returns `{ kind: 'retry' }` without calling `next()` when it owns recovery, or calls `next()` to delegate" |
| `ctx.logger` | diagnostics | the per-request route line | cordis |

## Config schema (schemastery)

```ts
export const Config = z.object({
  provider: z.string().description('LLM route name every alias resolves to.').default('deepseek-official'),
  aliases: z.dict(z.object({
    model: z.string().required(),
    reasoningEffort: z.union(['off', 'low', 'high', 'max']),
    maxTokens: z.natural(),
  })).description('Alias name to DeepSeek route.').default({ /* the table above */ }),
  logResolvedRoute: z.boolean().description('(d) Log provider/model/effort for every model request.').default(true),
  logLevel: z.union(['debug', 'info']).description('Level for the resolved-route line.').default('info'),

  // (a) protocol-level retry the host leaves terminal
  retry: z.object({
    codes: z.array(z.string()).description('LlmFailure codes this plugin retries.').default(['MALFORMED_RESPONSE', 'STREAM_CLOSED']),
    maxAttempts: z.natural().description('Retries per step, beyond the provider policy; 0 disables.').default(2),
  }).default({}),
})
```

## Behaviour

**(d) Route logging — one line per request.** `agent/request` is a waterfall; the listener
`await next()` to get the config the loop would use, logs
`model-tiers: turn=<n> step=<n> provider=<p> model=<m> effort=<e> agent=<session-id>`, and returns
that config unchanged unless an alias stamp applies.

Why this is needed rather than reading the session log: the loop writes a `request/header` only
"for the first request, a changed envelope … an explicit message-series start, a request after a
surface replacement or image-offload decision, and resume; **unchanged steps, retries, and
ordinary later turns in the same series inherit the latest header**"
(`dsh-agent-loop/README.md`, "Request headers and adapter defaults"). It also writes
`request/context` "only when one of those differs from the latest snapshot". So the durable log
does not state the route for every request, and an alias that silently resolves differently than
expected is invisible. One unconditional line per request is the fix, and it is the cheapest
possible instrumentation.

**(a) Retry on protocol violations.** The adapter "throw[s] `STREAM_CLOSED` or
`MALFORMED_RESPONSE`" for protocol violations and a content-free terminal stop becomes
`EMPTY_RESPONSE` (`dsh-llm-deepseek/README.md`, "Failures and recovery"). The host executor
`@deepseek-ai/dsh-llm-retry` in normal mode covers "`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`,
`TIMEOUT`, and `TRANSPORT`" — **not** `MALFORMED_RESPONSE` and **not** `STREAM_CLOSED`
(`dsh-llm-retry/README.md`, "Minimal configuration").

There are two routes to fixing that, and the honest answer is that the **config route is better
and this plugin is the fallback**:

- **Config route (preferred, zero code).** `retryPolicy.retryableCodes` is a real adapter config
  field (`dsh-llm/lib/types/retry-policy.d.ts:26`). Adding `MALFORMED_RESPONSE` and
  `STREAM_CLOSED` to the `llm-deepseek` row's `retryPolicy.retryableCodes` gets durable,
  backoff-aware, session-logged retries (`llm/retry` + `llm/retry-started` events) for free. The
  `cc` profile does this. **Do that first.**
- **Plugin route (this package).** `agent/request-error` with a per-step attempt counter, for the
  case where the failing route is not the DeepSeek row (a gateway `baseURL`, a future provider) or
  where the deployment cannot edit the adapter row. Returning `{kind:'retry'}` here is a bare
  re-run with no backoff and no `llm/retry` log entry, so it is strictly worse observability.
  Default `maxAttempts: 2` and log every one.

**Malformed tool-call JSON is a third, different thing** and this plugin does not handle it.
"Model arguments are validated before execution; invalid input becomes a normal error result"
(`dsh-tools/README.md`, "Register a tool"), and `ToolArgsError` is exported from
`dsh-tools/lib/types/index.d.ts:24`. So bad tool-call JSON never reaches `agent/request-error`;
it reaches the model as an error result it can correct. What it *can* do is loop. Counting that is
`dsh-task-tool`'s loop guard, and the pilot measures it as "malformed tool calls per 100 steps"
by counting `ToolArgsError`-shaped results in the session log.

## Failure modes

- **An agent file names a `model` with no alias.** `resolve()` returns the string as an exact
  model id on the configured provider — the DeepSeek adapter passes unlisted ids through as
  text-only routes ("core calls still pass unlisted model ids through as text-only routes",
  `dsh-llm-deepseek/README.md`). Logged at warn once per name, because a typo'd model id that
  *works* is a silent cost change.
- **`reasoningEffort` the adapter rejects.** Fails with `UNSUPPORTED_REASONING_EFFORT` "before
  network I/O", and `thinking: disabled` on the adapter "rejects any non-`off` effort at plugin
  load" (same README). The plugin validates its alias table against
  `ctx.llm.resolveModelInfo()` at mount where available and refuses to mount on a mismatch rather
  than failing on the first request.
- **Retry budget exhausted.** Call `next()` and let the failure be terminal. Never swallow.
- **Cancellation during a retry.** The turn signal is in the payload; abort immediately.
- **`agent/request` listener throws.** The loop treats middleware failure as turn-ending
  ("Middleware, result-processing, tool, and other extension failures remain thrown and close the
  turn directly — plugin failure ends the turn, not the loop", `dsh-agent-loop/README.md`). So the
  logging path is wrapped in try/catch and a logging failure is swallowed with one warning. A log
  line must never end a turn.

## What it explicitly does NOT do

- Does not register a model, a route or a credential. `@deepseek-ai/dsh-llm-deepseek-api-key`
  owns the adapter; this plugin only names routes it already serves.
- Does not change `maxTokens` or compaction thresholds.
- Does not add a non-DeepSeek provider, and has no code path that could.
- Does not touch `llm/stream`. `@dsh-cc/model-aliases` registers there with
  `{global: true, prepend: true}` to front-run every other listener in the process; that is a
  seam abuse we are not copying.
- Does not retry `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT` or `EMPTY_RESPONSE` —
  `dsh-llm-retry` already owns those, with backoff and a durable log. Doubling them up would mean
  two uncoordinated budgets.

## Test plan

`node:test` with a fake `ctx` exposing `on`, `provide`, `logger`, and an optional `llm`.

1. **`resolve`**: every alias in the table; `medium → high`; an unknown name passes through as an
   exact model id with one warn; `review` is reachable by name and never by a `model:` key.
2. **(d) logging**: one line per `agent/request`, containing the provider, model and effort from
   `next()`'s config; the config is returned byte-identical when no stamp applies; a throwing
   logger does not propagate.
3. **(a) retry**: a `MALFORMED_RESPONSE` failure returns `{kind:'retry'}` and does not call
   `next()`; the third occurrence in one step calls `next()` instead; a `RATE_LIMIT` failure
   always calls `next()` (left to `dsh-llm-retry`); `maxAttempts: 0` always delegates; the
   counter is per `(turn, step)` and resets.
4. **Mount validation**: an alias whose effort the stubbed `resolveModelInfo` rejects refuses the
   mount with a message naming the alias.
5. **Cancellation**: an aborted signal short-circuits the retry decision.

## Estimated size

~190 lines: `index.js` (service, listeners — ~110), `aliases.js` (table + resolve, ~50),
`retry.js` (attempt counter, ~30).

## Implementation notes (post-build)

Actual size: `index.js` 100 lines, `lib/aliases.js` 73 lines, `lib/retry.js` 33 lines — within
the estimate and the 150-line `index.js` cap.

- `aliases.js`'s default alias table is deliberately **not** `Object.freeze`d. Schemastery
  resolves a `z.dict` default by writing resolved field values onto (a clone of) the default
  object in place; a frozen default throws `TypeError: Cannot assign to read only property`
  during `Config()`. Verified empirically; each `Config()` call still gets its own independent
  alias objects (schemastery clones before mutating), so this is safe.
- `resolveDetailed()`/`resolve()` share one `warned` `Set` so an unknown name warns exactly once
  regardless of which function is called, matching the test plan's "one warn" requirement.
- The mount-time alias validation (`ctx.llm.resolveModelInfo`) is skipped, not failed, when
  `ctx.get('llm')` is unavailable or a lookup throws — the spec's "at mount **where available**"
  is read as non-fatal absence, fatal-on-mismatch presence.
- Cancellation (`signal.aborted`) in the `agent/request-error` listener returns `undefined`
  directly without calling `next()` — read as "this listener owns the decision to not retry,"
  rather than delegating a cancelled attempt further down the waterfall.

### Review-fix round (coordinator findings)

Four findings came back from review. All are fixed in this package only; nothing outside
`packages/dsh-model-tiers/` was touched.

1. **CRITICAL — retry budget leaked across concurrent agents** (`lib/retry.js`). The budget key
   was `${turn}:${step}` with no agent identity. `agent/request-error` dispatches to every agent
   in the process unless a listener is scope-filtered
   (`dsh-agent/lib/types/runtime-types.d.ts`, the `'agent/request-error'` waterfall), and this
   plugin's listener (`index.js`, the `ctx.on('agent/request-error', ...)` call) is not
   agent-scoped — so two concurrent subagents both failing at turn=1 step=1 shared and exhausted
   one counter. Fixed by keying on `` `${sessionId}:${turn}:${step}` `` (`lib/retry.js:57`), with
   `sessionId` read from `agent.session.id` (confirmed real: `dsh-session`'s `Session` class
   declares `get id(): SessionId` — "the session identity, derived from its durable header's
   single copy" — and `dsh-agent/lib/types/runtime-types.d.ts` declares `Agent.session: Session`).
   `index.js`'s `sessionIdOf(agent)` helper (`index.js:36-38`) reads that path with a safe
   fallback, and both the `agent/request` logging listener and the `agent/request-error` retry
   listener now call it. No `agent/turn-end` hook clears a key once a step succeeds, so instead
   the `Map` is bounded by a small LRU cap (`MAX_TRACKED_STEPS = 1000`, `lib/retry.js:26`,
   eviction logic at `lib/retry.js:34-46`) — a long-running process cannot grow it unbounded.
   Test: `test/retry.test.js` — "two concurrent agents at the same (turn, step) do not share a
   budget" (tracker unit) and "the tracked-step map is bounded by a small LRU" — plus
   `test/index.test.js` — "(a) retry: CRITICAL — two concurrent agents at the same (turn, step)
   get independent budgets" (through the real registered listener, not just the tracker).

2. **CRITICAL — `resolve(name)` cannot express `model:` + `effort:` together** (`lib/aliases.js`).
   Real agent files set both (e.g. `db-steward.md`: `model: haiku` + `effort: medium`;
   `reviewer.md`: `model: opus` + `effort: high`), and `effort:` must OVERRIDE the tier's own
   default effort, not get ignored. Added `resolveAgent({model, effort})` (`lib/aliases.js`,
   exported from `createResolver` alongside `resolve`/`resolveDetailed`, published on
   `ctx.modelTiers.resolveAgent` from `index.js`). **Exact signature, for `dsh-task-tool` to call:**

   ```
   modelTiers.resolveAgent({ model: string, effort?: 'off' | 'low' | 'high' | 'max' | 'medium' })
     => { provider: string, model: string, reasoningEffort?: string, maxTokens?: number } | undefined
   ```

   Behaviour: `model` resolves exactly like `resolve(model)` (alias lookup, or an unknown name
   passed through as an exact id with the same one-time warn). When `effort` is given, it is
   folded through `foldEffort()` (`lib/aliases.js` — `off`/`low`/`high`/`max` pass through
   unchanged; `medium` is looked up in the SAME alias table used for models, reusing the
   `medium` row's `reasoningEffort: 'high'` rather than hardcoding the fold a second time) and
   that folded value REPLACES the tier's default `reasoningEffort` in the result. `model:
   'inherit'` returns `undefined` regardless of `effort` (see finding 4). `resolve(name)` is
   unchanged and remains the single-name form. Test: `test/aliases.test.js` — the `resolveAgent:
   ...` block covers the db-steward (haiku+medium→high) and reviewer (opus+high→high, overriding
   opus's own max) cases by name, plus all four raw efforts and the unknown-model+effort
   combination.

3. **`ctx.get('llm')` without `inject` silently no-ops if `llm` activates later** (`index.js`).
   A one-shot `ctx.get('llm')` snapshot at mount time would never re-check if the `llm` service
   became available afterward, quietly breaking the DESIGN.md "refuses to mount on a mismatch"
   promise for any deployment where plugin mount order puts this plugin ahead of the adapter.
   Fixed (`index.js`, in `apply()`): when `ctx.inject` exists, mount validation now runs through
   `ctx.inject(['llm'], injectedCtx => validateAliases(injectedCtx, config))` instead, which starts
   the check once `llm` is actually available — immediately if it already is, or later if not —
   and is disposed with this plugin either way. Honesty note: this means the refusal no longer
   necessarily blocks `apply()` itself when `llm` is not synchronously available (the validation
   now runs in `ctx.inject`'s own nested fiber, whose rejection surfaces there, not as a rejected
   `apply()` promise) — it fixes the "silently never happens" failure mode, not the exact timing
   of the refusal. When the current `ctx` has no `inject` at all (a minimal fake, as in most of
   this package's own tests), `apply()` falls back to the original synchronous `ctx.get()` check,
   so a mismatch available at mount time still rejects `apply()` directly — this is also exactly
   the real host's shape with `ctx.inject` present, verified in `test/index.test.js`: "when
   ctx.inject exists, mount validation routes through it instead of a one-shot ctx.get()" and
   "ctx.inject path mounts cleanly when the later-activating adapter matches".

4. **`model: 'inherit'` semantics** (`lib/aliases.js`). Decided and implemented in one place:
   `resolveDetailed('inherit')` returns `{inherit: true}` (no `provider`/`model` keys at all);
   `resolve('inherit')` and `resolveAgent({model: 'inherit', ...})` both return `undefined` —
   never the literal string `'inherit'` passed through as if it were a real model id — regardless
   of any `effort` given alongside it (inherit means "use the parent's whole `AgentOptions`
   untouched," so there is nothing to override onto). A caller (`dsh-task-tool`) should treat
   `undefined` from any of these three functions as "omit `agentOptions` entirely; let the parent
   session's own options stand." `'inherit'` is recognized before the unknown-alias branch, so it
   never emits the "unknown model" warning. Test: `test/aliases.test.js` — "inherit:
   resolve('inherit') is undefined, not the literal string" and "inherit: resolveAgent ignores
   effort when model is inherit".

### Verification performed

**Unit tests** (`node --test test/*.test.js`, 39/39 passing) cover every item in the test plan
above against a fake `ctx` (`on`, `provide`, `get`, `logger`).

**Real integration run**, one real DeepSeek call via the actual host (`dsh --version` →
`0.2.1-rc.5`):

```
$ DSH_HOME=$HOME/.dsh dsh --profile headless --patch /tmp/model-tiers.overlay.yml \
    "reply with the single word OK"
[11/02/26 01:12:08] INFO     Processing request of type            server.py:733
                             ListToolsRequest
[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)
OK
```

- (a) activates with no "did not activate" warning (confirmed via `--dump-config` too — the
  `cc-model-tiers` row is present and resolves to this file).
- (c) the answer is `OK`.
- (b) the per-request route line **does fire** on every request, but is invisible on this host's
  stdout/stderr by default: `dsh-llm-deepseek-api-key`'s own source carries the comment "product
  profiles mount no console exporter for `ctx.logger`" and bypasses the logger entirely for its
  own diagnostics (`[llm-deepseek-api-key] ...` above is a raw `console`-style write, not a
  `ctx.logger` call). `ctx.logger`'s own default exporter only buffers messages in memory
  (`LoggerService`'s constructor registers an exporter that pushes to a ring buffer, nothing
  else); no shipped profile wires a console sink for it. This is a **host configuration fact**,
  not a bug in this plugin: registering a temporary diagnostic `ctx.logger.exporter()` (a
  throwaway companion plugin, not part of this package) on the same run captured:
  `[LOGGER type=info name=dsh-model-tiers] model-tiers: turn=1 step=1 provider=deepseek-official
  model=deepseek-flash effort=- agent=session-bbdcd885-fdec-48f2-9d82-6d4fa13f52aa` — proving the
  waterfall listener fires exactly once per request with the right fields. `effort=-` is correct:
  this headless profile's default agent omits an explicit `reasoningEffort` on its call config
  (no alias was involved in this bare run), and the log line reports `next()`'s config as-is.
  Whoever wires a profile's visible diagnostics (dsh-tui's own console sink, or a future
  `dsh-cordis-console-exporter` row) is what will make this line visible in practice; this
  plugin's job — emit it on every request — is done and verified.
