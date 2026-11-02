/**
 * @mdcode-cc/dsh-changes-panel — a dsh-TUI side-panel (Ctrl+B column)
 * showing the session cwd's git working tree: staged/unstaged/untracked
 * files with per-file +added/-deleted counts. Data comes straight from
 * `git` (see lib/git-status.js), never `ctx.workspaceChanges` — that
 * service is not mounted in the `cc` profile and has no staged/unstaged
 * split. Full spec: ./README.md.
 */

import Schema from '@deepseek-ai/schemastery'
import { collect } from './lib/git-status.js'
import { createWatcher } from './lib/watcher.js'
import { createChangesPanel } from './lib/panel.js'

export const name = 'dsh-changes-panel'

export const Config = Schema.object({
  refreshMs: Schema.natural().min(250).max(60000).default(2000)
    .description('Poll interval (ms) while the panel is the active one.'),
  maxFiles: Schema.natural().min(1).max(2000).default(200)
    .description('Cap on rendered rows across staged+unstaged+untracked; the rest show as "+N more".'),
  untracked: Schema.boolean().default(true)
    .description('Include untracked files (git --untracked-files=all).'),
  timeoutMs: Schema.natural().min(100).max(30000).default(2000)
    .description('Per-git-invocation timeout (ms).'),
})

// cordis's ctx proxy THROWS synchronously on any property read it can't
// resolve through the inject graph — even `ctx.tuiPanels?.x` crashes
// apply(). Never probe by property read; use ctx.inject, guarded, exactly
// as dsh-model-tiers/index.js:76-82 does. No TUI composed -> the callback
// never fires -> this plugin is a no-op, by design.
export function apply(ctx, config) {
  let watcher
  // Teardown registered FIRST, before anything that can throw, per
  // dsh-task-tool/index.js:62-70.
  ctx.effect(() => () => {
    watcher?.dispose()
  })

  if (typeof ctx.inject !== 'function') return

  ctx.inject(['tuiPanels'], injectedCtx => {
    // No refreshMs here: createWatcher has no polling knob of its own —
    // the panel component drives cadence via ui.useAnimationTime and
    // calls watcher.refresh() itself. config.refreshMs is read by the
    // component (via `config`, passed below), not by the watcher.
    watcher = createWatcher({
      collect,
      cwd: process.cwd(),
      timeoutMs: config.timeoutMs,
      untracked: config.untracked,
      maxFiles: config.maxFiles,
    })

    const component = createChangesPanel({ watcher, config })

    const dispose = injectedCtx.tuiPanels.register({
      apiVersion: 1,
      id: 'changes',
      title: 'Changes',
      icon: '±',
      order: 37,
      minColumns: 28,
      component,
    })
    if (dispose) ctx.effect(() => dispose)
  })
}

export default { name, Config, apply }
