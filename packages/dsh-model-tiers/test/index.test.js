import { test } from 'node:test'
import assert from 'node:assert/strict'
import { name, Config, apply } from '../index.js'

/** Minimal fake cordis `ctx`: records `on`/`provide` calls, exposes `get`. No `inject` — tests that need the reactive mount-validation path build their own fake. */
function createFakeCtx({ llm } = {}) {
  const handlers = {}
  const provided = {}
  const logs = []
  const ctx = {
    logger: {
      debug: (msg) => logs.push({ level: 'debug', msg }),
      info: (msg) => logs.push({ level: 'info', msg }),
      warn: (msg) => logs.push({ level: 'warn', msg }),
    },
    on(event, listener) {
      (handlers[event] ??= []).push(listener)
      return () => {}
    },
    provide(name, value) {
      provided[name] = value
      return () => {}
    },
    get(key) {
      if (key === 'llm') return llm
      return provided[key]
    },
  }
  return { ctx, handlers, provided, logs }
}

test('name identifies the plugin', () => {
  assert.equal(name, 'dsh-model-tiers')
})

test('Config: the default table matches the spec', () => {
  const config = Config()
  assert.equal(config.provider, 'deepseek-official')
  assert.deepEqual(config.aliases.haiku, { model: 'deepseek-flash', reasoningEffort: 'low' })
  assert.deepEqual(config.aliases.sonnet, { model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.deepEqual(config.aliases.opus, { model: 'deepseek-flash', reasoningEffort: 'max' })
  assert.deepEqual(config.aliases.medium, { model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.deepEqual(config.aliases.review, { model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  assert.equal(config.logResolvedRoute, true)
  assert.deepEqual(config.retry, { codes: ['MALFORMED_RESPONSE', 'STREAM_CLOSED'], maxAttempts: 2 })
})

test('Config: rejects a reasoningEffort outside off|low|high|max', () => {
  assert.throws(() => Config({ aliases: { x: { model: 'deepseek-flash', reasoningEffort: 'medium' } } }))
})

test('apply: publishes ctx.modelTiers with resolve/resolveDetailed/resolveAgent/aliases', async () => {
  const { ctx, provided } = createFakeCtx()
  await apply(ctx, Config())
  assert.equal(typeof provided.modelTiers.resolve, 'function')
  assert.equal(typeof provided.modelTiers.resolveDetailed, 'function')
  assert.equal(typeof provided.modelTiers.resolveAgent, 'function')
  assert.deepEqual(provided.modelTiers.resolve('haiku'), { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
  // db-steward.md: model: haiku, effort: medium -> folds to high, overriding haiku's own low default.
  assert.deepEqual(provided.modelTiers.resolveAgent({ model: 'haiku', effort: 'medium' }), {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high',
  })
})

test('apply: mount refused (synchronously) when ctx.llm is already available and an alias effort mismatches', async () => {
  // No `ctx.inject` on this fake ctx, so `apply()` takes the one-shot
  // `ctx.get('llm')` fallback path and must reject apply() itself.
  const llm = {
    async resolveModelInfo(provider, model) {
      // deepseek-flash only advertises low/high, not max — opus should fail.
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
    },
  }
  const { ctx } = createFakeCtx({ llm })
  await assert.rejects(() => apply(ctx, Config()), /opus/)
})

test('apply: mount succeeds (synchronously) when the stubbed adapter supports every configured effort', async () => {
  const llm = {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }
    },
  }
  const { ctx } = createFakeCtx({ llm })
  await assert.doesNotReject(() => apply(ctx, Config()))
})

test('apply: mount skips adapter validation when ctx.llm is unavailable and ctx has no inject', async () => {
  const { ctx } = createFakeCtx() // no llm, no inject
  await assert.doesNotReject(() => apply(ctx, Config()))
})

test('apply: when ctx.inject exists, mount validation routes through it instead of a one-shot ctx.get()', async () => {
  // Simulates `llm` NOT being available synchronously at mount time (ctx.get
  // returns undefined) but activating later — the scenario the CRITICAL
  // finding named: a plain ctx.get() would silently no-op forever here.
  const llm = {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } } // no "max" -> opus mismatches
    },
  }
  const injectCalls = []
  let injectResult
  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    on() { return () => {} },
    provide() { return () => {} },
    get() { return undefined }, // llm not synchronously available
    inject(deps, callback) {
      injectCalls.push(deps)
      // Simulate the dependency becoming available: hand the callback a ctx that HAS llm.
      injectResult = callback({ get: key => (key === 'llm' ? llm : undefined) })
      return injectResult
    },
  }

  await assert.doesNotReject(() => apply(ctx, Config())) // apply() itself does not block on the injected check
  assert.deepEqual(injectCalls, [['llm']])
  await assert.rejects(() => injectResult, /opus/) // but the reactive validation still refuses on the mismatch
})

test('apply: ctx.inject path mounts cleanly when the later-activating adapter matches', async () => {
  const llm = {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }
    },
  }
  let injectResult
  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    on() { return () => {} },
    provide() { return () => {} },
    get() { return undefined },
    inject(deps, callback) {
      injectResult = callback({ get: key => (key === 'llm' ? llm : undefined) })
      return injectResult
    },
  }
  await assert.doesNotReject(() => apply(ctx, Config()))
  await assert.doesNotReject(() => injectResult)
})

test('(d) logging: one line per agent/request, config returned unchanged', async () => {
  const { ctx, handlers, logs } = createFakeCtx()
  await apply(ctx, Config())
  const listener = handlers['agent/request'][0]
  const nextConfig = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }
  const next = async () => nextConfig

  const result = await listener({ agent: { session: { id: 'sess-1' } }, turn: 3, step: 2, signal: { aborted: false } }, next)

  assert.equal(result, nextConfig) // byte-identical (same reference): no stamp applied
  const lines = logs.filter(l => l.level === 'info')
  assert.equal(lines.length, 1)
  assert.match(lines[0].msg, /turn=3 step=2 provider=deepseek-official model=deepseek-flash effort=high agent=sess-1/)
})

test('(d) logging: a throwing logger does not propagate and next() result still returns', async () => {
  const { ctx, handlers } = createFakeCtx()
  await apply(ctx, Config())
  ctx.logger.info = () => { throw new Error('logger exploded') }
  const listener = handlers['agent/request'][0]
  const nextConfig = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const result = await listener({ agent: { session: { id: 's' } }, turn: 1, step: 1, signal: { aborted: false } }, async () => nextConfig)
  assert.equal(result, nextConfig)
})

test('(d) logging: disabled via logResolvedRoute: false registers no agent/request listener', async () => {
  const { ctx, handlers } = createFakeCtx()
  await apply(ctx, Config({ logResolvedRoute: false }))
  assert.equal(handlers['agent/request'], undefined)
})

test('(a) retry: MALFORMED_RESPONSE retries, then delegates on the third occurrence in one step', async () => {
  const { ctx, handlers } = createFakeCtx()
  await apply(ctx, Config())
  const listener = handlers['agent/request-error'][0]
  const agent = { session: { id: 'sess-1' } }
  const payload = (code) => ({ agent, turn: 1, step: 1, failure: { code }, signal: { aborted: false } })
  let nextCalls = 0
  const next = () => { nextCalls += 1; return 'delegated' }

  assert.deepEqual(await listener(payload('MALFORMED_RESPONSE'), next), { kind: 'retry' })
  assert.deepEqual(await listener(payload('MALFORMED_RESPONSE'), next), { kind: 'retry' })
  assert.equal(await listener(payload('MALFORMED_RESPONSE'), next), 'delegated')
  assert.equal(nextCalls, 1)
})

test('(a) retry: RATE_LIMIT always delegates to dsh-llm-retry', async () => {
  const { ctx, handlers } = createFakeCtx()
  await apply(ctx, Config())
  const listener = handlers['agent/request-error'][0]
  const next = () => 'delegated'
  const payload = { agent: { session: { id: 'sess-1' } }, turn: 1, step: 1, failure: { code: 'RATE_LIMIT' }, signal: { aborted: false } }
  assert.equal(await listener(payload, next), 'delegated')
})

test('(a) retry: maxAttempts 0 always delegates', async () => {
  const { ctx, handlers } = createFakeCtx()
  await apply(ctx, Config({ retry: { maxAttempts: 0 } }))
  const listener = handlers['agent/request-error'][0]
  const next = () => 'delegated'
  const payload = { agent: { session: { id: 'sess-1' } }, turn: 1, step: 1, failure: { code: 'MALFORMED_RESPONSE' }, signal: { aborted: false } }
  assert.equal(await listener(payload, next), 'delegated')
})

test('(a) retry: an aborted signal short-circuits without calling next()', async () => {
  const { ctx, handlers } = createFakeCtx()
  await apply(ctx, Config())
  const listener = handlers['agent/request-error'][0]
  let nextCalled = false
  const next = () => { nextCalled = true; return 'delegated' }
  const payload = { agent: { session: { id: 'sess-1' } }, turn: 1, step: 1, failure: { code: 'MALFORMED_RESPONSE' }, signal: { aborted: true } }
  assert.equal(await listener(payload, next), undefined)
  assert.equal(nextCalled, false)
})

test('(a) retry: counter is per (agent, turn, step)', async () => {
  const { ctx, handlers } = createFakeCtx()
  await apply(ctx, Config())
  const listener = handlers['agent/request-error'][0]
  const agent = { session: { id: 'sess-1' } }
  const next = () => 'delegated'
  const payload = (turn, step) => ({ agent, turn, step, failure: { code: 'STREAM_CLOSED' }, signal: { aborted: false } })

  assert.deepEqual(await listener(payload(1, 1), next), { kind: 'retry' })
  assert.deepEqual(await listener(payload(1, 1), next), { kind: 'retry' })
  assert.equal(await listener(payload(1, 1), next), 'delegated') // step (1,1) exhausted
  assert.deepEqual(await listener(payload(1, 2), next), { kind: 'retry' }) // new step, fresh budget
})

test('(a) retry: CRITICAL — two concurrent agents at the same (turn, step) get independent budgets', async () => {
  // agent/request-error is not scope-filtered by this plugin's listener, so
  // without the agent.session.id in the key, two subagents both failing at
  // turn=1 step=1 would share and exhaust one counter. Confirms the fix end
  // to end through the real registered listener, not just the tracker unit.
  const { ctx, handlers } = createFakeCtx()
  await apply(ctx, Config())
  const listener = handlers['agent/request-error'][0]
  const next = () => 'delegated'
  const payloadFor = (sessionId) => ({
    agent: { session: { id: sessionId } }, turn: 1, step: 1, failure: { code: 'MALFORMED_RESPONSE' }, signal: { aborted: false },
  })

  assert.deepEqual(await listener(payloadFor('agent-a'), next), { kind: 'retry' }) // a: attempt 1
  assert.deepEqual(await listener(payloadFor('agent-b'), next), { kind: 'retry' }) // b: attempt 1, own budget
  assert.deepEqual(await listener(payloadFor('agent-a'), next), { kind: 'retry' }) // a: attempt 2
  assert.equal(await listener(payloadFor('agent-a'), next), 'delegated') // a: exhausted
  // b must still have budget left — it must not have been consumed by a's attempts.
  assert.deepEqual(await listener(payloadFor('agent-b'), next), { kind: 'retry' }) // b: attempt 2
  assert.equal(await listener(payloadFor('agent-b'), next), 'delegated') // b: exhausted
})
