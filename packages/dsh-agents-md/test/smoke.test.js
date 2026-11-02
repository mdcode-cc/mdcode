import { test } from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, Config, apply } from '../index.js'

test('plugin shape: name, inject, Config, apply', () => {
  assert.equal(name, 'dsh-agents-md')
  assert.deepEqual(inject, ['agentPresets'])
  assert.equal(typeof apply, 'function')
  const config = Config({})
  assert.equal(config.presetIdPrefix, 'cc-')
  assert.equal(config.defaultModel, 'sonnet')
  assert.equal(config.watch, true)
})
