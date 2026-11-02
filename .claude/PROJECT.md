# PROJECT.md — mdcode

Project facts file. Sections that do not apply say so and why; none is left as an example value.

Every factual line is a dated observation. The host (`dsh`) is a release candidate; re-check
`dsh --version` before trusting any version claim in this repo.

---

## Project

Six cordis plugins for the DeepSeek Harness (`dsh`) that port a Claude-Code-shaped terminal
coding workflow onto DeepSeek models only. pnpm workspace, Node >=22, plain JavaScript ESM (no
TypeScript, no build step — cordis loads `index.js` directly). Packages: `@mdcode-cc/dsh-agents-md`,
`@mdcode-cc/dsh-task-tool`, `@mdcode-cc/dsh-model-tiers`, `@mdcode-cc/dsh-commands-md`,
`@mdcode-cc/dsh-plugin-log`, `@mdcode-cc/dsh-hooks-approval`, plus the `cc` profile under
`profiles/cc/`.

Implemented and unit-tested; each plugin has been activated on a real headless `dsh` run. 292
tests pass across the six packages — see each `packages/*/README.md` "Status" line for the
real-run evidence per package. The `cc` profile's TUI boots clean and runs a real `Task`
dispatch end to end too. The spec is `docs/DESIGN.md`.

## End user

A developer at a terminal, running a coding workflow through `dsh` instead of Claude Code. The
end-user outcome is what they observe in a session: the right named agent picked up the right
lane, the slash command expanded, the child did not loop, the bill was not a surprise. Never
"the plugin loaded" and never a green test in isolation.

## Layout

| layer | paths |
|---|---|
| plugin code | `packages/*/index.js` and the modules `docs/DESIGN.md` names per package |
| composition | `profiles/cc/cordis.patch.yml`, `profiles/cc/package.json` |
| documentation | `docs/DESIGN.md`, `packages/*/README.md`, root `README.md` |
| tooling | `scripts/doctor.sh` |

No data layer, no API layer, no presentation layer. Negative-claim grep tree: `packages/
profiles/ scripts/ docs/`.

## Local stack

n/a — there is no stack. `pnpm install` at the root is the whole setup.

To exercise a plugin against a real host you mount it from a `dsh` profile, which requires
writing under the host's own config home — a hard stop here (below). So for now verification is
`pnpm test` plus `scripts/doctor.sh`.

Host API facts are read from the installed `dsh` package's own `node_modules/@deepseek-ai/`
tree. `dsh --version` resolves the exact host version in use; re-run it and
`bash scripts/doctor.sh` before trusting any version claim in this repo — the host is a release
candidate and has moved versions mid-session before.

## Test gates

1. `pnpm test` — `node --test` over `packages/*/test/*.test.js`. This is the gate. It **fails
   loudly when no test file exists** (`FAIL: no test files yet — a run with 0 tests is not a
   pass`), so a green run always means tests ran. Today it runs 292 tests across the six
   packages. A green `pnpm test` is real unit-test coverage of each plugin's logic, each also
   activated on a real headless `dsh` run (see `README.md` and each package's README).
2. `bash scripts/doctor.sh` — compares `dsh --version` to every `@deepseek-ai/*` pin in
   `profiles/*/package.json` and reports the plugin peer ranges. Exits 1 on profile drift.

No typecheck (plain JS). No build. No CI. Dependency advisories: `pnpm audit --prod` —
meaningless until there is a non-peer dependency.

## Smoke test

n/a for now. The end-user run is a `dsh` session, which needs a mounted profile, which needs a
write under the host's config home — see Hard stops.

## Deploy

n/a — nothing is deployed and nothing is published. Branch model: work on a branch; publishing
to npm is a hard stop.

## Prod access

n/a — there is no production.

## Restore

n/a — no data stores.

## Data layer

n/a — no database, no migrations, no persistence of any kind. The plugins read files and call
host services; they write nothing.

## Docs surfaces

- `docs/DESIGN.md` — the authoritative spec: per-plugin design, the asset-mapping table, the
  model-alias table, the hardening assignments, the gap list, the open questions. Keep it under
  ~600 lines; detail belongs in a package README.
- `packages/*/README.md` — the long-form spec for one plugin. The only place a config key is
  documented in full.
- `README.md` — one paragraph plus the honest status line.
- This file.

**Every seam, event name and config key in any of these must cite the README or `.d.ts` it was
read in, or be marked `UNVERIFIED`.** That rule is the reason the docs are worth anything, given
that the host is a release candidate moving underneath them.

## Work items

No work-item directory yet. Statuses:
`intake → refined → planned → building → testing → review → ready → deploying → measuring → done`,
plus `blocked` and `dropped`. Only the orchestrator flips a status line.

## Product rules

- **DeepSeek models only.** `deepseek-flash` for every tier, reasoning effort as the tier knob
  (`haiku`→`low`, `sonnet`→`high`, `opus`→`max`). A higher-tier review model is reachable only by
  explicitly naming its alias and is never wired to a frontmatter key. No code path may reach a
  non-DeepSeek provider.
- **No mock logic in a plugin, ever.** A stub throws `not implemented`. A seam that could not be
  verified is marked `UNVERIFIED` in the spec, not papered over with a plausible implementation.
- **A citation or a flag.** Every seam, event name and config key in the spec names the README
  or `.d.ts` it was read in, or carries `UNVERIFIED`.
- **The host is a release candidate.** Treat every API fact as dated. `doctor.sh` exists because
  the version has moved mid-session before.
- **Never declare a package the `dsh` install already ships as a profile's own `package.json`
  direct dependency.** Doing so routes it to plain Node resolution instead of the host's own
  loader, which can load a second copy of a module the host keys state on by module-level
  identity, and breaks preset scoping across the board. Full writeup: `docs/DESIGN.md` §7.

## Hard stops

| stop | detect |
|---|---|
| publishing to npm | `npm publish` / `pnpm publish`; any `"private": false` added to a `packages/*/package.json`; any change to a `publishConfig` block |
| any edits under the `dsh` home (the host's own config/profile directory) | any write outside this repo's own tree that touches the host's `cordis.patch.yml`, profile directories, or global rules file |
| any write into another repo | this repo documents design decisions about other local projects only by reference, never by writing into them |
| a git commit | the maintainer commits; agents do not |
| adding a non-DeepSeek model provider | any new LLM provider row that is not DeepSeek, or a `baseURL` off the DeepSeek API |

Detect-all: `git status --porcelain` must show nothing outside this repo, and
`git show --name-only <sha> | grep -E 'publishConfig|private'` must be empty.

## UI standards

n/a — no UI. Terminal output from a plugin follows the global log rule: `Login successful`, not
`Successfully authenticated user journey completed`. One line, no essays, no emoji.

## Brand tokens

n/a — this project has no product palette of its own.

## Governing docs

- `docs/DESIGN.md` — the spec. A plugin that does not match it is a defect in one of the two,
  and which one is a judgment call, not an agent's to decide silently.

## Vocabulary

**plugin** (a cordis module: `name` + `apply`), **row** (one entry in a `cordis.patch.yml`),
**profile** (a `dsh` front-end composition), **preset** (a named list of child plugins mounted
for one agent), **seam** (a host event or service a plugin attaches to), **tier** (`haiku`/
`sonnet`/`opus` as an effort level, never as a model name). Banned: "agent" without saying
whether it means a `dsh` `Agent` object, a named roster entry, or a `dsh` preset — say which.

## Layering caps

Any file 500 lines needs justification, 900 is the hard ceiling. The per-plugin estimates in
`docs/DESIGN.md` (190–520 lines, split across 3–5 modules) are inside the caps by construction;
a plugin whose `index.js` approaches 300 lines splits before it grows.

## Memory

Not created yet. Agents read memory; only the orchestrator writes it.
