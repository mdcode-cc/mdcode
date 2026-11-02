# @mdcode-cc/dsh-commands-md

**Status: implemented (v1).** See `index.js` and `lib/*.js`; this file is still the spec it was built against.

Written against host `0.2.1-rc.5` (`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`).

## Purpose

Make a user's markdown slash commands work: `/intake <ask>`, `/build <item>`, `/ship <item>`,
`/trace <session>`, `/daily-review`. Each is a markdown file whose body is a prompt; typing the
command expands the body with the typed arguments and submits it as one turn.

## Why the first-party skill loader is not enough

`@deepseek-ai/dsh-skill` + `dsh-skill-filesystem` already discover `SKILL.md` files and expose
them to the model and to "human-facing commands" via `user-invocable`. But its frontmatter
contract is "required `name` and `description`, plus optional `whenToUse`, `metadata`,
`disable-model-invocation`, and `user-invocable`" (`dsh-skill-filesystem/README.md`, "Skill
format"). Real pipeline skills carry `argument-hint`, `arguments` and `allowed-tools`, and
their bodies substitute `$ARGUMENTS`. None of that is in the skill contract:

- a skill is **loaded as instructions**, not **submitted as a turn with arguments**;
- `$ARGUMENTS` is never substituted;
- the body reaches the model as a skill-tool result, which is a different position in history
  than a user prompt and composes differently with the pipeline's "you are the orchestrator"
  framing.

So this package registers them as real commands instead. `@dsh-cc/skill-loader` takes the other
road — it scans `.claude/commands/*.md` as a legacy skill root flagged `deprecated: true` — which
is a lossy shim we are not repeating.

## Inputs

Roots, scanned in precedence order (later shadows earlier, keyed by command name):

| rank | source | path | shape |
|---|---|---|---|
| 1 | user commands | `$HOME/.claude/commands/*.md` | flat files |
| 2 | user skills | `$HOME/.claude/skills/*/SKILL.md` | only when `user-invocable` is not `false` and `includeSkillDirs` is on |
| 3 | project commands | `<projectRoot>/.claude/commands/*.md` | flat files |
| 4 | project skills | `<projectRoot>/.claude/skills/*/SKILL.md` | as rank 2 |

Project roots are trusted, not sandboxed: starting `dsh` inside a hostile clone registers and
makes runnable whatever `.claude/commands/*.md` / `.claude/skills/*/SKILL.md` that clone ships,
exactly as if a trusted user had written them.

Command name = the frontmatter `name`, else the filename stem (or the directory name for a
`SKILL.md`). Only names matching the host's grammar are registered: "a lowercase name containing
letters, digits, `_` or `-`" (`dsh-commands/README.md`, "Command syntax").

Frontmatter keys honoured:

| key | effect |
|---|---|
| `name` | the command name; must match the file/directory stem when present |
| `description` | the command's discovery description (required by `ctx.commands.register`) |
| `argument-hint` | becomes `input.hint` |
| `arguments` | positional names; each maps to `$1`…`$9` and `$<name>` |
| `allowed-tools` | **recorded and reported, not enforced** — see failure modes |
| `disable-model-invocation` | `true` → registered as a command but excluded from any model-facing surface |
| `model` | recorded in the entry and reported in the command's result text; never resolved or applied — see Failure modes |
| `version`, `requires` | recorded in `extra`, unused |

A `~/.claude/commands/*.md` file with **no frontmatter at all** is legal (several real command
files are exactly that): the name comes from the filename and the description from the first
non-empty line, truncated to 200 characters.

Body substitution, Claude Code's rules:
`$ARGUMENTS` → the whole `rawInput`; `$1`…`$9` → whitespace-split positional tokens (the last one
absorbing the remainder when `arguments` declares fewer names than tokens); `$<name>` → the
positional named in `arguments`. An unsubstituted `$N` with no token becomes the empty string, and
the command reports which placeholders were empty in its result text.

## dsh seams used

| seam | kind | why | verified in |
|---|---|---|---|
| `ctx.commands.register(definition)` → `() => void` | service call | one registration per file | `dsh-commands/lib/types/index.d.ts:94`; `CommandDefinition` at `:38` (`name`, `description`, `input?`, `recordInput?`, `handler`) |
| `CommandInvocation {agent, rawInput, attachments}` | type | the handler's input | `dsh-commands/lib/types/index.d.ts:19` |
| `agent.followup(message)` | Agent method | submit the expanded body as its own turn | `dsh-agent/lib/types/runtime-types.d.ts:192` — "Queue an ordinary follow-up turn and wake the driver. The item becomes the sole ordinary message of its own turn." |
| `createUserMessage({content, source})` | from `@deepseek-ai/dsh-llm` | mint the `id` `followup` needs — a bare `{role, content, source}` literal has none, and `ReactLoopInbox` dedupes queued messages by `id` (throws `message "undefined" is already pending` the second time two commands queue in one turn) | `dsh-llm/lib/types/message.d.ts:144` (`UserMessage` requires `id`); `dsh-agent-loop/lib/index.js` inbox dedupe; usage mirrors `dsh-command-goal/lib/index.js` |
| `recordInput: false` | definition field | the expanded prompt is already in the log as a `user/message`; recording `rawInput` too would duplicate it | `dsh-commands/README.md`, "Registering a command" |
| `ctx.effect(…)` | cleanup | call every unregister on unload | cordis cleanup seam |
| `ctx.get('fs')` (optional), `ctx.logger` | filesystem, diagnostics | read and warn | `~/.dsh/.agent-presets/example-preset/instruction-hint.mjs` |

## Config schema (schemastery)

```ts
export const Config = z.object({
  userCommandDir: z.string().default('~/.claude/commands'),
  projectCommandDirName: z.string().default('.claude/commands'),
  includeSkillDirs: z.boolean().description('Also register user-invocable SKILL.md files as commands.').default(true),
  userSkillDir: z.string().default('~/.claude/skills'),
  projectSkillDirName: z.string().default('.claude/skills'),
  extraDirs: z.array(z.string()).default([]),
  watch: z.boolean().default(true),
  namePrefix: z.string().description('Prefix for every registered name, to avoid colliding with first-party commands.').default(''),
  maxBodyBytes: z.natural().description('Cap on one command body; a longer body is rejected, never truncated.').default(131072),
  skipNames: z.array(z.string()).description('Names never registered — first-party commands this must not shadow.').default(['compact', 'goal', 'feedback', 'permission']),
  stderrMirror: z.boolean().description('Also write registration/warning diagnostics straight to stderr (off by default — it would paint over a live TUI). A profile with no logger exporter (headless, ACP) should turn this on.').default(false),
})
```

`skipNames` defaults to the first-party command names found in the host install
(`dsh-command-compact`, `dsh-command-goal`, `dsh-command-feedback`, and `/permission` from
`dsh-permission-presets`), because "Registering the same name twice in one scope throws"
(`dsh-commands/README.md`).

## Behaviour

1. On `apply`, scan the roots, parse each file, resolve shadowing by name.
2. For each surviving entry, `ctx.commands.register({ name, description, input: { hint },
   recordInput: false, handler })` and park the returned unregister in `ctx.effect`.
3. The handler:
   - substitutes the body against `invocation.rawInput`,
   - calls `invocation.agent.followup({ role: 'user', content: [{type:'text', text: expanded}],
     source: { kind: 'commands-md', form: 'command', name } })`,
   - returns `{ kind: 'success', text: '/<name> → submitted (<n> chars)' }`.
   The `source` tag is what lets a future plugin (or a transcript reader) tell a command-expanded
   prompt from something a human typed, which the example-preset preset relies on for exactly this
   kind of filtering (`instruction-hint.mjs` checks `event.data?.source?.kind`).
4. With `watch: true`, a changed file unregisters and re-registers that one command. A file that
   becomes unparseable keeps the previous registration and logs a warning.
5. `disable-model-invocation: true` entries are still registered — they are *human*-invocable by
   definition; the flag only keeps them off model-facing surfaces, which this package does not
   create.

## Failure modes

- **Name collision with a first-party command.** `register` throws. The plugin catches per entry,
  logs a warning naming both the file and the colliding command, and skips it — one bad name
  must not abort the other fourteen. Pre-empted by `skipNames`.
- **Invalid name** (uppercase, dots, spaces). Skipped with a warning naming the grammar.
- **Missing description and an empty body.** Skipped — a command with no description cannot be
  registered.
- **Body over `maxBodyBytes`.** Skipped with a warning. Truncating a pipeline prompt is how you
  silently drop the half that says "stop at the approval gate".
- **`allowed-tools` cannot be enforced.** A real `/build` command declares
  `allowed-tools: Agent, SendMessage, Bash, …`. There is no per-command tool mask on
  `CommandDefinition`, and `ctx.tools.restrict(filter)`
  (`dsh-tools/lib/types/index.d.ts:645`) applies to an *agent*, not to one turn. Enforcing it
  would mean restricting the agent for the duration of a command-initiated turn and lifting it at
  `turn/end` — a stateful, racy mechanism that would silently mask tools for a concurrently
  running turn. **v1 records the list and prints it in the command's result text instead.** In
  the gap list.
- **`model` on a command.** Same shape of problem: the route is per-request, not per-turn, and
  changing it mid-session costs the prefix cache (`dsh-agent-loop/README.md`, "KV Cache effect").
  Recorded, not applied.
- **No agent / UI-less profile.** `ctx.commands` is absent in headless and ACP compositions
  ("UI-less demo spines and ACP automation provide no command adapter and do not need it",
  `dsh-commands/README.md`). The plugin declares `inject: ['commands']` so cordis simply does not
  activate it there. No degradation path, no warning spam.
- **Attachments.** Not declared, so the executor rejects any attachment before the handler runs
  (`dsh-commands/README.md`, "Attachments"). Screenshot-driven `/intake` therefore needs the path
  typed as text in v1. In the gap list.

## What it explicitly does NOT do

- Does not register anything model-facing. These are human commands.
- Does not read or write `~/.claude/settings.json`, `~/.claude.json`, or `~/.dsh`.
- Does not interpret the body. No `@path` imports, no `!`shell` ` substitution, no bash
  pre-execution — Claude Code's command format has those and v1 does not. In the gap list.
- Does not shadow a first-party command, ever.
- Does not register agent-scoped commands. The host supports them ("A command-producing plugin
  mounted beneath an agent's own context … registers an exact agent-scoped command, which shadows
  the global definition of the same name for that agent only"), and a per-preset command set may
  turn out to be wanted; v1 is global only.

## Test plan

`node:test` with a fake `ctx.commands` recording registrations and a fake `agent` recording
`followup` calls.

1. **Parse**: frontmatter and no-frontmatter files; `name` mismatch rejects; description derived
   from the first non-empty line and truncated; over-cap body rejects; `SKILL.md` directory form
   takes its name from the directory.
2. **Substitution**: `$ARGUMENTS`; `$1`…`$9` with fewer and more tokens than `arguments` declares;
   `$<name>`; an empty placeholder reported in the result text; a literal `$` not followed by a
   digit or name left alone.
3. **Shadowing and skips**: project shadows user; a `skipNames` entry never registers; a
   `register` that throws skips one entry and keeps the rest; `namePrefix` applied.
4. **Handler**: exactly one `followup` with the expanded text, `role: 'user'`, and the
   `commands-md` source tag; `recordInput: false` on every definition; the result is `success`.
5. **`user-invocable: false`** skills are not registered; `disable-model-invocation: true` ones
   are.
6. **Teardown**: every unregister called on unload.
7. Against the real files: point the loader at `~/.claude/commands` and `~/.claude/skills`
   **read-only** and assert the pipeline commands plus any other user commands register with
   the names and hints their files declare. Reads only.

## Estimated size

~300 lines: `index.js` (mount, registration, watcher — ~110), `parse.js` (~100),
`substitute.js` (~50), `roots.js` (~50).
