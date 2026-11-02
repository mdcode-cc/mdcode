import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildParameters, resolveAgentOptions, extractText, dispatchTask } from '../lib/dispatch.js'

/** `list`/`get`/`presetId` are async on the real `ctx.agentsMd` (live preset-activation checks) — mirrored here. */
function fakeAgentsMd(list) {
  const byName = new Map(list.map((d) => [d.name, d]))
  return {
    list: async () => list,
    get: async (name) => byName.get(name),
    presetId: async (name) => (byName.has(name) ? `cc-${name}` : undefined),
    revision: 0,
  }
}

test('buildParameters: subagent_type enum lists the live roster', async () => {
  const agentsMd = fakeAgentsMd([{ name: 'tester', description: 'runs tests' }, { name: 'developer', description: 'writes code' }])
  const params = await buildParameters(agentsMd, { enableRunInBackground: true })
  assert.deepEqual(params.subagent_type.enum, ['tester', 'developer'])
  assert.match(params.subagent_type.description, /tester: runs tests/)
  assert.equal(params.description.required, true)
  assert.equal(params.prompt.required, true)
  assert.equal(params.run_in_background.type, 'boolean')
})

test('buildParameters: run_in_background omitted when disabled', async () => {
  const agentsMd = fakeAgentsMd([])
  const params = await buildParameters(agentsMd, { enableRunInBackground: false })
  assert.equal(params.run_in_background, undefined)
  assert.equal(params.subagent_type.enum, undefined) // empty roster: no enum constraint
  assert.match(params.subagent_type.description, /No agents are configured/)
})

test('resolveAgentOptions: omitted and warned once when ctx.modelTiers is absent', () => {
  const warnings = []
  const warnOnce = (key, msg) => warnings.push([key, msg])
  const result = resolveAgentOptions({ name: 'x', model: 'sonnet' }, undefined, warnOnce)
  assert.equal(result, undefined)
  assert.equal(warnings.length, 1)
})

test('resolveAgentOptions: calls modelTiers.resolveAgent({model, effort}) — the two-key form', () => {
  const calls = []
  const modelTiers = { resolveAgent: (args) => { calls.push(args); return { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } } }
  const result = resolveAgentOptions({ name: 'tester', model: 'sonnet', effort: 'medium' }, modelTiers, () => {})
  assert.deepEqual(calls, [{ model: 'sonnet', effort: 'medium' }])
  assert.deepEqual(result, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
})

test('resolveAgentOptions: a resolver that omits agentOptions for model: inherit passes undefined through', () => {
  const modelTiers = { resolveAgent: () => undefined }
  assert.equal(resolveAgentOptions({ name: 'x', model: 'inherit' }, modelTiers, () => {}), undefined)
})

test('extractText: joins text blocks, trims, and reports (no output) for an empty result', () => {
  assert.equal(extractText([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]), 'hello\nworld')
  assert.equal(extractText([]), '(no output)')
  assert.equal(extractText(undefined), '(no output)')
})

function fakeExec(agent = { id: 'parent-session' }) {
  return { agent, signal: { aborted: false } }
}

function baseDeps(overrides = {}) {
  const agentsMd = fakeAgentsMd([{ name: 'tester', description: 'runs tests', model: 'sonnet', effort: 'medium', tools: [], disallowedTools: [] }])
  const tracked = new Map()
  const startActivationCalls = []
  const subagents = {
    startActivation: async (spec) => {
      startActivationCalls.push(spec)
      return {
        childId: 'child-1',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'PONG' }] }),
      }
    },
  }
  return {
    deps: {
      agentsMd,
      modelTiers: { resolveAgent: ({ model }) => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: model === 'sonnet' ? 'high' : 'low' }) },
      subagents,
      config: { provider: 'spawn', enableRunInBackground: true, maxDepth: 1 },
      tracked,
      warnOnce: () => {},
      ...overrides,
    },
    startActivationCalls,
    tracked,
  }
}

test('dispatchTask: a known subagent_type starts exactly one activation with the expected shape', async () => {
  const { deps, startActivationCalls, tracked } = baseDeps()
  const exec = fakeExec()
  const text = await dispatchTask(deps, { description: 'say pong', prompt: 'reply with PONG', subagent_type: 'tester' }, exec)
  assert.equal(text, 'PONG')
  assert.equal(startActivationCalls.length, 1)
  const call = startActivationCalls[0]
  assert.equal(call.provider, 'spawn')
  assert.equal(call.label, 'say pong')
  assert.equal(call.delivery, 'parent')
  assert.equal(typeof call.childId, 'string') // the reserved-id overload: childId is a top-level spec field, not inside request
  assert.equal(call.request.agentPreset, 'cc-tester')
  assert.deepEqual(call.request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(call.request.parent, exec.agent)
  assert.equal(call.request.signal, undefined) // dropped: the top-level spec.signal is what the host actually honours
  assert.equal(tracked.size, 0) // untracked after settling
})

test('dispatchTask: the reserved childId is tracked BEFORE startActivation resolves — no untracked window', async () => {
  const { deps, tracked } = baseDeps({
    subagents: {
      startActivation: async (spec) => {
        // The exact assertion that matters: by the time the provider is
        // asked to start the child, the mask/loop/context-cap guards can
        // already see it — tracking does not wait for this call to settle.
        assert.equal(tracked.has(spec.childId), true)
        return { childId: spec.childId, result: Promise.resolve({ stopReason: 'completed', output: [] }) }
      },
    },
  })
  await dispatchTask(deps, { description: 'x', prompt: 'y', subagent_type: 'tester' }, fakeExec())
})

test('dispatchTask: a rejecting startActivation untracks the reserved childId instead of leaking it', async () => {
  let reservedId
  const { deps, tracked } = baseDeps({
    subagents: {
      startActivation: async (spec) => { reservedId = spec.childId; throw new Error('ACTIVATION_LIMIT_REACHED') },
    },
  })
  await assert.rejects(
    () => dispatchTask(deps, { description: 'x', prompt: 'y', subagent_type: 'tester' }, fakeExec()),
    /ACTIVATION_LIMIT_REACHED/,
  )
  assert.equal(tracked.has(reservedId), false)
})

test('dispatchTask: verifyIdentity is called once with the reserved childId after a successful start', async () => {
  const calls = []
  const { deps } = baseDeps({ verifyIdentity: (childId) => calls.push(childId) })
  await dispatchTask(deps, { description: 'x', prompt: 'y', subagent_type: 'tester' }, fakeExec())
  assert.equal(calls.length, 1)
  assert.equal(typeof calls[0], 'string')
})

test('dispatchTask: an unknown subagent_type rejects listing the roster and starts nothing', async () => {
  const { deps, startActivationCalls } = baseDeps()
  await assert.rejects(
    () => dispatchTask(deps, { description: 'x', prompt: 'y', subagent_type: 'does-not-exist' }, fakeExec()),
    /unknown subagent_type "does-not-exist"; available: tester/,
  )
  assert.equal(startActivationCalls.length, 0)
})

test('dispatchTask: run_in_background true returns immediately without awaiting the result', async () => {
  let resolveResult
  const { deps, tracked } = baseDeps({
    subagents: {
      startActivation: async (spec) => ({
        childId: spec.childId, // real providers echo back the reserved id this plugin generated
        result: new Promise((resolve) => { resolveResult = resolve }),
      }),
    },
  })
  const text = await dispatchTask(deps, { description: 'x', prompt: 'y', subagent_type: 'tester', run_in_background: true }, fakeExec())
  const match = /^started (.+)$/.exec(text)
  assert.ok(match, `expected "started <id>", got ${JSON.stringify(text)}`)
  const childId = match[1]
  assert.equal(tracked.has(childId), true) // still tracked: the backing promise has not settled yet
  resolveResult({ stopReason: 'completed', output: [] })
  await Promise.resolve() // let the .then() cleanup microtask run
  await Promise.resolve()
  assert.equal(tracked.has(childId), false)
})

test('dispatchTask: a non-completed stopReason throws with the diagnostic', async () => {
  const { deps } = baseDeps({
    subagents: {
      startActivation: async () => ({
        childId: 'child-err',
        result: Promise.resolve({ stopReason: 'error', diagnostic: 'boom', output: [] }),
      }),
    },
  })
  await assert.rejects(
    () => dispatchTask(deps, { description: 'x', prompt: 'y', subagent_type: 'tester' }, fakeExec()),
    /stopReason "error": boom/,
  )
})

test('dispatchTask: untrack also clears loopGuardState and the context-cap "acted" marker for that child', async () => {
  const resetCalls = []
  const forgetCalls = []
  const loopGuardState = { reset: (id) => resetCalls.push(id) }
  const forgetContextCap = (id) => forgetCalls.push(id)
  const { deps, startActivationCalls } = baseDeps({ loopGuardState, forgetContextCap })

  await dispatchTask(deps, { description: 'x', prompt: 'y', subagent_type: 'tester' }, fakeExec())

  const childId = startActivationCalls[0].childId
  assert.deepEqual(resetCalls, [childId])
  assert.deepEqual(forgetCalls, [childId])
})

test('dispatchTask: untrack clears loop-guard/context-cap state for a background child too, once it settles', async () => {
  let resolveResult
  let reservedId
  const resetCalls = []
  const forgetCalls = []
  const { deps } = baseDeps({
    loopGuardState: { reset: (id) => resetCalls.push(id) },
    forgetContextCap: (id) => forgetCalls.push(id),
    subagents: {
      startActivation: async (spec) => {
        reservedId = spec.childId
        return { childId: spec.childId, result: new Promise((resolve) => { resolveResult = resolve }) }
      },
    },
  })
  await dispatchTask(deps, { description: 'x', prompt: 'y', subagent_type: 'tester', run_in_background: true }, fakeExec())
  assert.deepEqual(resetCalls, [])
  resolveResult({ stopReason: 'completed', output: [] })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(resetCalls, [reservedId])
  assert.deepEqual(forgetCalls, [reservedId])
})

test('dispatchTask: missing loopGuardState/forgetContextCap deps is tolerated (optional chaining)', async () => {
  const { deps } = baseDeps() // baseDeps() does not set loopGuardState/forgetContextCap
  await assert.doesNotReject(() => dispatchTask(deps, { description: 'x', prompt: 'y', subagent_type: 'tester' }, fakeExec()))
})
