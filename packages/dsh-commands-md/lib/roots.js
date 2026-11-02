/**
 * Root resolution and candidate-file discovery.
 *
 * Precedence order (later shadows earlier, by command name): user commands,
 * user skills, project commands, project skills, extraDirs (flat command
 * dirs, scanned last — the most specific override wins).
 *
 * Any dotfile/dotdir (including `.retired-*`) is skipped by convention, not
 * just the ones the spec names — matching `dsh-skill-filesystem`'s own
 * "skip the hidden/special children" behaviour.
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Nearest ancestor of `cwd` containing `.git`; `cwd` itself when there is none. */
export function findProjectRoot(cwd) {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}

function listDir(dir) {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Flat `*.md` files directly in `dir` (commands root shape). */
export function listCommandFiles(dir) {
  return listDir(dir)
    .filter(entry => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.md'))
    .map(entry => ({ file: join(dir, entry.name), stem: basename(entry.name, '.md') }))
    .sort((a, b) => a.stem.localeCompare(b.stem))
}

/** `<dir>/<name>/SKILL.md` one level deep (skills root shape). */
export function listSkillFiles(dir) {
  const out = []
  for (const entry of listDir(dir)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skillFile = join(dir, entry.name, 'SKILL.md')
    // lstatSync, not statSync: a symlinked SKILL.md is not followed — a
    // hostile project .claude/skills directory cannot point a skill file
    // at an arbitrary path outside the project.
    if (existsSync(skillFile) && lstatSync(skillFile).isFile()) out.push({ file: skillFile, stem: entry.name })
  }
  return out.sort((a, b) => a.stem.localeCompare(b.stem))
}

/** Resolve the configured roots' absolute directories for this `cwd`. */
export function resolveDirs(config, cwd) {
  const projectRoot = findProjectRoot(cwd)
  return {
    userCommandDir: expandHome(config.userCommandDir),
    userSkillDir: expandHome(config.userSkillDir),
    projectCommandDir: join(projectRoot, config.projectCommandDirName),
    projectSkillDir: join(projectRoot, config.projectSkillDirName),
    extraDirs: config.extraDirs.map(expandHome),
  }
}

/** Every candidate file across every configured root, in precedence order. */
export function listRoots(config, cwd) {
  const dirs = resolveDirs(config, cwd)
  const out = []
  for (const c of listCommandFiles(dirs.userCommandDir)) out.push({ rank: 1, kind: 'command', ...c })
  if (config.includeSkillDirs) {
    for (const c of listSkillFiles(dirs.userSkillDir)) out.push({ rank: 2, kind: 'skill', ...c })
  }
  for (const c of listCommandFiles(dirs.projectCommandDir)) out.push({ rank: 3, kind: 'command', ...c })
  if (config.includeSkillDirs) {
    for (const c of listSkillFiles(dirs.projectSkillDir)) out.push({ rank: 4, kind: 'skill', ...c })
  }
  for (const extraDir of dirs.extraDirs) {
    for (const c of listCommandFiles(extraDir)) out.push({ rank: 5, kind: 'command', ...c })
  }
  return out
}

/**
 * Directories to watch for changes (deduplicated, existing or not), each
 * tagged with whether the watch needs to be recursive. Command roots are
 * flat (`<dir>/<name>.md`), so a non-recursive watch sees every change. Skill
 * roots are one level deeper (`<dir>/<name>/SKILL.md`) — a non-recursive
 * watch on the root only sees a skill directory being added/removed, never
 * an edit to a SKILL.md file inside one, so skill roots are watched
 * recursively.
 */
export function listWatchTargets(config, cwd) {
  const dirs = resolveDirs(config, cwd)
  const flat = [dirs.userCommandDir, dirs.projectCommandDir, ...dirs.extraDirs]
  const deep = config.includeSkillDirs ? [dirs.userSkillDir, dirs.projectSkillDir] : []
  const seen = new Set()
  const targets = []
  for (const dir of flat) {
    if (seen.has(dir)) continue
    seen.add(dir)
    targets.push({ dir, recursive: false })
  }
  for (const dir of deep) {
    if (seen.has(dir)) continue
    seen.add(dir)
    targets.push({ dir, recursive: true })
  }
  return targets
}
