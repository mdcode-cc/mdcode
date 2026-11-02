import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPresetDefinition, renderPersonaPrefix } from '../lib/preset.js'

const baseDescriptor = {
  name: 'reviewer',
  description: 'reviews things',
  model: 'opus',
  effort: 'high',
  tools: ['Read'],
  disallowedTools: [],
  permissionMode: undefined,
  maxTurns: undefined,
  skills: [],
  extra: {},
  body: 'You are a reviewer.',
}

test('plugins array: persona row first, inheritPlugins appended after, never before', () => {
  const inheritPlugins = [{ name: '@deepseek-ai/dsh-tool-fs' }, { name: '@deepseek-ai/dsh-tool-bash' }]
  const def = buildPresetDefinition(baseDescriptor, { presetIdPrefix: 'cc-', inheritPlugins })

  assert.equal(def.id, 'cc-reviewer')
  assert.equal(def.name, 'reviewer')
  assert.equal(def.description, 'reviews things')
  assert.equal(def.plugins.length, 3)
  assert.equal(def.plugins[0].name, '@deepseek-ai/dsh-persona')
  assert.deepEqual(def.plugins.slice(1), inheritPlugins)
})

test('persona prefix is the body verbatim when there are no skills', () => {
  assert.equal(renderPersonaPrefix(baseDescriptor), 'You are a reviewer.')
})

test('persona prefix appends exactly one skills line when skills is non-empty', () => {
  const withSkills = { ...baseDescriptor, skills: ['frontend-design', 'dataviz'] }
  const prefix = renderPersonaPrefix(withSkills)
  assert.equal(
    prefix,
    'You are a reviewer.\n\nLoad these skills with your skill tool before anything else: frontend-design, dataviz.',
  )
})

test('persona row config: complete false, includeRuntimeContext true', () => {
  const def = buildPresetDefinition(baseDescriptor, { presetIdPrefix: 'cc-', inheritPlugins: [] })
  assert.deepEqual(def.plugins[0].config, {
    prefix: 'You are a reviewer.',
    complete: false,
    includeRuntimeContext: true,
  })
})

test('presetIdPrefix is applied to the registered id, not the display name', () => {
  const def = buildPresetDefinition(baseDescriptor, { presetIdPrefix: 'x-', inheritPlugins: [] })
  assert.equal(def.id, 'x-reviewer')
  assert.equal(def.name, 'reviewer')
})
