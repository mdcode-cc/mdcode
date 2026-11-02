/**
 * Build a dsh-agent-preset-registry `PresetDefinition` from one parsed agent
 * descriptor. The persona row carries the body; `inheritPlugins` is appended
 * after it, never before — see README "Behaviour".
 *
 * KNOWN ISSUE, not fixed here (see README "Q4" for the full real-TUI
 * evidence): under the real `--profile cc` composition, EVERY preset here —
 * all 16, and dsh-tui's own default preset too — fails to activate with
 * "prompt section ... is already registered" (persona) and the matching
 * "tool:<name> ... already registered" for every `inheritPlugins` row. This
 * reproduces identically with `inheritPlugins: []`, with all four
 * `@mdcode-cc` rows disabled, and is NOT specific to the bare persona row
 * shape: wrapping it in `{name:'cordis:group', group:true,
 * isolate:{systemPrompt:true}}` was tried and reverted — it does not fix
 * the collision (still "already registered" on re-test) and risks
 * isolating the persona into a realm the live Agent's own systemPrompt
 * lookup never reads from, which would make it silently inert instead of
 * loud. The actual defect is in how `dsh-tui`'s `AgentPresetRegistry`
 * mount scope interacts with `@deepseek-ai/dsh-scope`'s `ScopedLayers` on
 * this host (`0.2.1-rc.5` + `@deepseek-harness-tui/dsh-tui@0.18.0`) —
 * outside what a plugin row shape can route around.
 */

const SKILLS_LINE_PREFIX = 'Load these skills with your skill tool before anything else: '

/** The agent body plus one appended skills line, when `skills` is non-empty. */
export function renderPersonaPrefix(descriptor) {
  if (descriptor.skills.length === 0) return descriptor.body
  return `${descriptor.body}\n\n${SKILLS_LINE_PREFIX}${descriptor.skills.join(', ')}.`
}

/**
 * @param descriptor parsed agent descriptor (see parse.js)
 * @param config plugin config: `presetIdPrefix`, `inheritPlugins`
 * @returns a `PresetDefinition` for `ctx.agentPresets.register()`
 */
export function buildPresetDefinition(descriptor, config) {
  return {
    id: `${config.presetIdPrefix}${descriptor.name}`,
    name: descriptor.name,
    description: descriptor.description,
    plugins: [
      {
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: renderPersonaPrefix(descriptor), complete: false, includeRuntimeContext: true },
      },
      ...config.inheritPlugins,
    ],
  }
}
