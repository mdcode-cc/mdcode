# @markishh/dsh-agents-md

**Status: implemented.** `node --test test/*.test.js` is green; the real-mount check (Q7,
below) passed live against `0.2.1-rc.5` under the `headless` profile. Under the real `cc`/
`dsh-tui` composition it does not (Q4, below) — a host-level defect, not a defect in this plugin's
code (isolation-proven: the same failure persists with every row this package registers disabled).

Written against host `0.2.1-rc.5` (`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`).

## Purpose

Read Claude-Code-style agent definition files and turn each one into a real dsh **agent preset** —
a named composition the subagent system can mount for a child independently of its parent. Also
publish the parsed roster as a catalog so `@markishh/dsh-task-tool` can map a `subagent_type`
to a preset id, a model tier and a tool mask without re-parsing anything.

**Trust boundary.** Project-root `.claude/agents/*.md` files are trusted, not sandboxed: starting
dsh inside a hostile clone installs that clone's prompts as real agent presets with no review
step. Same trust model as Claude Code's own project agents.

It is the only package in this repo that touches agent markdown.

## Inputs

Directories, scanned in this precedence order (later shadows earlier, keyed by agent name):

| rank | source | path |
|---|---|---|
| 1 | user | `<userDir>` — default `$HOME/.claude/agents` |
| 2 | project | `<projectRoot>/.claude/agents` |
| 3 | extra | each entry of `extraDirs`, in order |

`projectRoot` is the nearest ancestor of the session cwd containing `.git`, else the cwd — the
same rule `@deepseek-ai/dsh-skill-filesystem` documents for its project root
(`dsh-skill-filesystem/README.md`, "Roots and priority"). Top-level `*.md` only; no recursion;
dotfiles (`.retired-foo.md`) are skipped even when they end in `.md`.

Frontmatter keys honoured — every key a real `~/.claude/agents/` roster actually uses, and
nothing else:

| key | type | meaning |
|---|---|---|
| `name` | string | agent id; defaults to the filename stem, and must equal it when present |
| `description` | string, **required** | dispatch hint shown to the delegating model |
| `model` | `haiku` \| `sonnet` \| `opus` \| exact DeepSeek id | tier name, resolved by `dsh-model-tiers` |
| `effort` | `off` \| `low` \| `medium` \| `high` \| `max` | overrides the tier's default effort (`medium` maps to `high`; see DESIGN §3) |
| `tools` | `string[]` or comma-separated string | allowlist; absent means inherit everything. Normalized into `dshTools` — see "Tool name mapping" below |
| `disallowedTools` | `string[]` or comma-separated string | denylist, applied after `tools`. Normalized into `dshDisallowedTools` |
| `permissionMode` | `default` \| `acceptEdits` \| `plan` \| `bypassPermissions` | parsed and recorded; **not enforced** — see failure modes |
| `maxTurns` | positive integer | parsed and recorded; enforcement is `dsh-task-tool`'s |
| `skills` | `string[]` | skills the child must load first; rendered as a line in its persona |

The markdown body below the frontmatter is the agent's system prompt, verbatim.

## Tool name mapping (CC -> dsh)

Agent frontmatter names tools the Claude Code way (`Read`, `Edit`, `Bash`, `Skill`, ...); dsh
registers tools under its own names (`read`, `edit`, `bash`, `skill`, ...) — a bare string
comparison between the two would silently mask nothing. `lib/tool-names.js` is the single table
this repo uses to bridge that gap, built by grepping each tool package's own
`defineTool({ name: ... })` call on this host (`0.2.1-rc.5`):

| CC name | dsh name(s) | source |
|---|---|---|
| `Read` | `read`, `read_image` | `dsh-tool-fs` |
| `Edit` | `edit` | `dsh-tool-fs` |
| `Write` | `write` | `dsh-tool-fs` |
| `Grep` | `grep` | `dsh-tool-fs-search` |
| `Glob` | `glob` | `dsh-tool-fs-search` |
| `Bash` | `bash` | `dsh-tool-bash` / `dsh-tool-bash-persistent` (exactly one enabled per platform) |
| `Skill` | `skill` | `dsh-tool-skill` |
| `WebFetch` | `web_fetch` | `dsh-tool-web` |
| `WebSearch` | `web_search` | `dsh-tool-web` |
| `TodoWrite` | `todo_write` | `dsh-tool-todo` |
| `Task` | `Task` | `@markishh/dsh-task-tool`'s configurable `toolName`, which the `cc` profile sets to `Task` — an identity mapping on this host |
| `Agent` | `Task` | no tool literally named "Agent" on this host; same delegation surface as `Task` |
| `NotebookEdit` | `edit` | no notebook-specific tool in this row set; closest analog |
| `TaskCreate` / `TaskUpdate` / `TaskList` | `todo_write` | Claude Code's three-tool task tracker folds into dsh's one `todo_write` tool |

`toDshToolNames(names, warnUnknown)` maps a frontmatter `tools`/`disallowedTools` list to the
corresponding dsh names, deduplicated, in first-seen order. A name this table does not cover is
dropped (never guessed at) and reported through `warnUnknown` — `index.js` wraps that in a
per-process dedup so the same unknown name across many agent files warns exactly once, not once
per file.

Every parsed descriptor carries both forms side by side:

| field | contents |
|---|---|
| `tools` / `disallowedTools` | the frontmatter originals, untouched |
| `dshTools` / `dshDisallowedTools` | the same lists, mapped through the table above |

`dsh-task-tool`'s mask guard reads **`dshTools`** and **`dshDisallowedTools`** — never the CC
originals — since those are the names that actually appear in `ctx.tools`'s catalog.

Unknown keys land in an `extra` bag and are logged once at debug level, never silently dropped.
A **known** key with an invalid value rejects that one agent with a warning naming the file and
the key; the rest of the roster still loads.

## dsh seams used

| seam | kind | why | verified in |
|---|---|---|---|
| `ctx.agentPresets.register({id, name, description, order, plugins})` → `Promise<disposer>` | service call | one preset per agent; `plugins` is a cordis loader entry list | `dsh-agent-preset-registry/lib/types/index.d.ts:44` and `definition.d.ts` (`PresetDefinition`) |
| `ctx.agentPresets.resolve(id)` → `Promise<{id, broken?}>` | service call | `register()` never rejects on an activation failure — it swallows it into `record.broken` (registry doc: "activation failure remains visible in the roster") — so `resolve()` is how this plugin reads that diagnostic back. Called lazily from `ctx.agentsMd.list()`/`get()`/`presetId()`, **never during `apply()`**: `resolve()` → `diagnostic()` can await the Host loader settling once any mounted row is merely pending, and `apply()` is itself one of the rows the loader is settling — calling it synchronously there is a documented deadlock risk, not a hypothetical one (`dsh-agent-preset-registry/lib/types/index.d.ts`, `diagnostic()`'s own doc: "Callers therefore must not run inside a Host row's own activation"). | `dsh-agent-preset-registry/lib/types/index.d.ts` (`resolve`, `diagnostic`); exercised live, see "Q7" below |
| `@deepseek-ai/dsh-persona` row inside each preset (`prefix`, `complete`, `includeRuntimeContext`) | child plugin | carries the agent body as that child's system prompt | `dsh-persona/README.md` "Use this package"; real usage in `~/.dsh/.agent-presets/example-preset/agent.cordis.yml` row `persona` |
| `ctx.provide('agentsMd', …)` | service publish | the catalog `dsh-task-tool` injects | cordis service pattern |
| `ctx.effect(…)` | cleanup | dispose every registered preset and stop the watcher on unload | `ctx.effect` is the documented cleanup seam; `@dsh-cc/subagent-task` uses it for exactly this |
| `node:fs` (direct) | filesystem | reads the host filesystem with `fs.readFileSync`/`fs.watch`, not the `ctx.get('fs')` harness seam — that service is fully async (`dsh-fs/lib/types/index.d.ts` has no `*Sync` method), so a sync branch on it could never run; keeping a dead branch around would be a hidden fake. Honest tradeoff documented here instead: this plugin does not go through the harness's fs sandboxing. | `dsh-fs/lib/types/index.d.ts` (checked: no sync methods exist) |
| `ctx.logger.warn` | diagnostics | per-file parse failures | same file |

No agent-loop event is used. This plugin is passive after mount.

## Config schema (schemastery)

```ts
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  userDir: z.string().description('User-level agent directory.').default('~/.claude/agents'),
  projectDirName: z.string().description('Project-relative agent directory.').default('.claude/agents'),
  extraDirs: z.array(z.string()).description('Extra roots, highest precedence last.').default([]),
  watch: z.boolean().description('Re-register presets when a file changes.').default(true),
  maxPromptBytes: z.natural().description('Cap on one agent body; a longer body is rejected, never truncated.').default(65536),
  defaultModel: z.union(['haiku', 'sonnet', 'opus']).description('Tier for an agent with no model key.').default('sonnet'),
  presetIdPrefix: z.string().description('Prefix for registered preset ids, to avoid colliding with first-party preset names.').default('cc-'),
  inheritPlugins: z.array(z.any()).description('Cordis entry rows every generated preset mounts beneath its persona — the tool/skill/compaction rows a child needs.').default([]),
})
```

`inheritPlugins` is how the `cc` profile hands every generated preset the same tool surface
without this package hard-coding a tool list. The profile owns the composition; this package owns
the identity and the prompt.

## Behaviour

1. On `apply`, resolve the roots, list `*.md`, parse each file into a descriptor.
2. For each descriptor, build a `PresetDefinition`:
   - `id`: `${presetIdPrefix}${name}` (e.g. `cc-reviewer`)
   - `name` / `description`: from the frontmatter
   - `plugins`: `[{ name: '@deepseek-ai/dsh-persona', config: { prefix: <rendered body>, complete: false, includeRuntimeContext: true } }, ...inheritPlugins]`
3. `await ctx.agentPresets.register(def)` for each. The disposer is parked in `ctx.effect`
   **before** any of this runs (registered first, closing over the mutable roster/watcher
   state), so a later throw — e.g. from `ctx.provide` — still disposes whatever got mounted
   instead of leaking it.
4. Publish `ctx.agentsMd` (all three accessors are `async` — see "Q1" below for why):
   - `list()` → `Promise<descriptor[]>`, frozen, ordered by name
   - `get(name)` → `Promise<descriptor | undefined>`
   - `presetId(name)` → `Promise<string | undefined>`
   - `revision` → a plain number `dsh-task-tool` compares to know its cached tool schema is stale
   - `onChange(cb) -> disposer` — `cb(revision)` fires once per `bump()` (i.e. once per reconcile
     that actually changed something), after `revision` has already advanced, so a listener that
     reads `ctx.agentsMd.revision` synchronously inside `cb` sees the new value. `dsh-task-tool`
     subscribes to this instead of polling `revision` at 1Hz. Revision and change-notification are
     owned by the same object (`lib/catalog.js`'s `createCatalog`), so they cannot drift apart.
   Each accessor lazily checks `ctx.agentPresets.resolve(presetId)` for every mounted preset and
   excludes a `broken` one, caching the result per `revision` so a burst of reads in the same
   revision costs one `resolve()` round-trip per preset, not one per read.
5. With `watch: true`, an `fs.watch` event on any root debounces 200ms (a save reliably emits more
   than one raw event) and the actual reconcile is serialised behind a `pending` promise chain —
   never run concurrently with another — before re-parsing, disposing the old preset registration,
   registering the new one, and bumping `revision` once. Watchers are opened `{persistent: false}`
   so a one-shot headless run can still exit.
6. An agent file with no `model:` key inherits `config.defaultModel`.
7. The rendered body is the frontmatter body plus, when `skills` is non-empty, one appended line:
   `Load these skills with your skill tool before anything else: <names>.` Nothing else is added —
   the harness identity, tool guidance and runtime context stay as the preset composition
   assembles them, which is why `complete` is `false`.

## Failure modes

- **A root does not exist.** Skipped silently. A fresh machine has no `~/.claude/agents`.
- **Unreadable file / bad YAML / missing `description`.** That agent is dropped with a warning
  naming the path. No throw — one bad file must not take the host down.
- **Duplicate `name` across roots.** Higher rank wins; the shadowing is logged once.
- **`name` present but ≠ the filename stem.** Rejected: two lookup paths that disagree is the
  bug class hardest to see from a session transcript.
- **Empty name.** The registry's entire preset-id grammar, read verbatim from
  `dsh-agent-preset-registry/lib/index.js`, is "non-empty after trim" (`if (!definition.id.trim())
  throw new Error('Preset id must not be empty')`) — no stricter character-class rule exists on
  this host. Applying exactly that rule at parse time turns a would-be registry throw into a
  rejection naming the actual file, instead of a generic registry warn with no file to point at.
- **Body over `maxPromptBytes`.** Rejected with a warning. Truncating a system prompt silently
  changes an agent's behaviour, which is worse than the agent being absent.
- **`register()` rejects or the preset activates with a diagnostic.** `register()` itself only
  rejects for a structurally bad `plugins` list or a duplicate id; an *activation* failure (e.g. a
  leaked service inside `inheritPlugins`) is instead swallowed into the registry's own roster
  (`register` doc: "activation failure remains visible in the roster") and is only visible through
  `resolve()`. This plugin never calls `resolve()` during `apply()` (see "Q1" below) — it is read
  lazily from `ctx.agentsMd.list()`/`get()`/`presetId()`, cached per `revision`, and a `broken`
  result is logged and excluded there so `dsh-task-tool` never advertises a `subagent_type` that
  cannot be mounted.
- **A preset row inside `inheritPlugins` publishes a service without an `isolate` realm.** The
  registry rejects that at mount — the constraint is stated verbatim in
  `~/.dsh/.agent-presets/example-preset/agent.cordis.yml` ("A service row here MUST sit inside a group
  carrying an `isolate` realm … `dsh-agent-presets` rejects that at mount"). Profile authors own
  it; this plugin surfaces the diagnostic unchanged rather than rewriting their rows.
- **`permissionMode` is recorded, not enforced.** The harness owns sandbox and approval through
  `dsh-permission-presets` / `dsh-user-approval`, which are host-plane and session-keyed, and a
  delegated child's approval policy is pinned to `never` by the delegation boundary
  (`dsh-subagent/lib/types/child-agent.d.ts`, `DelegatedPolicyOverrides.approvalPolicy`:
  "`'never'` whenever the approval capability is composed … a delegated child acts only within the
  sandbox scope fixed at delegation"). So `permissionMode: acceptEdits` on an agent file is
  already the effective behaviour for children, and `plan` / `bypassPermissions` cannot be
  honoured per-agent. In the gap list.
- **`maxTurns` is recorded, not enforced.** No per-child turn cap exists on
  `SubagentStartRequest`. `dsh-task-tool` approximates it; see DESIGN §2.

## What it explicitly does NOT do

- Does not register a tool, a command, or any agent-loop listener.
- Does not resolve `model` to a provider/model pair — `dsh-model-tiers` owns the model policy, so
  it lives in exactly one place.
- Does not decide which tools a child gets. It records `tools` / `disallowedTools` in the
  catalog; `dsh-task-tool` applies the mask.
- Does not read `~/.claude/settings.json`, `~/.claude.json`, skills, commands,
  `~/.claude/projects`, sessions or history.
- Does not write anything, anywhere. Does not touch `~/.dsh`.

## Test plan

`node:test`. `@deepseek-ai/dsh-agent-loop-testkit@0.2.1-rc.5` exists (named in
`dsh-compaction-basic/package.json` `devDependencies`) but is **not vendored** in the host
install tree, so it is unavailable until `pnpm add -D` resolves it from the registry — and it
would buy nothing here: this package has no loop interaction.

1. `parse`: every key above, valid and invalid; comma-string `tools`; missing `description`
   rejects; `name` mismatch rejects; body over cap rejects; unknown key lands in `extra`.
2. `roots`: project shadows user; `extraDirs` shadows project; missing root skipped; non-`.md`
   files and nested directories ignored.
3. `presetDefinition`: the built `plugins` array for a descriptor with and without `skills`; the
   `presetIdPrefix` applied; `inheritPlugins` appended after the persona row and never before it.
4. `catalog`: `revision` bumps on reload; a file that becomes unparseable keeps the last good
   descriptor; an empty tree yields an empty catalog and no throw.
5. `register` integration with a fake `ctx.agentPresets` that records calls and returns disposers:
   one `register` per agent; every disposer called on unload; a rejecting `register` keeps that
   agent out of `ctx.agentsMd`.
6. Against the real roster: point the loader at `~/.claude/agents` **read-only** and assert all
   15 agents parse with the model tier and tool list each file declares. The only test that reads
   outside the repo, and it only reads.

## Q7 — real-mount verification (resolved)

DESIGN.md §7 Q7 asked whether the `inheritPlugins` row set in
`profiles/cc/cordis.patch.yml` — copied by shape from
`~/.dsh/.agent-presets/example-preset/agent.cordis.yml` for a *different* preset — actually mounts, or
whether the registry's realm rule ("a service row here MUST sit inside a group carrying an
`isolate` realm … `dsh-agent-presets` rejects that at mount") rejects it. Answered empirically,
without editing `~/.dsh` or the `cc` profile: an overlay at `/tmp/agents-md.overlay.yml` with an
`insert:` row naming this plugin's `index.js` by absolute path, patched onto the `headless`
profile (`DSH_HOME=$HOME/.dsh dsh --profile headless --patch /tmp/agents-md.overlay.yml "reply
with the single word OK"`).

**Two infra gaps found before the row set could even be exercised** (neither is this package's
bug):

1. **Module resolution.** The workspace's root `node_modules` had not been installed (and was
   independently wiped mid-session by a concurrent install elsewhere in the shared workspace), so
   `import('@deepseek-ai/schemastery')` from `index.js` failed with `ERR_MODULE_NOT_FOUND`. Fixed
   by `pnpm install` at the workspace root — unrelated to the preset row set.
2. **The `headless` bundle does not carry the agent-preset stack at all.** `--dump-config` shows
   no `dsh-agent-preset-registry` row anywhere in `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`.
   Without it, `ctx.inject(['agentPresets'])` never resolves and this plugin's entry sits
   permanently `pending (waiting for service: agentPresets)` — visible verbatim in the host's own
   `dsh: warning: 1 entry did not activate` summary. The `cc` profile does not have this gap (it
   layers `@deepseek-ai/dsh-base` + `@deepseek-harness-tui/dsh-tui`, and `dsh-tui` is what gives
   a live `example-preset` preset its `agentPresets` service); `headless` is named this
   because it adds the registry itself — the minimal pair straight from
   `dsh-agent-preset-registry`'s own README ("Use this package"):

   ```yaml
   - id: agent-preset-registry
     name: '@deepseek-ai/dsh-agent-preset-registry'
     config:
       default: standard
   - id: preset-standard
     name: '@deepseek-ai/dsh-agent-preset'
     config:
       id: standard
       plugins: []
   ```

**With both gaps fixed, the `inheritPlugins` row set from `cordis.patch.yml` — unmodified —
mounted cleanly.** Two consecutive real runs produced the model's `OK` with no
`dsh: warning: ... did not activate` line and no `agent preset cc-<name>: ...` warning from the
registry's own `activate()` (the exact line it emits on a realm violation,
`dsh-agent-preset-registry/lib/index.js`: ``this.owner.logger.warn(`agent preset ${id}: ${broken}`)``).
That diagnostic channel is live and was seen to fire on unrelated failures earlier in the same
session (the import error above printed on it), so its silence here is a real negative, not an
unobserved one.

**Q1 correction.** Those two runs were made against an earlier version of this
plugin that called `ctx.agentPresets.resolve(id)` synchronously inside `registerOne()`, i.e.
during `apply()` itself. That is a documented deadlock risk (`resolve()` → `diagnostic()` can
await the Host loader settling, and `apply()` is one of the rows the loader is settling — see the
`ctx.agentPresets.resolve` seam row above) that happened not to fire in this run because no
`inheritPlugins` row was actually left `pending` at that moment, not because the pattern is safe.
Fixed per review: the broken-activation check is now read-time only (`ctx.agentsMd.list()` /
`get()` / `presetId()`, cached per `revision`; see "Behaviour" above), never called from inside
`apply()`. Re-run after the fix (same overlay, same two gaps already closed) — verbatim output
below.

**Re-run after the Q1 fix — clean, no hang, no warning:**

```
$ DSH_HOME=$HOME/.dsh dsh --profile headless --patch /tmp/agents-md.overlay.yml "reply with the single word OK"
[11/02/26 01:38:17] INFO     Processing request of type            server.py:733
                             ListToolsRequest
[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)
OK
```

No `dsh: warning: ... did not activate`, no registry `activate()` warning, no hang — `apply()`
never calls `resolve()`, so there is nothing left to wait on the Host loader settling during its
own activation.

**Accepted shape — identical to the draft, no changes required:**

```yaml
inheritPlugins:
  - name: '@deepseek-ai/dsh-tool-fs'
  - name: '@deepseek-ai/dsh-tool-fs-search'
  - name: '@deepseek-ai/dsh-tool-bash'
  - name: '@deepseek-ai/dsh-tool-todo'
  - name: '@deepseek-ai/dsh-tool-skill'
  - name: '@deepseek-ai/dsh-skill-filesystem'
  - name: '@deepseek-ai/dsh-tool-ask-user'
  - id: compaction
    name: 'cordis:group'
    group: true
    isolate:
      compaction: true
      toolResultPruner: true
    config:
      - name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
      - name: '@deepseek-ai/dsh-compaction-basic'
```

Reading why it was never going to hit the realm rule, now confirmed rather than inferred: every
row except the `compaction` group registers a tool into the host's `tools` registry and *provides
no service* (`grep -rn "extends Service" node_modules/@deepseek-ai/{dsh-tool-fs,dsh-tool-fs-search,
dsh-tool-bash,dsh-tool-todo,dsh-tool-skill,dsh-skill-filesystem,dsh-tool-ask-user}/lib/index.js`
— no match, same host install the rest of this spec cites). Only `dsh-compaction-basic`
(`extends CompactionEngine extends Service, super(ctx, "compaction")`) and
`dsh-compaction-tool-result-pruner` (`extends Service, super(ctx, "toolResultPruner")`) publish
anything, and both already sit inside the `compaction` group's `isolate: {compaction: true,
toolResultPruner: true}` — exactly the realm the rule requires. `dsh-persona` itself needs no
realm either: it is scope-only (shadows `deployment:persona-prefix` for the agent scope it mounts
in), not a service provider.

**Visibility note, not a defect:** `apply()` logs
``dsh-agents-md: registered ${n} preset(s): ${ids}`` via `ctx.logger.info`. It did not appear in
the headless run's stderr — the host's default logger threshold passes `warn` and more severe but
filters `info` (`@deepseek-ai/cordis` `lib/index.js:474`,
``(exporter.levels?.[name] ?? exporter.levels?.default ?? this.level ?? 1) < level``). Confirmed
present and firing by a unit test (`test/index.test.js`), not by a 5th real call — real
DeepSeek calls were capped at 4 and all 4 were spent reaching the clean runs above.

## Q4 — does a bare persona row survive the real `--profile cc` composition? RESOLVED

**Yes — the persona row was never the problem.** `lib/preset.js`'s bare `persona` row is correct
and is unchanged. `node --test` couldn't catch what was actually wrong — it only reproduced under
the real `dsh-tui` composition, not headless. A throwaway diagnostic plugin
(`/tmp/diagnose-presets.mjs`, `inject: ['agentPresets', 'agentsMd']`, calling
`ctx.agentPresets.list()` after settle) inserted via `dsh --profile cc --patch
/tmp/cc-quiet.overlay.yml --patch /tmp/cc-diagnose.overlay.yml` showed every preset failing the
same way:

```
DIAGNOSE: 0 ok, 17 broken, 17 total
DIAGNOSE broken: cc-data-engineer: ... (@deepseek-ai/dsh-persona): prompt section
  "deployment:persona-prefix" is already registered (for a per-agent override, register
  through that agent's `agent.ctx` instead)
... (identical for all 16 cc-* presets)
DIAGNOSE broken: cc-main: ... (@deepseek-ai/dsh-tool-fs): prompt section "tool:read" is already
  registered (for a per-agent override, register through that agent's `agent.ctx` instead)
  ... (@deepseek-ai/dsh-tool-fs-search): "tool:glob" ...
  ... (@deepseek-ai/dsh-tool-bash): "tool:bash" ...
  ... (@deepseek-ai/dsh-tool-todo): tool "todo_write" is already registered ...
  ... (@deepseek-ai/dsh-tool-skill): tool "skill" is already registered ...
  ... (@deepseek-ai/dsh-skill-filesystem): a skill provider named "filesystem" is already
  registered
  ... (@deepseek-ai/dsh-tool-ask-user): tool "ask_user_question" is already registered ...
```

Zero of 17 presets activated — all 16 of this plugin's own, **and `cc-main`, dsh-tui's own default
preset**, on the exact same "already registered" pattern for its own `inheritPlugins`-equivalent
rows (not persona — `cc-main` fails on `tool:read`/`tool:glob`/`tool:bash`/`todo_write`/`skill`/
the `filesystem` skill provider/`ask_user_question`, every row this plugin's own `inheritPlugins`
set also carries). That was real evidence the defect wasn't specific to this plugin's presets,
this plugin's persona row, or any particular row shape — but it pointed at the wrong layer, as
the actual root cause below shows.

**Tried and rejected: wrapping the persona row in an isolate group**
(`{name:'cordis:group', group:true, isolate:{systemPrompt:true}}`, `lib/preset.js`). Does not fix
the collision (re-tested, still "already registered" on every preset) and is the wrong tool for
this job regardless: `isolate:{systemPrompt:true}` gives the group a **private** `systemPrompt`
service realm. Since nothing inside that group provides one, `ctx.systemPrompt` would resolve to
`undefined` there — not fixed, just a different, silent failure mode where the persona override
never reaches the live Agent's actual prompt assembly at all.

**Actual root cause, found 2026-11-02 (full writeup: `docs/DESIGN.md` §7 Q7).** The `cc` profile's
own `package.json` declared `@deepseek-ai/dsh-base`, `dsh-mcp-client`,
`@deepseek-ai/dsh-agent-preset-registry` and `@deepseek-ai/dsh-agent-preset` — packages the `dsh`
install already ships — as direct dependencies. `dsh-app-boot`'s `routeLocalPackage` treats an
installed direct dependency as a deliberate local override and hands its resolution to plain Node
module resolution instead of the host's own loader, so a **second copy** of
`@deepseek-ai/dsh-scope` loaded. `dsh-scope` keys a mounted preset's scope on a module-level
`Symbol`; `scopeOf(ctx)` read back through the other copy returns `undefined`, so every preset's
rows — this plugin's and dsh-tui's own — mounted as global instead of scoped, which is exactly the
"already registered" collision, once per row. `headless` never reproduced this because that
profile has no `node_modules` of its own to shadow the host's copies with — which is also why the
isolation proof below (disabling every `@markishh` row still left dsh-tui's own preset broken)
correctly ruled out this plugin's code without finding the real cause: the duplicate module was
loaded by the *profile's* `package.json`, not by anything any preset-building plugin's row shape
controls.

**Fix (config only, in `profiles/cc/package.json`): remove those four packages as direct
dependencies.** After the fix, `ctx.agentPresets.list()` reports `16 ok, 0 broken` inside the real
`cc` TUI, and a real `Task` dispatch to the `tester` preset returned `PONG` in the TUI itself —
see `docs/DESIGN.md` §7 Q7 for the rest (the `cc-no-preset` row, the fork-provider evaluation
rejected as Plan B, and the latent third-copy risk in `mdcode`'s own `node_modules`).

The isolation proof from the dsh-task-tool integration round still stands as supporting evidence,
just not as the explanation: disabling every `@markishh` row (including this one) left dsh-tui's
own agent creation failing on this host the same way (see the `profiles/cc/cordis.patch.yml`
"KNOWN DSH-TUI BOOT FAILURE" comment for the four-boot isolation table) — consistent with a
duplicated module loaded once per profile boot, not with anything in this plugin's own rows.

For contrast, the exact same preset set activates cleanly under `headless` (Q7, above): `17 ok, 0
broken` there, `0 ok, 17 broken` here before the fix. The difference was never this plugin's code
or persona row — it was the profile's own dependency declarations.

## Actual size

~447 lines: `index.js` (orchestration, watcher debounce/serialisation — 114), `lib/parse.js`
(frontmatter parsing, CRLF-tolerant, 143), `lib/catalog.js` (roster building with
last-good-on-failure + the read-time catalog view, 110), `lib/preset.js` (`PresetDefinition`
building, 33), `lib/roots.js` (root resolution, 47).
