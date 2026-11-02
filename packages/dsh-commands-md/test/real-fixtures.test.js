/**
 * Parses synthetic files committed into test/fixtures/real/ — invented
 * content shaped to exercise the same frontmatter edge cases a real
 * ~/.claude/commands and ~/.claude/skills tree hits (no frontmatter at all,
 * argument-hint + arguments + allowed-tools, disable-model-invocation with
 * an empty argument-hint, a nested `requires:` block) without depending on
 * any particular machine's ~/.claude being present at test time.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readEntry } from '../lib/parse.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures', 'real')
const CONFIG = { maxBodyBytes: 131072 }

test('fixture: notes.md (no frontmatter at all)', () => {
  const result = readEntry(join(fixtures, 'commands', 'notes.md'), 'notes', 'command', CONFIG)
  assert.equal(result.ok, true)
  assert.equal(result.entry.name, 'notes')
  assert.match(result.entry.description, /Manage freeform notes/)
  assert.equal(result.entry.hint, undefined)
  assert.deepEqual(result.entry.argNames, [])
})

test('fixture: triage/SKILL.md (argument-hint, arguments, allowed-tools)', () => {
  const result = readEntry(join(fixtures, 'skills', 'triage', 'SKILL.md'), 'triage', 'skill', CONFIG)
  assert.equal(result.ok, true)
  assert.equal(result.entry.name, 'triage')
  assert.equal(result.entry.hint, '<report text | id>')
  assert.deepEqual(result.entry.argNames, ['report'])
  assert.deepEqual(result.entry.allowedTools, ['Agent', 'SendMessage', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'])
  assert.equal(result.entry.disableModelInvocation, false)
})

test('fixture: deploy/SKILL.md (disable-model-invocation: true, empty argument-hint -> no hint)', () => {
  const result = readEntry(join(fixtures, 'skills', 'deploy', 'SKILL.md'), 'deploy', 'skill', CONFIG)
  assert.equal(result.ok, true)
  assert.equal(result.entry.disableModelInvocation, true)
  // The host rejects an empty-string input.hint, and "" means "no hint" anyway.
  assert.equal(result.entry.hint, undefined)
})

test('fixture: status/SKILL.md (nested requires: block, no arguments/hint)', () => {
  const result = readEntry(join(fixtures, 'skills', 'status', 'SKILL.md'), 'status', 'skill', CONFIG)
  assert.equal(result.ok, true)
  assert.equal(result.entry.name, 'status')
  assert.equal(result.entry.hint, undefined)
  assert.deepEqual(result.entry.argNames, [])
  assert.deepEqual(result.entry.extra.requires, { nested: true })
  assert.equal(result.entry.extra.version, '0.4.2')
})
