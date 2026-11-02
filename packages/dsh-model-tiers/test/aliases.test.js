import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createResolver, DEFAULT_ALIASES, DEFAULT_PROVIDER } from '../lib/aliases.js'

function fakeLogger() {
  const warnings = []
  return { logger: { warn: (msg) => warnings.push(msg) }, warnings }
}

function baseConfig(overrides = {}) {
  return { provider: DEFAULT_PROVIDER, aliases: DEFAULT_ALIASES, ...overrides }
}

test('resolve: every alias in the table', () => {
  const { logger } = fakeLogger()
  const { resolve } = createResolver(baseConfig(), logger)

  assert.deepEqual(resolve('haiku'), { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
  assert.deepEqual(resolve('sonnet'), { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.deepEqual(resolve('opus'), { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
  assert.deepEqual(resolve('review'), { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
})

test('resolve: medium folds into high effort', () => {
  const { logger } = fakeLogger()
  const { resolve } = createResolver(baseConfig(), logger)
  assert.equal(resolve('medium').reasoningEffort, 'high')
})

test('resolve: review is reachable only by naming it explicitly', () => {
  // This package exposes one entry point, resolve(name); there is no
  // separate "model:" code path for it to leak through, so reachability is
  // just "calling resolve('review') works".
  const { logger } = fakeLogger()
  const { resolve } = createResolver(baseConfig(), logger)
  assert.equal(resolve('review').model, 'deepseek-v4-pro')
})

test('resolve: unknown alias passes through as an exact model id, warned once', () => {
  const { logger, warnings } = fakeLogger()
  const { resolve } = createResolver(baseConfig(), logger)

  const first = resolve('claude-opus-4-typo')
  const second = resolve('claude-opus-4-typo')

  assert.deepEqual(first, { provider: 'deepseek-official', model: 'claude-opus-4-typo' })
  assert.deepEqual(second, first)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /unknown model/)
})

test('resolve: distinct unknown names each warn once, independently', () => {
  const { logger, warnings } = fakeLogger()
  const { resolve } = createResolver(baseConfig(), logger)
  resolve('a')
  resolve('b')
  resolve('a')
  assert.equal(warnings.length, 2)
})

test('resolve: a non-default provider is carried through for every alias', () => {
  const { logger } = fakeLogger()
  const { resolve } = createResolver(baseConfig({ provider: 'deepseek-account' }), logger)
  assert.equal(resolve('haiku').provider, 'deepseek-account')
  assert.equal(resolve('unknown-model').provider, 'deepseek-account')
})

test('resolveDetailed: carries alias name and known flag', () => {
  const { logger } = fakeLogger()
  const { resolveDetailed } = createResolver(baseConfig(), logger)
  assert.deepEqual(resolveDetailed('haiku').alias, 'haiku')
  assert.equal(resolveDetailed('haiku').known, true)
  assert.equal(resolveDetailed('nope').known, false)
  assert.equal(resolveDetailed('nope').alias, undefined)
})

test('resolve: a logger that throws does not propagate', () => {
  const { resolve } = createResolver(baseConfig(), { warn: () => { throw new Error('logger is down') } })
  assert.doesNotThrow(() => resolve('unknown-thing'))
})

test('resolveAgent: model + effort — effort overrides the tier default (db-steward: haiku + medium)', () => {
  const { logger } = fakeLogger()
  const { resolveAgent } = createResolver(baseConfig(), logger)
  // haiku alone would be low; explicit effort: medium folds to high and wins.
  assert.deepEqual(resolveAgent({ model: 'haiku', effort: 'medium' }), {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high',
  })
})

test('resolveAgent: model + effort — a raw effort overrides the tier default (reviewer: opus + high)', () => {
  const { logger } = fakeLogger()
  const { resolveAgent } = createResolver(baseConfig(), logger)
  // opus alone would be max; explicit effort: high overrides it down to high.
  assert.deepEqual(resolveAgent({ model: 'opus', effort: 'high' }), {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high',
  })
})

test('resolveAgent: no effort given keeps the tier default', () => {
  const { logger } = fakeLogger()
  const { resolveAgent } = createResolver(baseConfig(), logger)
  assert.deepEqual(resolveAgent({ model: 'sonnet' }), {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high',
  })
})

test('resolveAgent: off/low/high/max pass through unchanged, medium folds via the alias table', () => {
  const { logger } = fakeLogger()
  const { resolveAgent } = createResolver(baseConfig(), logger)
  for (const raw of ['off', 'low', 'high', 'max']) {
    assert.equal(resolveAgent({ model: 'haiku', effort: raw }).reasoningEffort, raw)
  }
  assert.equal(resolveAgent({ model: 'haiku', effort: 'medium' }).reasoningEffort, 'high')
})

test('resolveAgent: unknown model still passes through with the warn, effort still folds', () => {
  const { logger, warnings } = fakeLogger()
  const { resolveAgent } = createResolver(baseConfig(), logger)
  const result = resolveAgent({ model: 'some-exact-id', effort: 'medium' })
  assert.deepEqual(result, { provider: 'deepseek-official', model: 'some-exact-id', reasoningEffort: 'high' })
  assert.equal(warnings.length, 1)
})

test("inherit: resolve('inherit') is undefined, not the literal string", () => {
  const { logger, warnings } = fakeLogger()
  const { resolve, resolveDetailed } = createResolver(baseConfig(), logger)
  assert.equal(resolve('inherit'), undefined)
  assert.deepEqual(resolveDetailed('inherit'), { inherit: true })
  assert.equal(warnings.length, 0) // inherit is a known keyword, not an unknown-model typo
})

test('inherit: resolveAgent ignores effort when model is inherit', () => {
  const { logger } = fakeLogger()
  const { resolveAgent } = createResolver(baseConfig(), logger)
  assert.equal(resolveAgent({ model: 'inherit', effort: 'high' }), undefined)
})
