/**
 * @markishh/dsh-plugin-log — a minimal cordis logger exporter: appends every
 * `ctx.logger` message (optionally filtered by logger-name prefix) to a
 * plain-text file, formatted with cordis's own `Logger.format()`. Built
 * directly on `ctx.logger.exporter()`; see ./README.md.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import { Logger } from '@deepseek-ai/cordis'

export const name = 'dsh-plugin-log'

// The exporter gate is a CEILING, not a floor: cordis skips a message when
// `targetLevel < message.level` (cordis/src/logger.ts:155-156), where
// LoggerLevel is ERROR 0, INFO 1, WARN 2, DEBUG 3 — WARN ranks ABOVE INFO.
// So a naive {error:0, info:1, warn:2, debug:3} threshold table, with
// level: 'info' (ceiling 1), would silently DROP every warn (2 > 1) — the
// exact failure mode both @markishh plugins hit (they report at warn).
// cordis's ordering also cannot express "warn without info": any ceiling
// that admits WARN (>=2) also admits INFO (1 <= 2). So 'info' and 'warn'
// collapse to the same ceiling (2) — error+info+warn, debug excluded —
// and that collapse is intentional, not a bug.
const LEVELS = { error: 0, info: 2, warn: 2, debug: 3 }

export const Config = Schema.object({
  path: Schema.string().default('$DSH_HOME/logs/plugins.log')
    .description('Log file path. The literal `$DSH_HOME` is substituted at apply time.'),
  level: Schema.union(['error', 'warn', 'info', 'debug']).default('info')
    .description('Minimum severity exported. \'info\' and \'warn\' are equivalent (both admit error+info+warn, exclude debug) — cordis\'s own LoggerLevel ordering cannot express "warn without info".'),
  names: Schema.array(Schema.string())
    .description('Logger-name prefixes to include, e.g. ["dsh-"]. Empty (default) logs every name.'),
})

// `ctx.homePaths` is not a real cordis service (checked against a real host:
// @deepseek-ai/dsh-home-paths is a plain function import, not a ctx
// service). Worse than just "absent" — cordis's ctx proxy THROWS synchronously
// on any property read it can't resolve through the inject graph
// ("cannot get property \"homePaths\" without inject", proved against a real
// `dsh --profile headless` boot), so even `ctx.homePaths?.x` crashes apply().
// `DSH_HOME` is the one real, working source.
function resolveHome() {
  return process.env.DSH_HOME ?? `${homedir()}/.dsh`
}

export function apply(ctx, config) {
  const path = config.path.replace('$DSH_HOME', resolveHome())
  mkdirSync(dirname(path), { recursive: true })
  // `ctx.logger.exporter()` already registers through `ctx.effect()` scoped
  // to this plugin's own fiber (cordis/src/logger.ts) — it disposes itself
  // when this plugin unloads, no extra effect needed.
  ctx.logger.exporter({
    levels: { default: LEVELS[config.level] ?? LEVELS.info },
    export(message) {
      if (config.names?.length && !config.names.some(prefix => message.name.startsWith(prefix))) return
      const line = Logger.format(this, message)
      const stamp = new Date(message.ts).toISOString()
      appendFileSync(path, `[${stamp}] ${message.type} ${message.name}: ${line}\n`)
    },
  })
}

export default { name, Config, apply }
