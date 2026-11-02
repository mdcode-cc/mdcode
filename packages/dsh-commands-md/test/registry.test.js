import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcile, entrySignature } from '../lib/registry.js'

function entry(overrides) {
  return { body: 'body', description: 'desc', argNames: [], filePath: '/f.md', ...overrides }
}

function config(overrides) {
  return { namePrefix: '', skipNames: [], ...overrides }
}

function fakeRegister() {
  const calls = []
  const register = (commandName, entryArg) => {
    calls.push(commandName)
    return () => calls.push(`unregister:${commandName}`)
  }
  return { register, calls }
}

test('reconcile: new entry gets registered', () => {
  const { register, calls } = fakeRegister()
  const entries = new Map([['build', entry()]])
  const result = reconcile({ config: config(), live: new Map(), entries, attempted: new Set(['build']), register, warn: () => {} })
  assert.deepEqual(result.registeredNames, ['build'])
  assert.deepEqual(calls, ['build'])
})

test('reconcile: unchanged entry (identical signature) is left alone, not re-registered', () => {
  const { register, calls } = fakeRegister()
  const live = new Map([['build', { entry: entry(), unregister: () => calls.push('old-unregister'), signature: entrySignature(entry()) }]])
  const entries = new Map([['build', entry()]])
  const result = reconcile({ config: config(), live, entries, attempted: new Set(['build']), register, warn: () => {} })
  assert.deepEqual(result.registeredNames, ['build'])
  assert.deepEqual(calls, []) // neither old unregister nor a new register call
})

test('reconcile: changed entry unregisters the old row and registers the new one', () => {
  const { register, calls } = fakeRegister()
  const oldUnregister = () => calls.push('old-unregister')
  const oldEntry = entry({ body: 'old body' })
  const live = new Map([['build', { entry: oldEntry, unregister: oldUnregister, signature: entrySignature(oldEntry) }]])
  const entries = new Map([['build', entry({ body: 'new body' })]])
  const result = reconcile({ config: config(), live, entries, attempted: new Set(['build']), register, warn: () => {} })
  assert.deepEqual(result.registeredNames, ['build'])
  assert.deepEqual(calls, ['old-unregister', 'build'])
})

test('reconcile: a change in argNames/hint/allowedTools/model alone (same body+description) is still detected', () => {
  // Regression: the signature used to be `body + description` only, so an
  // edit to `arguments:`, `argument-hint:`, `allowed-tools:` or `model:`
  // with no body/description change was invisible — the old handler
  // closure (stale argNames etc.) survived a live reload.
  const { register, calls } = fakeRegister()
  const oldEntry = entry({ argNames: ['old'] })
  const live = new Map([['build', { entry: oldEntry, unregister: () => calls.push('old-unregister'), signature: entrySignature(oldEntry) }]])
  const entries = new Map([['build', entry({ argNames: ['new'] })]])
  const result = reconcile({ config: config(), live, entries, attempted: new Set(['build']), register, warn: () => {} })
  assert.deepEqual(calls, ['old-unregister', 'build'])
})

test('reconcile: entry gone from disk entirely is unregistered', () => {
  const unregisterCalls = []
  const live = new Map([['build', { entry: entry(), unregister: () => unregisterCalls.push('build'), signature: 'body desc' }]])
  const { register } = fakeRegister()
  const result = reconcile({ config: config(), live, entries: new Map(), attempted: new Set(), register, warn: () => {} })
  assert.deepEqual(unregisterCalls, ['build'])
  assert.deepEqual(result.registeredNames, [])
  assert.equal(result.live.has('build'), false)
})

test('reconcile: file still on disk but unparseable this pass keeps the previous good registration', () => {
  const unregisterCalls = []
  const live = new Map([['build', { entry: entry(), unregister: () => unregisterCalls.push('build'), signature: 'body desc' }]])
  const { register } = fakeRegister()
  const warnings = []
  const result = reconcile({
    config: config(),
    live,
    entries: new Map(), // this pass failed to parse build.md
    attempted: new Set(['build']), // ...but the file is still there
    register,
    warn: m => warnings.push(m),
  })
  assert.deepEqual(unregisterCalls, [])
  assert.equal(result.live.get('build').signature, 'body desc')
})

test('reconcile: skipNames entries never register, even when discovered', () => {
  const { register, calls } = fakeRegister()
  const entries = new Map([['compact', entry()], ['build', entry()]])
  const warnings = []
  const result = reconcile({
    config: config({ skipNames: ['compact'] }),
    live: new Map(),
    entries,
    attempted: new Set(['compact', 'build']),
    register,
    warn: m => warnings.push(m),
  })
  assert.deepEqual(result.registeredNames, ['build'])
  assert.deepEqual(calls, ['build'])
  assert.ok(warnings.some(w => w.includes('compact')))
})

test('reconcile: a register() throw (collision) skips only that one entry, keeps the rest', () => {
  const calls = []
  const register = (commandName) => {
    if (commandName === 'bad') throw new Error('Registering the same name twice in one scope throws')
    calls.push(commandName)
    return () => {}
  }
  const entries = new Map([['bad', entry()], ['good', entry()]])
  const warnings = []
  const result = reconcile({ config: config(), live: new Map(), entries, attempted: new Set(['bad', 'good']), register, warn: m => warnings.push(m) })
  assert.deepEqual(result.registeredNames, ['good'])
  assert.deepEqual(calls, ['good'])
  assert.ok(warnings.some(w => w.includes('bad')))
})

test('reconcile: namePrefix is applied to the registered name', () => {
  const { register, calls } = fakeRegister()
  const entries = new Map([['build', entry()]])
  const result = reconcile({ config: config({ namePrefix: 'md-' }), live: new Map(), entries, attempted: new Set(['build']), register, warn: () => {} })
  assert.deepEqual(result.registeredNames, ['md-build'])
  assert.deepEqual(calls, ['md-build'])
})

test('reconcile: register() throwing an invalid-name error is reported distinctly from a collision', () => {
  // Mirrors the host's dsh-commands throw for a grammar violation —
  // `command name "X" must match /^[a-z][a-z0-9_-]*$/u` — which can still
  // happen after `namePrefix` is applied even though our own parse-time
  // check already rejects a bad raw name.
  const register = () => {
    throw new TypeError('command name "1-build" must match /^[a-z][a-z0-9_-]*$/u')
  }
  const entries = new Map([['build', entry()]])
  const warnings = []
  const result = reconcile({ config: config({ namePrefix: '1-' }), live: new Map(), entries, attempted: new Set(['build']), register, warn: m => warnings.push(m) })
  assert.deepEqual(result.registeredNames, [])
  assert.ok(warnings.some(w => w.includes('not a valid command name')))
  assert.ok(!warnings.some(w => w.includes('collides')))
})
