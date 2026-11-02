import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog } from '../lib/catalog.js'

test('get() returns a frozen descriptor, like list()', async () => {
  const mounted = new Map([['alpha', { descriptor: { name: 'alpha', tools: ['Read'] }, presetId: 'cc-alpha' }]])
  const { catalog } = createCatalog(mounted, async (id) => ({ id }), () => {})

  const d = await catalog.get('alpha')
  assert.equal(Object.isFrozen(d), true)
  assert.throws(() => { d.name = 'changed' }, TypeError)
})

test('presetId() and get() agree on broken exclusion', async () => {
  const mounted = new Map([['alpha', { descriptor: { name: 'alpha' }, presetId: 'cc-alpha' }]])
  const { catalog } = createCatalog(mounted, async (id) => ({ id, broken: 'nope' }), () => {})
  assert.equal(await catalog.get('alpha'), undefined)
  assert.equal(await catalog.presetId('alpha'), undefined)
})

test('a bump() mid-flight does not stamp a stale result onto the new revision', async () => {
  const mounted = new Map([['alpha', { descriptor: { name: 'alpha' }, presetId: 'cc-alpha' }]])
  let callCount = 0
  let releaseFirstCall
  const firstCallGate = new Promise((resolve) => { releaseFirstCall = resolve })

  const resolvePreset = async (id) => {
    callCount += 1
    if (callCount === 1) await firstCallGate // only the first call blocks
    return { id }
  }

  const { catalog, bump } = createCatalog(mounted, resolvePreset, () => {})

  // Start brokenPresetIds() at revision 0; it is now suspended inside
  // Promise.all, waiting on firstCallGate.
  const firstList = catalog.list()

  // A reconcile bumps the revision WHILE the above call is still in flight —
  // exactly the race lib/catalog.js:93-109 had before capturing `at`.
  bump()
  assert.equal(catalog.revision, 1)

  releaseFirstCall()
  await firstList

  // Now at revision 1. If the first call's result were wrongly cached under
  // revision 1 (the bug), this second call would be served from that stale
  // cache and resolvePreset would NOT run again.
  await catalog.list()
  assert.equal(callCount, 2, 'revision 1 must trigger its own resolvePreset call, not reuse revision 0\'s result')
})
