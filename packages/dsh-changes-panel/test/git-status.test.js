import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStatus, parseNumstat, collect } from '../lib/git-status.js'

function z(...fields) {
  return fields.join('\0') + '\0'
}

test('parseStatus: plain modify', () => {
  const { staged, unstaged, untracked } = parseStatus(z(' M file.js'))
  assert.deepEqual(staged, [])
  assert.equal(unstaged.length, 1)
  assert.equal(unstaged[0].path, 'file.js')
  assert.equal(unstaged[0].x, ' ')
  assert.equal(unstaged[0].y, 'M')
  assert.deepEqual(untracked, [])
})

test('parseStatus: MM dual-listing — same file in both staged and unstaged', () => {
  const { staged, unstaged } = parseStatus(z('MM file.js'))
  assert.equal(staged.length, 1)
  assert.equal(unstaged.length, 1)
  assert.equal(staged[0].path, 'file.js')
  assert.equal(unstaged[0].path, 'file.js')
})

test('parseStatus: ?? untracked', () => {
  const { staged, unstaged, untracked } = parseStatus(z('?? new-file.txt'))
  assert.deepEqual(staged, [])
  assert.deepEqual(unstaged, [])
  assert.equal(untracked.length, 1)
  assert.equal(untracked[0].path, 'new-file.txt')
})

test('parseStatus: !! ignored is excluded entirely', () => {
  const { staged, unstaged, untracked } = parseStatus(z('!! ignored.log'))
  assert.deepEqual(staged, [])
  assert.deepEqual(unstaged, [])
  assert.deepEqual(untracked, [])
})

test('parseStatus: staged rename (R) with the extra NUL path field — last record', () => {
  const { staged } = parseStatus(z('R  new-name.js', 'old-name.js'))
  assert.equal(staged.length, 1)
  assert.equal(staged[0].path, 'new-name.js')
  assert.equal(staged[0].renamedFrom, 'old-name.js')
})

test('parseStatus: rename mixed among other records does not desync the parse', () => {
  const porcelain = z(' M before.js', 'R  new-name.js', 'old-name.js', ' M after.js')
  const { unstaged, staged } = parseStatus(porcelain)
  assert.deepEqual(unstaged.map(e => e.path).sort(), ['after.js', 'before.js'])
  assert.equal(staged.length, 1)
  assert.equal(staged[0].path, 'new-name.js')
  assert.equal(staged[0].renamedFrom, 'old-name.js')
})

test('parseStatus: copy (C) also consumes the extra path field', () => {
  const porcelain = z('C  copy.js', 'source.js', ' M trailing.js')
  const { staged, unstaged } = parseStatus(porcelain)
  assert.equal(staged.length, 1)
  assert.equal(staged[0].renamedFrom, 'source.js')
  assert.equal(unstaged.length, 1)
  assert.equal(unstaged[0].path, 'trailing.js')
})

test('parseStatus: --branch header is parsed and stripped from entries', () => {
  const porcelain = z('## main...origin/main [ahead 1]', ' M file.js')
  const { branch, unstaged } = parseStatus(porcelain)
  assert.equal(branch, 'main')
  assert.equal(unstaged.length, 1)
})

test('parseStatus: detached HEAD header yields null branch', () => {
  const { branch } = parseStatus(z('## HEAD (no branch)'))
  assert.equal(branch, null)
})

test('parseStatus: unborn HEAD header', () => {
  const { branch } = parseStatus(z('## No commits yet on main'))
  assert.equal(branch, 'main')
})

test('parseStatus: empty input', () => {
  const { staged, unstaged, untracked, branch } = parseStatus('')
  assert.deepEqual(staged, [])
  assert.deepEqual(unstaged, [])
  assert.deepEqual(untracked, [])
  assert.equal(branch, null)
})

test('parseNumstat: plain record', () => {
  const map = parseNumstat('3\t1\tfile.js\0')
  assert.deepEqual(map.get('file.js'), { added: 3, deleted: 1, binary: false })
})

test('parseNumstat: binary record reports - / - with binary true, counts 0', () => {
  const map = parseNumstat('-\t-\timage.png\0')
  assert.deepEqual(map.get('image.png'), { added: 0, deleted: 0, binary: true })
})

// Real bytes captured against git 2.51.0 for `git mv old.txt new.txt &&
// printf '...' > new.txt && git add new.txt` then `git diff --cached
// --numstat -z`: the path field after the second tab is EMPTY, followed
// by TWO separate NUL-terminated fields (old path, then new path) — not
// the single combined "old-name\0new-name" shape an earlier version of
// this test (and the code under test) wrongly assumed.
test('parseNumstat: rename form (empty path field + old + new) keys the map on the NEW path', () => {
  const record = '1\t0\t\0old.txt\0new.txt\0'
  const map = parseNumstat(record)
  assert.equal(map.has('new.txt'), true)
  assert.deepEqual(map.get('new.txt'), { added: 1, deleted: 0, binary: false })
  assert.equal(map.has('old.txt'), false)
})

test('parseNumstat: rename record mixed with a following plain record does not desync', () => {
  const record = '5\t2\t\0old.js\0new.js\0' + '1\t0\tother.js\0'
  const map = parseNumstat(record)
  assert.deepEqual(map.get('new.js'), { added: 5, deleted: 2, binary: false })
  assert.deepEqual(map.get('other.js'), { added: 1, deleted: 0, binary: false })
})

test('parseNumstat: empty input', () => {
  const map = parseNumstat('')
  assert.equal(map.size, 0)
})

// --- collect(): fake execFileImpl, never spawns real git ------------------

function fakeExecFile(responses) {
  return (_cmd, args, _options, callback) => {
    const key = args.join(' ')
    const entry = responses[key]
    if (entry === undefined) {
      callback(Object.assign(new Error(`unexpected git invocation: ${key}`), { stderr: '' }))
      return
    }
    if (entry.error) {
      callback(entry.error)
      return
    }
    callback(null, entry.stdout ?? '')
  }
}

const STATUS_KEY = 'status --porcelain=v1 -z --branch --untracked-files=all'
const DIFF_KEY = 'diff --numstat -z'
const CACHED_KEY = 'diff --cached --numstat -z'

test('collect: not-a-git-repo detection returns { ok: true, repo: false }', async () => {
  const execFileImpl = fakeExecFile({
    [STATUS_KEY]: { error: Object.assign(new Error('fatal'), { stderr: 'fatal: not a git repository (or any of the parent directories): .git' }) },
    [DIFF_KEY]: { error: Object.assign(new Error('fatal'), { stderr: 'fatal: not a git repository' }) },
    [CACHED_KEY]: { error: Object.assign(new Error('fatal'), { stderr: 'fatal: not a git repository' }) },
  })
  const result = await collect({ cwd: '/nowhere', execFileImpl })
  assert.deepEqual(result, { ok: true, repo: false })
})

test('collect: git invocation failure returns a shaped error, never throws', async () => {
  const execFileImpl = fakeExecFile({
    [STATUS_KEY]: { error: Object.assign(new Error('spawn git ENOENT'), { stderr: '' }) },
    [DIFF_KEY]: { error: Object.assign(new Error('spawn git ENOENT'), { stderr: '' }) },
    [CACHED_KEY]: { error: Object.assign(new Error('spawn git ENOENT'), { stderr: '' }) },
  })
  const result = await collect({ cwd: '/wherever', execFileImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /ENOENT/)
})

test('collect: timeout surfaces as a shaped error', async () => {
  const execFileImpl = fakeExecFile({
    [STATUS_KEY]: { error: Object.assign(new Error('Command timed out'), { stderr: '', killed: true, signal: 'SIGTERM' }) },
    [DIFF_KEY]: { stdout: '' },
    [CACHED_KEY]: { stdout: '' },
  })
  const result = await collect({ cwd: '/x', timeoutMs: 1, execFileImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out/i)
})

test('collect: assembles a full model from the three git outputs', async () => {
  const execFileImpl = fakeExecFile({
    [STATUS_KEY]: { stdout: z('## main...origin/main', 'MM both.js', '?? new.txt') },
    [DIFF_KEY]: { stdout: '2\t1\tboth.js\0' },
    [CACHED_KEY]: { stdout: '5\t0\tboth.js\0' },
  })
  const result = await collect({ cwd: '/repo', execFileImpl })
  assert.equal(result.ok, true)
  assert.equal(result.repo, true)
  assert.equal(result.branch, 'main')
  assert.equal(result.staged.length, 1)
  assert.deepEqual([result.staged[0].added, result.staged[0].deleted], [5, 0])
  assert.equal(result.unstaged.length, 1)
  assert.deepEqual([result.unstaged[0].added, result.unstaged[0].deleted], [2, 1])
  assert.equal(result.untracked.length, 1)
  // both.js is `MM` — it legitimately appears in BOTH staged and
  // unstaged (one row per list, so each side's own diff renders), but it
  // is ONE file, not two: totals.files counts UNIQUE paths (both.js +
  // new.txt = 2), not the sum of the three list lengths (which would be 3
  // and double-count both.js).
  assert.equal(result.totals.files, 2)
  assert.equal(result.totals.added, 7)
  assert.equal(result.totals.deleted, 1)
  assert.equal(result.truncated, 0)
  assert.equal(typeof result.at, 'number')
})

test('collect: totals.files counts unique paths, not list-length sum, on an MM fixture', async () => {
  const execFileImpl = fakeExecFile({
    [STATUS_KEY]: { stdout: z('MM a.js', 'MM b.js', ' M c.js') },
    [DIFF_KEY]: { stdout: '1\t1\ta.js\0' + '1\t1\tb.js\0' + '1\t1\tc.js\0' },
    [CACHED_KEY]: { stdout: '1\t1\ta.js\0' + '1\t1\tb.js\0' },
  })
  const result = await collect({ cwd: '/repo', execFileImpl })
  // 3 unique files (a.js, b.js, c.js), even though a.js/b.js each produce
  // one staged row AND one unstaged row (5 rows total across the lists).
  assert.equal(result.staged.length, 2)
  assert.equal(result.unstaged.length, 3)
  assert.equal(result.totals.files, 3)
})

test('collect: a renamed+edited staged file reports the real added/deleted counts, not +0 -0', async () => {
  // Real bytes captured against git 2.51.0 for `git mv old.txt new.txt &&
  // printf '...' > new.txt && git add new.txt`.
  const execFileImpl = fakeExecFile({
    [STATUS_KEY]: { stdout: z('## main', 'R  new.txt', 'old.txt') },
    [DIFF_KEY]: { stdout: '' },
    [CACHED_KEY]: { stdout: '1\t0\t\0old.txt\0new.txt\0' },
  })
  const result = await collect({ cwd: '/repo', execFileImpl })
  assert.equal(result.staged.length, 1)
  assert.equal(result.staged[0].path, 'new.txt')
  assert.equal(result.staged[0].renamedFrom, 'old.txt')
  assert.equal(result.staged[0].added, 1)
  assert.equal(result.staged[0].deleted, 0)
  assert.equal(result.totals.added, 1)
  assert.equal(result.totals.files, 1)
})

test('collect: maxFiles truncation counts omitted files across groups', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => `?? file${i}.txt`)
  const execFileImpl = fakeExecFile({
    [STATUS_KEY]: { stdout: z(...entries) },
    [DIFF_KEY]: { stdout: '' },
    [CACHED_KEY]: { stdout: '' },
  })
  const result = await collect({ cwd: '/repo', execFileImpl, maxFiles: 2 })
  assert.equal(result.untracked.length, 2)
  assert.equal(result.truncated, 3)
  assert.equal(result.totals.files, 2)
})
