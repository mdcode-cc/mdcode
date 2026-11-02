/**
 * Claude-Code tool name -> dsh tool name(s), verified by grepping each
 * tool package's `defineTool({ name: ... })` call on this host
 * (`0.2.1-rc.5`, `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/
 * node_modules/@deepseek-ai/`):
 *
 *   dsh-tool-fs            -> read, write, edit, read_image
 *   dsh-tool-fs-search     -> glob, grep
 *   dsh-tool-bash          -> bash (dsh-tool-bash-persistent registers the
 *                             same name; exactly one of the two is enabled
 *                             per platform, never both)
 *   dsh-tool-skill         -> skill
 *   dsh-tool-web           -> web_search, web_fetch
 *   dsh-tool-todo          -> todo_write (handles create/update/list in one
 *                             tool, unlike Claude Code's three separate ones)
 *   dsh-tool-ask-user      -> ask_user_question
 *   dsh-tool-jobs          -> job_output, job_list, job_kill
 *   dsh-plan-mode          -> exit_plan_mode
 *   @markishh/dsh-task-tool -> `toolName` config, the `cc` profile sets it
 *                              to `Task` — an identity mapping on this host
 *
 * `NotebookEdit` and `Agent` have no dedicated dsh counterpart in this row
 * set; mapped to the closest existing tool (noted per entry below) rather
 * than left unmapped, which would silently drop the whole tool from a
 * child's effective allowlist.
 *
 * ALLOW-DIRECTION CAVEAT: this table is many-to-few by design (CC splits
 * tools dsh does not), which means a mapping can be WIDER than the CC name
 * it came from. `NotebookEdit -> edit` is the sharpest case: an agent file
 * that lists only `NotebookEdit` — intending notebook-only editing — ends up
 * with `dshTools` containing the SAME `edit` tool a plain `Edit` entry would
 * grant, with no notebook-specific restriction on this host. The same is
 * true of `TaskCreate`/`TaskUpdate`/`TaskList` all widening to `todo_write`.
 * This only ever widens an allowlist, never a denylist (a `disallowedTools`
 * entry blocks the same, wider, dsh name) — but it means `tools:
 * [NotebookEdit]` is not actually narrower than `tools: [Edit]` on this
 * host. Call this out to anyone writing a new agent file expecting
 * per-surface tool restriction dsh does not have.
 */
export const CC_TO_DSH_TOOL_NAMES = {
  Read: ['read', 'read_image'],
  Edit: ['edit'],
  Write: ['write'],
  Grep: ['grep'],
  Glob: ['glob'],
  Bash: ['bash'],
  Skill: ['skill'],
  WebFetch: ['web_fetch'],
  WebSearch: ['web_search'],
  TodoWrite: ['todo_write'],
  Task: ['Task'],
  Agent: ['Task'], // no tool literally named "Agent" on this host; same delegation surface as Task.
  NotebookEdit: ['edit'], // no notebook-specific tool in this row set; closest analog — see the allow-direction caveat above.
  // Claude Code's three-tool task tracker folds into dsh's one todo_write tool.
  TaskCreate: ['todo_write'],
  TaskUpdate: ['todo_write'],
  TaskList: ['todo_write'],
  AskUserQuestion: ['ask_user_question'],
  BashOutput: ['job_output'],
  KillShell: ['job_kill'],
  ExitPlanMode: ['exit_plan_mode'],
}

/**
 * CC tool names with genuinely no dsh counterpart on this host — checked,
 * not assumed. `SlashCommand` lets the model invoke a slash command
 * directly; `dsh-commands` registers no `defineTool()` call at all (grepped
 * `dsh-commands/lib/index.js` — commands are invoked by the user, never by
 * the model, on this host). Listed names are dropped from `dshTools`
 * silently — no `warnUnknown` call — because an unmapped-but-known name is
 * not the same failure as a typo or a name this table has never heard of.
 */
export const NO_DSH_EQUIVALENT = new Set(['SlashCommand'])

/**
 * Map a list of Claude-Code tool names to the dsh tool names they resolve
 * to, deduplicated, in first-seen order.
 * @param ccNames frontmatter `tools`/`disallowedTools` list
 * @param warnUnknown `(name) => void` — called once per name neither this
 *   table nor `NO_DSH_EQUIVALENT` covers; the name is dropped, not guessed at.
 * @returns dsh tool names
 */
export function toDshToolNames(ccNames, warnUnknown) {
  const out = []
  const seen = new Set()
  for (const name of ccNames) {
    const mapped = CC_TO_DSH_TOOL_NAMES[name]
    if (mapped === undefined) {
      if (!NO_DSH_EQUIVALENT.has(name)) warnUnknown(name)
      continue
    }
    for (const dshName of mapped) {
      if (!seen.has(dshName)) {
        seen.add(dshName)
        out.push(dshName)
      }
    }
  }
  return out
}
