/**
 * @mdcode-cc/dsh-commands-md — registers Claude-Code-style markdown slash
 * commands (`~/.claude/commands/*.md`, `~/.claude/skills/<name>/SKILL.md`, and
 * their project equivalents) as real `ctx.commands` entries.
 *
 * Spec: ./README.md and ../../docs/DESIGN.md §4.4.
 */

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { collectEntries, reconcile } from './lib/registry.js'
import { substitute } from './lib/substitute.js'
import { startWatch } from './lib/watch.js'

export const name = 'dsh-commands-md'

// No `ctx.commands` service (e.g. a stripped-down composition) => cordis
// simply never activates this plugin. No degradation path, no warning spam.
export const inject = ['commands']

export const Config = Schema.object({
  userCommandDir: Schema.string().default('~/.claude/commands'),
  projectCommandDirName: Schema.string().default('.claude/commands'),
  includeSkillDirs: Schema.boolean().default(true)
    .description('Also register user-invocable SKILL.md files as commands.'),
  userSkillDir: Schema.string().default('~/.claude/skills'),
  projectSkillDirName: Schema.string().default('.claude/skills'),
  extraDirs: Schema.array(Schema.string()).default([]),
  watch: Schema.boolean().default(true),
  namePrefix: Schema.string().default('')
    .description('Prefix for every registered name, to avoid colliding with first-party commands.'),
  maxBodyBytes: Schema.natural().default(131072)
    .description('Cap on one command body; a longer body is rejected, never truncated.'),
  skipNames: Schema.array(Schema.string()).default(['compact', 'goal', 'feedback', 'permission'])
    .description('Names never registered — first-party commands this must not shadow.'),
  stderrMirror: Schema.boolean().default(false)
    .description('Also write registration/warning diagnostics straight to stderr. Off by default — it paints over a live TUI; a profile with no logger exporter (headless, ACP) should turn it on instead of relying on a console sink.'),
})

/** One `ctx.commands.register()` definition for a parsed command/skill entry. */
export function buildDefinition(commandName, entry) {
  return {
    name: commandName,
    description: entry.description,
    ...(entry.hint === undefined ? {} : { input: { hint: entry.hint } }),
    // The expanded prompt is already in the log as the `agent.followup` user
    // message; recording `rawInput` too would duplicate it.
    recordInput: false,
    handler({ agent, rawInput }) {
      const { text, empty } = substitute(entry.body, rawInput, entry.argNames)
      // createUserMessage mints a real `id` — a plain object literal has none,
      // and ReactLoopInbox dedupes queued messages by `id`, throwing
      // `message "undefined" is already pending` the second time any two
      // commands queue in the same turn (dsh-agent-loop/lib/index.js).
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'commands-md', form: 'command', name: commandName },
      }))
      const notes = []
      if (entry.allowedTools.length > 0) notes.push(`allowed-tools (recorded, not enforced): ${entry.allowedTools.join(', ')}`)
      if (entry.model !== undefined) notes.push(`model (recorded, not applied): ${entry.model}`)
      if (empty.length > 0) notes.push(`empty: ${empty.join(', ')}`)
      const suffix = notes.length > 0 ? ` (${notes.join('; ')})` : ''
      return { kind: 'success', text: `/${commandName} -> submitted (${text.length} chars)${suffix}` }
    },
  }
}

export function apply(ctx, config) {
  const cwd = process.cwd()
  // `ctx.logger` has no console exporter wired into the headless/ACP
  // profiles by default (verified against a real boot: nothing it emits
  // reaches stdout/stderr there). Mirroring to stderr unconditionally would
  // paint over a live TUI, so it's opt-in via `stderrMirror` — a profile
  // with no logger exporter should set it instead of relying on a console
  // sink that doesn't exist there.
  const warn = message => {
    const text = `dsh-commands-md: ${message}`
    ctx.logger.warn(text)
    if (config.stderrMirror) console.error(text)
  }
  let live = new Map()

  const rescan = () => {
    const { entries, attempted } = collectEntries(config, cwd, warn)
    const result = reconcile({
      config,
      live,
      entries,
      attempted,
      register: (commandName, entry) => ctx.commands.register(buildDefinition(commandName, entry)),
      warn,
    })
    live = result.live
    // Kept on purpose: the one way to prove registration in a profile with
    // no interactive command surface (headless, ACP) to actually type `/x` in.
    const summary = `dsh-commands-md: registered ${result.registeredNames.length} command(s): ${result.registeredNames.join(', ')}`
    ctx.logger.info(summary)
    if (config.stderrMirror) console.error(summary)
    return result.registeredNames
  }

  rescan()

  const stopWatch = config.watch ? startWatch(config, cwd, rescan) : undefined

  ctx.effect(() => () => {
    stopWatch?.()
    for (const record of live.values()) record.unregister()
    live.clear()
  })
}

export default { name, inject, Config, apply }
