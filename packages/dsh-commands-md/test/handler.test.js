import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDefinition } from '../index.js'

function entry(overrides) {
  return {
    name: 'build',
    description: 'Plan and build.',
    hint: '<item>',
    argNames: ['item'],
    allowedTools: [],
    disableModelInvocation: false,
    model: undefined,
    body: 'Work item: $item',
    ...overrides,
  }
}

function fakeAgent() {
  const followupCalls = []
  return { agent: { followup: message => followupCalls.push(message) }, followupCalls }
}

test('buildDefinition: recordInput is always false', () => {
  const definition = buildDefinition('build', entry())
  assert.equal(definition.recordInput, false)
})

test('buildDefinition: input.hint mirrors argument-hint; absent when undefined', () => {
  assert.deepEqual(buildDefinition('build', entry()).input, { hint: '<item>' })
  assert.equal(buildDefinition('build', entry({ hint: undefined })).input, undefined)
})

test('handler: exactly one followup, role user, commands-md source tag, expanded text', () => {
  const definition = buildDefinition('build', entry())
  const { agent, followupCalls } = fakeAgent()
  const result = definition.handler({ agent, rawInput: 'docs/claudedocs/work/foo.md' })
  assert.equal(followupCalls.length, 1)
  const message = followupCalls[0]
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'commands-md', form: 'command', name: 'build' })
  assert.deepEqual(message.content, [{ type: 'text', text: 'Work item: docs/claudedocs/work/foo.md' }])
  assert.equal(result.kind, 'success')
})

test('handler: the followup message has a real id (createUserMessage, not a bare object literal)', () => {
  // Regression: a plain {role, content, source} literal has no `id`, and
  // ReactLoopInbox dedupes queued messages by `id` — a second command in the
  // same turn would throw `message "undefined" is already pending`.
  const definition = buildDefinition('build', entry())
  const { agent, followupCalls } = fakeAgent()
  definition.handler({ agent, rawInput: 'x' })
  const message = followupCalls[0]
  assert.equal(typeof message.id, 'string')
  assert.notEqual(message.id, '')
})

test('handler: two commands in the same turn get distinct message ids', () => {
  const buildDef = buildDefinition('build', entry())
  const shipDef = buildDefinition('ship', entry({ name: 'ship' }))
  const { agent, followupCalls } = fakeAgent()
  buildDef.handler({ agent, rawInput: 'a' })
  shipDef.handler({ agent, rawInput: 'b' })
  assert.notEqual(followupCalls[0].id, followupCalls[1].id)
})

test('handler: reports allowed-tools and model as recorded-not-enforced', () => {
  const definition = buildDefinition('build', entry({ allowedTools: ['Agent', 'Bash'], model: 'sonnet' }))
  const { agent } = fakeAgent()
  const result = definition.handler({ agent, rawInput: 'x' })
  assert.match(result.text, /allowed-tools \(recorded, not enforced\): Agent, Bash/)
  assert.match(result.text, /model \(recorded, not applied\): sonnet/)
})

test('handler: reports empty placeholders in the result text', () => {
  const definition = buildDefinition('build', entry({ body: '$item $other', argNames: ['item', 'other'] }))
  const { agent } = fakeAgent()
  const result = definition.handler({ agent, rawInput: 'val' })
  assert.match(result.text, /empty: \$other/)
})
