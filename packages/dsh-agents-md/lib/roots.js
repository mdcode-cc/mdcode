/**
 * Root resolution: user dir -> project dir -> extraDirs, later shadows earlier.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function expandHome(p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** Nearest ancestor of `startDir` containing `.git`, else `startDir`. */
export function findProjectRoot(startDir) {
  let dir = path.resolve(startDir)
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(startDir)
    dir = parent
  }
}

/** Ordered root list, rank 1 (user) first, extraDirs last — later wins on name collision. */
export function resolveRoots(config, cwd = process.cwd()) {
  const userDir = expandHome(config.userDir)
  const projectRoot = findProjectRoot(cwd)
  const projectDir = path.join(projectRoot, config.projectDirName)
  const extraDirs = (config.extraDirs ?? []).map(expandHome)
  return [userDir, projectDir, ...extraDirs]
}

/**
 * Top-level `*.md` files in `dir`, sorted; `[]` when the root is missing or
 * unreadable. `entry.isFile()` under `withFileTypes` uses `lstat` semantics
 * and is false for a symlink, so a symlinked agent file (a common way to
 * share one across roots) would otherwise be silently skipped — accepted
 * here too, then confirmed a regular file by following the link with
 * `statSync`. A broken symlink or one pointing at a directory is dropped,
 * not thrown on.
 */
export function listAgentFiles(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    const filePath = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      let target
      try {
        target = fs.statSync(filePath)
      } catch {
        continue // broken symlink
      }
      if (!target.isFile()) continue
    }
    files.push(filePath)
  }
  return files.sort()
}
