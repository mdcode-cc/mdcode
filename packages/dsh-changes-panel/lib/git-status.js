/**
 * @mdcode-cc/dsh-changes-panel — git data layer. Pure parsers
 * (`parseStatus`/`parseNumstat`) + `collect()`, the only function that
 * touches a process, via an injectable `execFileImpl` so tests never spawn
 * real git. See ../README.md for the model shape.
 */

import { execFile as nodeExecFile } from 'node:child_process'

// `## <info>` header from `--branch`. Forms: `## main...origin/main [ahead
// 1]`, `## main`, `## HEAD (no branch)`, `## No commits yet on main`.
function parseBranchHeader(field) {
  if (typeof field !== 'string' || !field.startsWith('## ')) return null
  const body = field.slice(3)
  if (body.startsWith('HEAD (no branch)')) return null
  const noCommits = body.match(/^No commits yet on (\S+)/)
  if (noCommits) return noCommits[1]
  const name = body.split('...')[0].split(' ')[0]
  return name || null
}

/** `git status --porcelain=v1 -z [--branch] --untracked-files=all` output ->
 * `{ branch, staged, unstaged, untracked }`. Record shape: `XY<space><path>\0`;
 * for renames/copies (X or Y is `R`/`C`) a SECOND `\0`-terminated field
 * (the original path) immediately follows — consumed here, or every record
 * after a rename desyncs. `!!` (ignored) skipped; `??` (untracked) goes to
 * `untracked` only. With `--branch` the first record is a `## ...` header.
 */
export function parseStatus(porcelainZ) {
  const staged = []
  const unstaged = []
  const untracked = []
  if (!porcelainZ) return { branch: null, staged, unstaged, untracked }

  const fields = porcelainZ.split('\0')
  // split() on a trailing \0 leaves one empty trailing field; drop it.
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop()

  let branch = null
  let i = 0
  if (fields[0] !== undefined && fields[0].startsWith('## ')) {
    branch = parseBranchHeader(fields[0])
    i = 1
  }
  while (i < fields.length) {
    const record = fields[i]
    i += 1
    if (record.length < 3) continue // malformed/short record, skip defensively
    const x = record[0]
    const y = record[1]
    const path = record.slice(3)

    const isRename = x === 'R' || x === 'C' || y === 'R' || y === 'C'
    let renamedFrom
    if (isRename) {
      renamedFrom = fields[i]
      i += 1
    }

    if (x === '?' && y === '?') {
      untracked.push({ path, display: path, x, y, added: 0, deleted: 0, binary: false })
      continue
    }
    if (x === '!' && y === '!') continue // ignored

    const entry = { path, display: path, x, y, added: 0, deleted: 0, binary: false, ...(renamedFrom ? { renamedFrom } : {}) }
    if (x !== ' ' && x !== '?') staged.push({ ...entry })
    if (y !== ' ' && y !== '?') unstaged.push({ ...entry })
  }

  return { branch, staged, unstaged, untracked }
}

/** `git diff [--cached] --numstat -z` -> `Map<path, {added, deleted, binary}>`.
 * Plain record: `added<TAB>deleted<TAB>path\0`. Rename/copy record (real
 * git 2.51.0 bytes, captured against a live repo): `added<TAB>deleted<TAB>\0
 * oldPath\0newPath\0` — the path field after the second tab is EMPTY, and
 * TWO separate NUL-terminated fields follow it (old path, then new path).
 * Keyed on the new path — that's the name `parseStatus`'s rename entries
 * carry. Binary files report `-` for both counts.
 */
export function parseNumstat(numstatZ) {
  const map = new Map()
  if (!numstatZ) return map

  const fields = numstatZ.split('\0')
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop()

  let i = 0
  while (i < fields.length) {
    const record = fields[i]
    i += 1
    if (record === '') continue
    const tab1 = record.indexOf('\t')
    if (tab1 === -1) continue
    const tab2 = record.indexOf('\t', tab1 + 1)
    if (tab2 === -1) continue
    const addedRaw = record.slice(0, tab1)
    const deletedRaw = record.slice(tab1 + 1, tab2)
    const rest = record.slice(tab2 + 1)
    const binary = addedRaw === '-' || deletedRaw === '-'
    const added = binary ? 0 : Number(addedRaw)
    const deleted = binary ? 0 : Number(deletedRaw)

    let path
    if (rest === '') {
      // Rename/copy form: consume BOTH following fields (old path, new
      // path) and key on the new one.
      i += 1 // skip the old path field
      path = fields[i]
      i += 1
    } else {
      path = rest
    }

    map.set(path, { added, deleted, binary })
  }

  return map
}

function mergeCounts(entries, counts) {
  for (const entry of entries) {
    const found = counts.get(entry.path)
    if (found) {
      entry.added = found.added
      entry.deleted = found.deleted
      entry.binary = found.binary
    }
  }
}

function applyCap(groups, maxFiles) {
  let remaining = maxFiles
  let truncated = 0
  const capped = {}
  for (const [key, list] of Object.entries(groups)) {
    if (remaining <= 0) {
      truncated += list.length
      capped[key] = []
      continue
    }
    if (list.length > remaining) {
      capped[key] = list.slice(0, remaining)
      truncated += list.length - remaining
      remaining = 0
    } else {
      capped[key] = list
      remaining -= list.length
    }
  }
  return { capped, truncated }
}

function runGit(execFileImpl, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl('git', args, { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout ?? '')
    })
  })
}

/** Collect the working-tree model for `cwd`. Never throws: failures (not a
 * repo, git missing, nonzero exit, timeout) come back as a shaped result —
 * normal states a panel must render, not exceptions. */
export async function collect({ cwd, timeoutMs = 2000, untracked = true, maxFiles = 200, execFileImpl = nodeExecFile }) {
  const options = { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true }

  // `--branch` added to the one status call (not a 4th invocation) so
  // `branch` can come from its header, per the model shape.
  const statusArgs = ['status', '--porcelain=v1', '-z', '--branch', untracked ? '--untracked-files=all' : '--untracked-files=no']

  let statusOut
  let unstagedNumstatOut
  let stagedNumstatOut
  try {
    ;[statusOut, unstagedNumstatOut, stagedNumstatOut] = await Promise.all([
      runGit(execFileImpl, statusArgs, options),
      runGit(execFileImpl, ['diff', '--numstat', '-z'], options),
      runGit(execFileImpl, ['diff', '--cached', '--numstat', '-z'], options),
    ])
  } catch (error) {
    if (isNotARepoError(error)) return { ok: true, repo: false }
    return { ok: false, error: shortMessage(error) }
  }

  const { branch, staged, unstaged, untracked: untrackedEntries } = parseStatus(statusOut)
  mergeCounts(unstaged, parseNumstat(unstagedNumstatOut))
  mergeCounts(staged, parseNumstat(stagedNumstatOut))

  const { capped, truncated } = applyCap({ staged, unstaged, untracked: untrackedEntries }, maxFiles)

  // `files` is a count of UNIQUE paths — an `MM` file sits in both
  // `staged` and `unstaged` on purpose (one line per list, so each side's
  // own diff renders), but it is one file, not two. `added`/`deleted` ARE
  // summed across both lists: those are genuinely distinct byte changes
  // (index vs worktree), not duplicates of each other.
  const uniquePaths = new Set()
  const totals = { files: 0, added: 0, deleted: 0 }
  for (const list of [capped.staged, capped.unstaged, capped.untracked]) {
    for (const entry of list) {
      uniquePaths.add(entry.path)
      totals.added += entry.added
      totals.deleted += entry.deleted
    }
  }
  totals.files = uniquePaths.size

  return {
    ok: true,
    repo: true,
    branch,
    staged: capped.staged,
    unstaged: capped.unstaged,
    untracked: capped.untracked,
    totals,
    truncated,
    at: Date.now(),
  }
}

function isNotARepoError(error) {
  const text = `${error?.stderr ?? ''}${error?.message ?? ''}`
  return /not a git repository/i.test(text)
}

function shortMessage(error) {
  const text = (error?.stderr || error?.message || String(error)).toString().trim()
  const firstLine = text.split('\n')[0]
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}...` : firstLine
}
