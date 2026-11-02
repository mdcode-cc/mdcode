import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin, { name, Config, apply } from '../index.js'

function resolvedConfig(overrides) {
  return { ...new Config(), ...overrides }
}

/** Approximates terminal display width for a single character — not the
 * host's real `stringWidth` (that implementation is not a dependency of
 * this package), but enough to assert the spec's claim for the one icon
 * this plugin actually uses: '±' (U+00B1 PLUS-MINUS SIGN), Latin-1
 * Supplement, unambiguously narrow — not a surrogate pair, not a combining
 * mark, not in any East-Asian-wide block. */
function approximateCharWidth(ch) {
  if ([...ch].length !== 1) return 2 // surrogate pair etc — treat as wide/unsafe
  const code = ch.codePointAt(0)
  const isCombining = code >= 0x0300 && code <= 0x036f
  const isWide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60)
  if (isCombining) return 0
  if (isWide) return 2
  return 1
}

test('plugin shape: name, Config, apply, default export', () => {
  assert.equal(name, 'dsh-changes-panel')
  assert.match(name, /^[a-z][a-z0-9_-]*$/)
  assert.equal(typeof Config, 'function')
  assert.equal(typeof apply, 'function')
  assert.equal(plugin.name, name)
  assert.equal(plugin.Config, Config)
  assert.equal(plugin.apply, apply)
})

test('Config defaults', () => {
  const config = new Config()
  assert.equal(config.refreshMs, 2000)
  assert.equal(config.maxFiles, 200)
  assert.equal(config.untracked, true)
  assert.equal(config.timeoutMs, 2000)
})

test("icon '±' has approximate display width 1", () => {
  assert.equal(approximateCharWidth('±'), 1)
})

function fakeCtxWithInject() {
  let teardown
  let injectedCb
  let registeredDescriptor
  const registerDispose = () => { registerDispose.called = true }
  const ctx = {
    effect(execute) {
      teardown = execute()
      return teardown
    },
    inject(names, cb) {
      assert.deepEqual(names, ['tuiPanels'])
      injectedCb = cb
      return () => {}
    },
  }
  return {
    ctx,
    fireInject() {
      const injectedCtx = {
        tuiPanels: {
          register(descriptor) {
            registeredDescriptor = descriptor
            return registerDispose
          },
        },
      }
      injectedCb(injectedCtx)
    },
    get descriptor() { return registeredDescriptor },
    teardown: () => teardown?.(),
  }
}

test('apply: registers a valid descriptor through ctx.inject when a TUI is composed', () => {
  const fake = fakeCtxWithInject()
  const result = apply(fake.ctx, resolvedConfig())
  fake.fireInject()
  const descriptor = fake.descriptor
  assert.equal(descriptor.apiVersion, 1)
  assert.equal(descriptor.id, 'changes')
  assert.doesNotMatch(descriptor.id, /:/)
  assert.match(descriptor.id, /^[a-z][a-z0-9_-]*$/u)
  assert.ok(descriptor.title.length > 0)
  assert.equal([...descriptor.icon].length, 1)
  assert.equal(descriptor.order, 37)
  assert.ok(descriptor.minColumns >= 12 && descriptor.minColumns <= 64)
  assert.equal(typeof descriptor.component, 'function')
  assert.equal(result, undefined) // apply() itself returns nothing
})

test('apply: silent no-op when ctx.inject never fires its callback (no TUI composed)', () => {
  let injectCalled = false
  const ctx = {
    effect(execute) { return execute() },
    inject(names, _cb) {
      injectCalled = true
      // deliberately never invoke _cb — mirrors "no TUI composed"
      return () => {}
    },
  }
  assert.doesNotThrow(() => apply(ctx, resolvedConfig()))
  assert.equal(injectCalled, true)
})

test('apply: no-op and does not throw when ctx.inject is not a function', () => {
  const ctx = { effect(execute) { return execute() } }
  assert.doesNotThrow(() => apply(ctx, resolvedConfig()))
})

test('apply: the disposer register() returns is handled (stored for cleanup)', () => {
  let disposed = false
  const effects = []
  const ctx = {
    effect(execute) {
      effects.push(execute)
      return execute()
    },
    inject(_names, cb) {
      cb({
        tuiPanels: {
          register() {
            return () => { disposed = true }
          },
        },
      })
      return () => {}
    },
  }
  apply(ctx, resolvedConfig())
  // Run every registered effect's teardown, mimicking plugin unload.
  for (const execute of effects) {
    const teardown = execute()
    if (typeof teardown === 'function') teardown()
  }
  assert.equal(disposed, true)
})
