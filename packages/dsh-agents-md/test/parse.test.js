import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAgentFile } from '../lib/parse.js'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/agents')
const readFixture = (name) => fs.readFileSync(path.join(fixturesDir, `${name}.md`), 'utf8')

test('parses comma-separated tools (data-engineer.md)', () => {
  const r = parseAgentFile(readFixture('data-engineer'), 'data-engineer')
  assert.equal(r.ok, true)
  assert.deepEqual(r.descriptor.tools, ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'])
  assert.equal(r.descriptor.model, 'opus')
  assert.equal(r.descriptor.effort, 'high')
  assert.equal(r.descriptor.permissionMode, 'acceptEdits')
  assert.equal(r.descriptor.maxTurns, 100)
  assert.deepEqual(r.descriptor.disallowedTools, [])
  assert.deepEqual(r.descriptor.skills, [])
})

test('parses bracket-array tools and a folded (>) description (researcher.md)', () => {
  const r = parseAgentFile(readFixture('researcher'), 'researcher')
  assert.equal(r.ok, true)
  assert.deepEqual(r.descriptor.tools, ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'TaskCreate', 'TaskUpdate', 'TaskList'])
  assert.ok(r.descriptor.description.includes('scoring pipeline'))
  assert.ok(!r.descriptor.description.includes('\n'), 'folded scalar must collapse newlines')
  assert.equal(r.descriptor.model, undefined)
})

test('parses skills array (ui-engineer.md)', () => {
  const r = parseAgentFile(readFixture('ui-engineer'), 'ui-engineer')
  assert.equal(r.ok, true)
  assert.deepEqual(r.descriptor.skills, ['frontend-design'])
  assert.equal(r.descriptor.maxTurns, 150)
})

test('every known key, valid', () => {
  const raw = [
    '---',
    'name: full',
    'description: does things',
    'model: haiku',
    'effort: low',
    'tools: Read, Edit',
    'disallowedTools: Bash',
    'permissionMode: plan',
    'maxTurns: 10',
    'skills: [a, b]',
    '---',
    'body text',
  ].join('\n')
  const r = parseAgentFile(raw, 'full')
  assert.equal(r.ok, true)
  assert.deepEqual(r.descriptor, {
    name: 'full',
    description: 'does things',
    model: 'haiku',
    effort: 'low',
    tools: ['Read', 'Edit'],
    disallowedTools: ['Bash'],
    permissionMode: 'plan',
    maxTurns: 10,
    skills: ['a', 'b'],
    extra: {},
    body: 'body text',
  })
})

test('missing description is rejected', () => {
  const raw = '---\nname: x\n---\nbody'
  const r = parseAgentFile(raw, 'x')
  assert.equal(r.ok, false)
  assert.match(r.error, /description/)
})

test('name mismatching the filename stem is rejected', () => {
  const raw = '---\nname: other\ndescription: d\n---\nbody'
  const r = parseAgentFile(raw, 'x')
  assert.equal(r.ok, false)
  assert.match(r.error, /does not match/)
})

test('body over maxPromptBytes is rejected, never truncated', () => {
  const raw = `---\ndescription: d\n---\n${'a'.repeat(100)}`
  const r = parseAgentFile(raw, 'x', 10)
  assert.equal(r.ok, false)
  assert.match(r.error, /maxPromptBytes/)
})

test('unknown key lands in extra, does not reject the file', () => {
  const raw = '---\ndescription: d\ncolor: blue\n---\nbody'
  const r = parseAgentFile(raw, 'x')
  assert.equal(r.ok, true)
  assert.deepEqual(r.descriptor.extra, { color: 'blue' })
})

test('invalid effort value is rejected', () => {
  const raw = '---\ndescription: d\neffort: medium-high\n---\nbody'
  const r = parseAgentFile(raw, 'x')
  assert.equal(r.ok, false)
  assert.match(r.error, /effort/)
})

test('invalid permissionMode value is rejected', () => {
  const raw = '---\ndescription: d\npermissionMode: sudo\n---\nbody'
  const r = parseAgentFile(raw, 'x')
  assert.equal(r.ok, false)
  assert.match(r.error, /permissionMode/)
})

test('non-integer maxTurns is rejected', () => {
  const raw = '---\ndescription: d\nmaxTurns: nope\n---\nbody'
  const r = parseAgentFile(raw, 'x')
  assert.equal(r.ok, false)
  assert.match(r.error, /maxTurns/)
})

test('missing frontmatter block is rejected', () => {
  const r = parseAgentFile('just a body, no frontmatter', 'x')
  assert.equal(r.ok, false)
  assert.match(r.error, /frontmatter/)
})

test('model: inherit sentinel passes through unresolved', () => {
  const raw = '---\ndescription: d\nmodel: inherit\n---\nbody'
  const r = parseAgentFile(raw, 'x')
  assert.equal(r.ok, true)
  assert.equal(r.descriptor.model, 'inherit')
})

test('name is optional and defaults to the filename stem', () => {
  const raw = '---\ndescription: d\n---\nbody'
  const r = parseAgentFile(raw, 'stem-name')
  assert.equal(r.ok, true)
  assert.equal(r.descriptor.name, 'stem-name')
})

test('a CRLF file parses identically to its LF equivalent', () => {
  const lf = '---\ndescription: d\ntools: Read, Edit\n---\nbody text'
  const crlf = lf.replaceAll('\n', '\r\n')
  const r = parseAgentFile(crlf, 'x')
  assert.equal(r.ok, true)
  assert.equal(r.descriptor.description, 'd')
  assert.deepEqual(r.descriptor.tools, ['Read', 'Edit'])
  assert.equal(r.descriptor.body, 'body text')
})

test('an empty body (nothing after frontmatter) is rejected like a missing description', () => {
  const raw = '---\ndescription: d\n---\n'
  const r = parseAgentFile(raw, 'x')
  assert.equal(r.ok, false)
  assert.match(r.error, /empty/)
})

test('an empty name (after trim) is rejected with the registry id-grammar reason', () => {
  const raw = '---\nname: "   "\ndescription: d\n---\nbody'
  const r = parseAgentFile(raw, '   ')
  assert.equal(r.ok, false)
  assert.match(r.error, /empty name/)
})
