# mdcode

Six [cordis](https://github.com/cordiverse/cordis) plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) that port a Claude-Code-shaped terminal coding workflow onto DeepSeek models only. The
host already supplies the instructions-file chain, the skill loader, the subagent service and a
Claude Code hooks bridge; these packages fill the remaining gaps — a global rules file, a
named-agent roster with per-agent models and tool allowlists, a `Task` delegation tool, markdown
slash commands, a plugin log sink, and a `PermissionRequest`/`SessionEnd` approval relay — and a
`cc` profile wires the lot together.

## Requirements

- `dsh` 0.2.1-rc.5 (the harness this was built and tested against; re-check with
  `bash scripts/doctor.sh` on a different version)
- Node >= 22
- pnpm

## Packages

| package | tests | what it does |
|---|---|---|
| `@markishh/dsh-agents-md` | 66 | Parses `.claude/agents/*.md` and registers one real dsh agent preset per agent. |
| `@markishh/dsh-task-tool` | 71 | A `Task` tool dispatching to the registered presets, with a per-subagent context cap and a loop guard on repeated verification-only tool calls. |
| `@markishh/dsh-model-tiers` | 39 | The model alias table (`haiku`/`sonnet`/`opus`/`review` → DeepSeek model + reasoning effort), route logging, and a retry fallback for non-retryable error codes. |
| `@markishh/dsh-commands-md` | 67 | `/intake`, `/build`, `/ship`, `/trace`, `/daily-review` as real slash commands with `$ARGUMENTS` expansion. |
| `@markishh/dsh-plugin-log` | 7 | A file sink for `ctx.logger` output, since no shipped profile mounts one. |
| `@markishh/dsh-hooks-approval` | 42 | Runs `PermissionRequest` and `SessionEnd` hooks from `~/.claude/settings.json` — the two events the first-party Claude Code hooks bridge does not cover — including an approval-relay hook that can block on an external allow/deny decision. |

Workspace total: 292 tests (`pnpm test`, `node --test`, all passing).

## Install

Each package is a plain cordis plugin. Add it to a `dsh` profile:

```
dsh plugin --profile <name> add @markishh/dsh-agents-md
dsh plugin --profile <name> add @markishh/dsh-task-tool
dsh plugin --profile <name> add @markishh/dsh-model-tiers
dsh plugin --profile <name> add @markishh/dsh-commands-md
dsh plugin --profile <name> add @markishh/dsh-plugin-log
dsh plugin --profile <name> add @markishh/dsh-hooks-approval
```

During development, link the package instead of publishing it:

```
cd packages/dsh-agents-md && pnpm link --global
dsh plugin --profile <name> add @markishh/dsh-agents-md
```

## The `cc` profile

`profiles/cc/` is a worked example that wires all six plugins into one `dsh` profile alongside
the host's own agent-preset, skill and MCP-client plugins. It adds:

- one agent preset per `.claude/agents/*.md` file, each with its own model tier and tool mask
- a `Task` tool for delegating to those presets, with the context cap and loop guard enabled
- the DeepSeek model alias table (see each package's README for the exact mapping)
- the project's slash commands, loaded from `.claude/commands/*.md`
- a plugin-log file sink
- the `PermissionRequest`/`SessionEnd` approval relay, reading hook commands from
  `~/.claude/settings.json`

See `profiles/cc/cordis.patch.yml` and `profiles/cc/package.json` for the exact row configuration,
and `docs/DESIGN.md` for the design rationale behind each one.

## Verification status

All six plugins are unit-tested and each has been activated on a real `dsh --profile headless`
run. The `Task` tool's dispatch path has additionally been verified end to end inside a real `cc`
profile TUI session (a child agent picked up a delegated task and returned a result). The
`PermissionRequest`/`SessionEnd` approval relay has been verified with deny/allow fixture hooks on
real headless runs; a live round-trip through an external approval daemon has not yet been run.

A draft patch proposing `PermissionRequest`/`SessionEnd` support (plus tool arguments on approval
requests) for the first-party Claude Code hooks bridge lives in `docs/upstream/` as a contribution
candidate — written and test-verified against the harness, not yet submitted upstream.

## Known limitations

- Tool restrictions on a delegated agent are deny-on-call, not hidden from the model: a
  disallowed tool still appears in the catalog and is denied only when called.
- Agent frontmatter `permissionMode` and `maxTurns` are recorded and rendered into the child's
  prompt as advisory text, but are not enforced as hard caps — the host exposes no seam for
  either on a delegated child.
- A per-command tool mask (`allowed-tools` on a slash command) has no host equivalent and is
  recorded rather than enforced.
- Per-agent `permissionMode` beyond the default (`acceptEdits`-equivalent) cannot be set — a
  delegated child's approval policy is pinned at the delegation boundary.
- See `docs/DESIGN.md` §6 for the full list of Claude Code features consciously not ported in v1,
  and why.

## Contributing / upstream

`docs/upstream/` holds a draft patch against the DeepSeek Harness itself, adding
`PermissionRequest`/`SessionEnd` support to its Claude Code hooks bridge and carrying tool
arguments through approval requests. See `docs/upstream/PR-DRAFT.md` for the design, test
evidence and file list — it has not been submitted upstream yet.

## License

MIT. See `LICENSE`.
