/**
 * README "Test plan" item 7: point the loader at the real `~/.claude`
 * directories, read-only, and confirm real commands and skills register
 * with the names and hints their files actually declare.
 *
 * This never writes to ~/.claude. If this machine has no ~/.claude/commands
 * (a different dev box, CI), the test skips instead of failing — it proves
 * nothing is wrong, but it cannot prove the real-files contract either.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collectEntries } from '../lib/registry.js'

const commandsDir = join(homedir(), '.claude', 'commands')
const skillsDir = join(homedir(), '.claude', 'skills')

const CONFIG = {
  userCommandDir: commandsDir,
  userSkillDir: skillsDir,
  projectCommandDirName: '.claude/commands-does-not-exist',
  projectSkillDirName: '.claude/skills-does-not-exist',
  includeSkillDirs: true,
  extraDirs: [],
  maxBodyBytes: 131072,
}

test('real ~/.claude: real commands and pipeline skills register', t => {
  if (!existsSync(commandsDir)) {
    t.skip(`${commandsDir} not present on this machine`)
    return
  }
  const warnings = []
  const { entries } = collectEntries(CONFIG, process.cwd(), message => warnings.push(message))

  for (const expected of ['devkit', 'my-context', 'my-session']) {
    assert.ok(entries.has(expected), `expected user command "${expected}" to register`)
  }
  for (const expected of ['intake', 'build', 'ship', 'trace', 'daily-review', 'restore-prod-db', 'sentry-cli']) {
    assert.ok(entries.has(expected), `expected skill "${expected}" to register`)
  }

  assert.deepEqual(entries.get('intake').hint, '<ask text | session id | screenshot path>')
  assert.deepEqual(entries.get('intake').argNames, ['ask'])
  assert.equal(entries.get('daily-review').disableModelInvocation, true)
  assert.equal(entries.get('restore-prod-db').disableModelInvocation, true)
  assert.deepEqual(entries.get('sentry-cli').hint, undefined)

  // .retired-2026-09-16 under commands, and the nested `synced/<bucket>/<skill>`
  // directories under skills, must never surface as registrable names.
  assert.equal(entries.has('.retired-2026-09-16'), false)
  assert.equal(entries.has('synced'), false)
  assert.equal(entries.has('execute-full-plan'), false)
  assert.equal(entries.has('lock-plan'), false)
})
