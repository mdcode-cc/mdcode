/**
 * Parse a Claude Code settings.json `hooks` map for `PermissionRequest` and
 * `SessionEnd` only — the two events @deepseek-ai/dsh-hooks-claude-code does
 * not bridge. Same group/matcher shape as that bridge's own parser
 * (dsh-hooks-claude-code/lib/index.js `parseClaudeCodeConfig`): only
 * `{type:'command', command, timeout?}` hooks run; other types are skipped.
 *
 * `SessionEnd` has no matcher subject (like the bridge's `UserPromptSubmit`/
 * `Stop`), so its matcher is always discarded at parse time. `PermissionRequest`
 * fires per tool call, so its matcher is kept and matched against the tool
 * name at request time, same as `PreToolUse`.
 */

import { readFileSync } from 'node:fs'
import { matcherDiagnostic } from '@deepseek-ai/dsh-hook-protocol'

export const EVENTS = ['PermissionRequest', 'SessionEnd']
const NO_MATCHER_EVENTS = new Set(['SessionEnd'])

/** A plain (non-null, non-array) object, else undefined. */
function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/**
 * @param raw - the parsed settings.json (or a bare `{PermissionRequest:[...], SessionEnd:[...]}` map).
 * @returns `{config, skipped}` — `config[event]` is a MatcherGroup[] for runHook/selectHookGroups;
 *   `skipped` lists non-command hooks found, for the caller to warn about.
 */
export function parseApprovalHookConfig(raw) {
  const config = {}
  const skipped = []
  const root = asObject(raw)
  const hooksMap = root ? asObject(root.hooks) ?? root : undefined
  if (!hooksMap) return { config, skipped }

  for (const event of EVENTS) {
    const rawGroups = hooksMap[event]
    if (!Array.isArray(rawGroups)) continue
    const groups = []
    for (const rawGroup of rawGroups) {
      const group = asObject(rawGroup)
      if (!group || !Array.isArray(group.hooks)) continue
      const commands = []
      for (const rawHook of group.hooks) {
        const hook = asObject(rawHook)
        if (!hook) continue
        const type = typeof hook.type === 'string' ? hook.type : 'command'
        if (type !== 'command') {
          skipped.push({ event, type })
          continue
        }
        if (typeof hook.command !== 'string') continue
        commands.push({
          command: hook.command,
          ...(typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {}),
        })
      }
      if (commands.length === 0) continue
      const matcher = NO_MATCHER_EVENTS.has(event)
        ? undefined
        : typeof group.matcher === 'string' ? group.matcher : undefined
      const diagnostic = matcherDiagnostic(matcher, 'claude-code')
      if (diagnostic !== undefined) throw new SyntaxError(`${diagnostic} on event ${JSON.stringify(event)}`)
      groups.push({ ...(matcher !== undefined ? { matcher } : {}), hooks: commands })
    }
    if (groups.length > 0) config[event] = groups
  }
  return { config, skipped }
}

/** Read and parse `configPath` (a settings.json path). Throws on read/parse failure. */
export function loadApprovalHookConfig(configPath) {
  return parseApprovalHookConfig(JSON.parse(readFileSync(configPath, 'utf8')))
}
