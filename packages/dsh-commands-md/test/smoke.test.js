import { test } from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, Config, apply } from '../index.js'

test('plugin identifies itself and no longer throws "not implemented"', () => {
  assert.equal(name, 'dsh-commands-md')
  assert.deepEqual(inject, ['commands'])
  assert.equal(typeof Config, 'function')
  assert.equal(typeof apply, 'function')
})
