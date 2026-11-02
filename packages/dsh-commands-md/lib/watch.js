/**
 * `node:fs.watch` wiring — no chokidar, no extra dependency. Watches every
 * configured root directory (recursively for skill roots, since a SKILL.md
 * edit happens one level below the root; flat for command roots) and calls
 * `onChange` once per debounce window, however many files moved. A missing
 * root is skipped; it may be created later and this plugin does not need to
 * notice that itself (the next restart, or a sibling watched root's own
 * event, picks it up). `recursive: true` is darwin/win32-supported, Linux
 * is the documented gap in Node's own `fs.watch` — same try/catch fallback.
 */

import { watch } from 'node:fs'
import { listWatchTargets } from './roots.js'

const DEFAULT_DEBOUNCE_MS = 200

/** @returns a disposer that stops every watcher and cancels a pending debounce. */
export function startWatch(config, cwd, onChange, debounceMs = DEFAULT_DEBOUNCE_MS) {
  let timer
  const trigger = () => {
    clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  }

  const watchers = []
  for (const { dir, recursive } of listWatchTargets(config, cwd)) {
    try {
      watchers.push(watch(dir, { persistent: false, recursive }, trigger))
    } catch {
      // Root doesn't exist, or `recursive: true` isn't supported on this
      // platform (e.g. Linux) — skip it rather than crash the plugin.
    }
  }

  return () => {
    clearTimeout(timer)
    for (const watcher of watchers) watcher.close()
  }
}
