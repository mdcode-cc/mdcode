import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRoots, listCommandFiles, listSkillFiles, listWatchTargets, findProjectRoot, expandHome } from '../lib/roots.js'

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-commands-md-roots-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function baseConfig(overrides) {
  return {
    userCommandDir: '',
    userSkillDir: '',
    projectCommandDirName: '.claude/commands',
    projectSkillDirName: '.claude/skills',
    includeSkillDirs: true,
    extraDirs: [],
    ...overrides,
  }
}

test('expandHome expands ~ and ~/ only', () => {
  assert.equal(expandHome('/abs/path'), '/abs/path')
  assert.ok(expandHome('~/foo').endsWith('/foo'))
  assert.notEqual(expandHome('~/foo'), '~/foo')
})

test('listCommandFiles ignores directories (including .retired-* ones) and non-.md files', () => {
  withTmp(dir => {
    writeFileSync(join(dir, 'a.md'), 'x')
    writeFileSync(join(dir, 'b.txt'), 'x')
    mkdirSync(join(dir, '.retired-2026-09-16'))
    writeFileSync(join(dir, '.retired-2026-09-16', 'old.md'), 'x')
    const files = listCommandFiles(dir)
    assert.deepEqual(files.map(f => f.stem), ['a'])
  })
})

test('listCommandFiles on a missing directory returns empty, not a throw', () => {
  assert.deepEqual(listCommandFiles('/no/such/dir-xyz'), [])
})

test('listSkillFiles only resolves <dir>/<name>/SKILL.md, one level deep', () => {
  withTmp(dir => {
    mkdirSync(join(dir, 'intake'))
    writeFileSync(join(dir, 'intake', 'SKILL.md'), 'x')
    mkdirSync(join(dir, 'synced', 'bucket', 'morning'), { recursive: true })
    writeFileSync(join(dir, 'synced', 'bucket', 'morning', 'SKILL.md'), 'x') // two levels deep: not found
    const files = listSkillFiles(dir)
    assert.deepEqual(files.map(f => f.stem), ['intake'])
  })
})

test('findProjectRoot stops at the nearest ancestor with .git, else returns cwd', () => {
  withTmp(dir => {
    mkdirSync(join(dir, '.git'))
    const nested = join(dir, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    assert.equal(findProjectRoot(nested), dir)
  })
  withTmp(dir => {
    assert.equal(findProjectRoot(dir), dir)
  })
})

test('listRoots: project commands shadow user commands with the same stem (by rank, later wins on merge)', () => {
  withTmp(dir => {
    const userDir = join(dir, 'user-commands')
    const projectRoot = join(dir, 'proj')
    const projectCommands = join(projectRoot, '.claude', 'commands')
    mkdirSync(userDir, { recursive: true })
    mkdirSync(projectCommands, { recursive: true })
    mkdirSync(join(projectRoot, '.git'))
    writeFileSync(join(userDir, 'build.md'), 'user version')
    writeFileSync(join(projectCommands, 'build.md'), 'project version')

    const config = baseConfig({ userCommandDir: userDir, userSkillDir: join(dir, 'no-user-skills'), includeSkillDirs: false })
    const candidates = listRoots(config, join(projectRoot, 'a', 'b'))
    const byStem = new Map(candidates.filter(c => c.stem === 'build').map(c => [c.rank, c]))
    assert.ok(byStem.has(1) && byStem.has(3))
    // rank 3 (project) comes after rank 1 (user) in the array — callers merge with a Map, so it wins.
    assert.ok(candidates.findIndex(c => c.rank === 1) < candidates.findIndex(c => c.rank === 3))
  })
})

test('listRoots: extraDirs are scanned last (highest precedence)', () => {
  withTmp(dir => {
    const extra = join(dir, 'extra')
    mkdirSync(extra, { recursive: true })
    writeFileSync(join(extra, 'custom.md'), 'x')
    const config = baseConfig({ userCommandDir: join(dir, 'no-user'), userSkillDir: join(dir, 'no-skills'), includeSkillDirs: false, extraDirs: [extra] })
    const candidates = listRoots(config, dir)
    assert.deepEqual(candidates.map(c => c.stem), ['custom'])
    assert.equal(candidates[0].rank, 5)
  })
})

test('listRoots: includeSkillDirs: false omits both skill roots entirely', () => {
  withTmp(dir => {
    const userSkills = join(dir, 'skills')
    mkdirSync(join(userSkills, 'intake'), { recursive: true })
    writeFileSync(join(userSkills, 'intake', 'SKILL.md'), 'x')
    const config = baseConfig({ userCommandDir: join(dir, 'no-user'), userSkillDir: userSkills, includeSkillDirs: false })
    assert.deepEqual(listRoots(config, dir), [])
  })
})

test('listSkillFiles does not follow a symlinked SKILL.md (lstatSync, not statSync)', () => {
  withTmp(dir => {
    const outside = join(dir, 'outside.md')
    writeFileSync(outside, 'x')
    mkdirSync(join(dir, 'skills', 'evil'), { recursive: true })
    symlinkSync(outside, join(dir, 'skills', 'evil', 'SKILL.md'))
    mkdirSync(join(dir, 'skills', 'real'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'real', 'SKILL.md'), 'x')
    const files = listSkillFiles(join(dir, 'skills'))
    assert.deepEqual(files.map(f => f.stem), ['real'])
  })
})

test('listWatchTargets: command roots are flat, skill roots are recursive', () => {
  const config = baseConfig({ userCommandDir: '/u-commands', userSkillDir: '/u-skills', includeSkillDirs: true, extraDirs: ['/extra'] })
  const targets = listWatchTargets(config, '/no/such/project')
  const byDir = new Map(targets.map(t => [t.dir, t.recursive]))
  assert.equal(byDir.get('/u-commands'), false)
  assert.equal(byDir.get('/extra'), false)
  assert.equal(byDir.get('/u-skills'), true)
})

test('listWatchTargets: includeSkillDirs: false means no recursive targets at all', () => {
  const config = baseConfig({ userCommandDir: '/u-commands', userSkillDir: '/u-skills', includeSkillDirs: false })
  const targets = listWatchTargets(config, '/no/such/project')
  assert.ok(targets.every(t => t.recursive === false))
})
