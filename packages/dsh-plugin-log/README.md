# @mdcode-cc/dsh-plugin-log

A minimal cordis plugin: appends every `ctx.logger` message to a plain-text
file, via `ctx.logger.exporter()` — the same API `dsh-app-boot` itself uses
internally (`dsh-app-boot/lib/index.js`, `diagnostics.logger.exporter({...})`).

## Config

| key | default | notes |
| --- | --- | --- |
| `path` | `$DSH_HOME/logs/plugins.log` | `$DSH_HOME` is substituted at `apply()` time (env var, no real `ctx.homePaths` service exists on the host — see comment in `index.js`). |
| `level` | `info` | Minimum severity exported, by cordis's own `LoggerLevel` enum (ERROR 0, INFO 1, WARN 2, DEBUG 3 — WARN ranks ABOVE INFO). `info` and `warn` are the same threshold (error+info+warn, no debug): cordis's gate is a ceiling on `message.level`, so no threshold admits WARN (2) without also admitting INFO (1). See the `LEVELS` comment in `index.js`. |
| `names` | `[]` (everything) | Array of logger-name prefixes to include, e.g. `['dsh-']`. |

## Disposal

`ctx.logger.exporter()` registers through `ctx.effect()` scoped to the
calling plugin's own fiber (see `cordis/src/logger.ts`). This plugin does
not need its own `ctx.effect()` wrapper — unloading it already removes the
exporter.

## Honesty notes

- `ctx.homePaths` does not exist on the real host (`dsh 0.2.1-rc.5`,
  `@deepseek-ai/cordis@4.0.5`). Proved against a real `dsh --profile
  headless --patch ...` boot: cordis's ctx proxy throws synchronously on an
  unresolved property read — `Error: cannot get property "homePaths"
  without inject` — so `ctx.homePaths?.x` crashes `apply()`, it does not
  come back `undefined`. `@deepseek-ai/dsh-home-paths` exists but is a
  plain function import, not a ctx service, and not worth adding as a
  dependency this plugin otherwise has no use for. `$DSH_HOME` env + OS
  home fallback is the one real, working path — that's what `index.js`
  actually does now.
- Tests use a small fake `ctx` (same pattern as `dsh-commands-md`'s
  `test/apply.test.js`), not a full `@deepseek-ai/cordis` `Context` — this
  plugin has no other side effects worth booting a real context for. Its
  fake exporter gate replicates the real one (`cordis/src/logger.ts:155-156`)
  so a level-mapping regression shows up in the test suite, not just live.
- First version of `LEVELS` mapped `info` to a ceiling of 1, which silently
  dropped every `warn` message (level 2 > ceiling 1) — found by review, not
  by the original tests (the fake ctx didn't gate by level at all). Fixed to
  `{error:0, info:2, warn:2, debug:3}`; see `test/plugin-log.test.js`'s
  warn/debug admission tests.
