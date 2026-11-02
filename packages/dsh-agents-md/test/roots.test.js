import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveRoots, listAgentFiles, findProjectRoot } from '../lib/roots.js'

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agents-md-'))
}

test('resolveRoots orders user, project, then extraDirs', () => {
  const roots = resolveRoots({ userDir: '~/u', projectDirName: '.claude/agents', extraDirs: ['/e1', '/e2'] }, '/some/cwd')
  assert.equal(roots.length, 4)
  assert.ok(roots[0].endsWith('/u'))
  assert.ok(roots[1].endsWith(path.join('.claude', 'agents')))
  assert.deepEqual(roots.slice(2), ['/e1', '/e2'])
})

test('findProjectRoot walks up to the nearest .git', () => {
  const root = mkTmpDir()
  fs.mkdirSync(path.join(root, '.git'))
  const nested = path.join(root, 'a', 'b')
  fs.mkdirSync(nested, { recursive: true })
  assert.equal(findProjectRoot(nested), root)
})

test('findProjectRoot falls back to the start dir when no .git is found', () => {
  const dir = mkTmpDir()
  assert.equal(findProjectRoot(dir), dir)
})

test('listAgentFiles returns a missing root as empty, no throw', () => {
  assert.deepEqual(listAgentFiles('/definitely/does/not/exist'), [])
})

test('listAgentFiles ignores non-.md files and nested directories', () => {
  const dir = mkTmpDir()
  fs.writeFileSync(path.join(dir, 'a.md'), 'x')
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x')
  fs.mkdirSync(path.join(dir, 'nested'))
  fs.writeFileSync(path.join(dir, 'nested', 'c.md'), 'x')
  const files = listAgentFiles(dir)
  assert.deepEqual(files, [path.join(dir, 'a.md')])
})

test('listAgentFiles skips dotfiles, even *.md ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agents-md-'))
  fs.writeFileSync(path.join(dir, 'a.md'), 'x')
  fs.writeFileSync(path.join(dir, '.retired-foo.md'), 'x')
  const files = listAgentFiles(dir)
  assert.deepEqual(files, [path.join(dir, 'a.md')])
})

test('listAgentFiles follows a symlinked agent file to a regular file', () => {
  const dir = mkTmpDir()
  const otherDir = mkTmpDir()
  fs.writeFileSync(path.join(otherDir, 'shared.md'), 'x')
  fs.symlinkSync(path.join(otherDir, 'shared.md'), path.join(dir, 'linked.md'))
  const files = listAgentFiles(dir)
  assert.deepEqual(files, [path.join(dir, 'linked.md')])
})

test('listAgentFiles drops a broken symlink without throwing', () => {
  const dir = mkTmpDir()
  fs.symlinkSync(path.join(dir, 'does-not-exist.md'), path.join(dir, 'broken.md'))
  assert.deepEqual(listAgentFiles(dir), [])
})

test('listAgentFiles drops a symlink that points at a directory', () => {
  const dir = mkTmpDir()
  const targetDir = mkTmpDir()
  fs.symlinkSync(targetDir, path.join(dir, 'dirlink.md'))
  assert.deepEqual(listAgentFiles(dir), [])
})
