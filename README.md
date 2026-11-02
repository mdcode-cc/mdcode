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

## Quick start on a new machine

1. **Install the harness.**

   ```
   npm install -g @deepseek-ai/dsh@$(cat scripts/host.version)
   ```

   Check it: `dsh --version` should print the same version as `scripts/host.version`.

2. **Export your DeepSeek API key.**

   ```
   export DEEPSEEK_API_KEY=sk-...
   ```

   No `$DSH_HOME/cordis.patch.yml` is required for this — confirmed on a scratch `DSH_HOME` with
   no home-level patch at all. The `cc` profile's own `llm-deepseek` row
   (`profiles/cc/cordis.patch.yml`) already sets `apiKeyEnv: DEEPSEEK_API_KEY`, and that's enough:
   the `headless` profile reads the launch environment directly, and `cc`'s credentials service
   (`dsh-credentials-local`) inherits the same env var when nothing is stored in
   `$DSH_HOME/.credentials.yaml`. A home-level patch only matters once you want a *stored*
   credential instead of an exported one.

3. **Install the six `@mdcode-cc/*` packages into the `cc` profile.**

   **Once `0.1.0` is on npm** (not yet published — this is the intended route, not the verified
   one):

   ```
   git clone https://github.com/mdcode-cc/mdcode && cd mdcode
   dsh plugin --profile cc add @mdcode-cc/dsh-agents-md @mdcode-cc/dsh-task-tool \
     @mdcode-cc/dsh-model-tiers @mdcode-cc/dsh-commands-md @mdcode-cc/dsh-plugin-log \
     @mdcode-cc/dsh-hooks-approval
   ```

   **Today**, before that publish, the verified route is a git checkout with `link:` deps:

   ```
   git clone https://github.com/mdcode-cc/mdcode && cd mdcode && pnpm install
   scripts/setup-profile.sh [DSH_HOME]
   ```

   `DSH_HOME` defaults to `~/.dsh`, same as `dsh` itself. The script copies
   `profiles/cc/cordis.patch.yml` into `$DSH_HOME/profiles/cc/`, writes a `package.json` there with
   the six `@mdcode-cc/*` deps as `link:` entries pointed at absolute paths into this checkout (a
   profile resolves `link:` relative to its own `package.json`, not the repo root), writes a
   `pnpm-workspace.yaml` that pre-approves the native deps' build scripts so `pnpm install` never
   stops for an interactive prompt, runs that install, and prints the launch commands below.
   Re-run it any time the checkout moves or the packages change — it's idempotent.

4. **Launch.**

   ```
   DSH_HOME=<home> dsh --profile cc                                       # TUI
   DSH_HOME=<home> dsh --profile headless "reply with the single word OK"  # one-shot
   ```

   `headless` doesn't need step 3 — it auto-initializes its own profile directory under
   `$DSH_HOME/profiles/headless` on first run and never touches the `cc` profile at all.

5. **What you'll see.**

   - In the `cc` TUI, `/` lists the commands loaded from `~/.claude/commands` and
     `~/.claude/skills`; agents from `~/.claude/agents` show up as `Task` subagent types.
   - `$DSH_HOME/logs/plugins.log` records plugin activity (registered commands, registered agent
     presets, warnings, errors) for both profiles.
   - Three Claude Code inputs carry over as-is: `~/.claude/agents`, `~/.claude/commands` +
     `~/.claude/skills`, and the hooks in `~/.claude/settings.json`.
   - `$DSH_HOME/AGENTS.md` is the global-rules file this harness actually reads — symlink your
     `~/.claude/CLAUDE.md` there (`ln -s ~/.claude/CLAUDE.md $DSH_HOME/AGENTS.md`) to carry it over
     too.

## Packages

| package | tests | what it does |
|---|---|---|
| `@mdcode-cc/dsh-agents-md` | 66 | Parses `.claude/agents/*.md` and registers one real dsh agent preset per agent. |
| `@mdcode-cc/dsh-task-tool` | 71 | A `Task` tool dispatching to the registered presets, with a per-subagent context cap and a loop guard on repeated verification-only tool calls. |
| `@mdcode-cc/dsh-model-tiers` | 39 | The model alias table (`haiku`/`sonnet`/`opus`/`review` → DeepSeek model + reasoning effort), route logging, and a retry fallback for non-retryable error codes. |
| `@mdcode-cc/dsh-commands-md` | 67 | `/intake`, `/build`, `/ship`, `/trace`, `/daily-review` as real slash commands with `$ARGUMENTS` expansion. |
| `@mdcode-cc/dsh-plugin-log` | 7 | A file sink for `ctx.logger` output, since no shipped profile mounts one. |
| `@mdcode-cc/dsh-hooks-approval` | 51 | Runs `PermissionRequest` and `SessionEnd` hooks from `~/.claude/settings.json` — the two events the first-party Claude Code hooks bridge does not cover — including an approval-relay hook that can block on an external allow/deny decision. |

Workspace total: 301 tests (`pnpm test`, `node --test`, all passing).

## Install

Each package is a plain cordis plugin. Add it to a `dsh` profile:

```
dsh plugin --profile <name> add @mdcode-cc/dsh-agents-md
dsh plugin --profile <name> add @mdcode-cc/dsh-task-tool
dsh plugin --profile <name> add @mdcode-cc/dsh-model-tiers
dsh plugin --profile <name> add @mdcode-cc/dsh-commands-md
dsh plugin --profile <name> add @mdcode-cc/dsh-plugin-log
dsh plugin --profile <name> add @mdcode-cc/dsh-hooks-approval
```

During development, link the package instead of publishing it:

```
cd packages/dsh-agents-md && pnpm link --global
dsh plugin --profile <name> add @mdcode-cc/dsh-agents-md
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

## CI and host upgrades

CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile` and `pnpm test` on every
push and PR to `main`, plus a non-blocking check for a newer host release. A daily scheduled
workflow (`.github/workflows/host-bump.yml`, also triggerable by hand) runs
`node scripts/bump-host.mjs --latest`, reinstalls and re-runs the tests, and — only if any pin
changed — opens a PR with the result; it never merges anything itself, and a host bump that
breaks the tests still gets a PR, titled to say so, with the failing test output attached. PR
creation by Actions requires the repo setting "Allow GitHub Actions to create pull requests"
(Settings → Actions → General); do the same bump locally with
`node scripts/bump-host.mjs --latest && pnpm install && pnpm test`.

## Contributing / upstream

`docs/upstream/` holds a draft patch against the DeepSeek Harness itself, adding
`PermissionRequest`/`SessionEnd` support to its Claude Code hooks bridge and carrying tool
arguments through approval requests. See `docs/upstream/PR-DRAFT.md` for the design, test
evidence and file list — it has not been submitted upstream yet.

## License

MIT. See `LICENSE`.
