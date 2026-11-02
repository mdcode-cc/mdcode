import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, Config } from '../index.js'

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agents-md-'))
}

function writeAgent(dir, stem, { description = 'does things', body = 'body', extra = '' } = {}) {
  fs.writeFileSync(path.join(dir, `${stem}.md`), `---\ndescription: ${description}\n${extra}---\n${body}\n`)
}

// Must stay >= index.js's own debounce window (currently 200ms) for the
// margin check in the rapid-writes test below to be meaningful.
const WATCH_DEBOUNCE_MS = 200

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll until `check()` is truthy or `timeoutMs` elapses (robust against CI/load jitter). */
async function waitUntil(check, timeoutMs = 3000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await wait(intervalMs)
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`)
}

/**
 * Poll `check()`, re-running `nudge()` every `nudgeIntervalMs` until it
 * passes. macOS FSEvents (what `fs.watch` rides on) occasionally coalesces
 * or drops a rapid write under heavy concurrent process load — observed
 * directly in this suite under `node --test test/*.test.js` (many worker
 * threads, many live watchers at once), never when a file runs alone. A
 * single real write is still the first attempt; the retry only compensates
 * for the OS/runtime occasionally not delivering that first event, which is
 * outside this plugin's own code.
 */
async function waitForChange(nudge, check, timeoutMs = 8000, nudgeIntervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  nudge()
  let lastNudge = Date.now()
  while (Date.now() < deadline) {
    if (await check()) return
    if (Date.now() - lastNudge >= nudgeIntervalMs) {
      nudge()
      lastNudge = Date.now()
    }
    await wait(20)
  }
  throw new Error(`waitForChange: condition not met within ${timeoutMs}ms`)
}

/**
 * Recording fake ctx: just enough of the cordis seams this plugin calls.
 * `agentPresets.register` enforces the real registry's "Duplicate agent
 * preset" guard (dsh-agent-preset-registry/lib/index.js) so a reentrancy bug
 * in the watch/debounce path shows up the same way it would on the real host.
 */
function fakeCtx() {
  const registerCalls = []
  const disposed = []
  const warnings = []
  const liveIds = new Set()
  let provided
  let teardown

  return {
    registerCalls,
    disposed,
    warnings,
    get provided() { return provided },
    runTeardown: () => teardown(),
    logger: { warn: (msg) => warnings.push(msg), info: () => {} },
    get: () => undefined,
    agentPresets: {
      async register(def) {
        if (liveIds.has(def.id)) throw new Error(`Duplicate agent preset: ${def.id}`)
        liveIds.add(def.id)
        registerCalls.push(def)
        let isDisposed = false
        return async () => {
          if (!isDisposed) { isDisposed = true; disposed.push(def.id); liveIds.delete(def.id) }
        }
      },
      async resolve(id) { return { id } },
    },
    provide(_name, value) { provided = value },
    effect(fn) { teardown = fn() },
  }
}

test('one register call per agent file', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha')
  writeAgent(dir, 'beta')
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false }))

  assert.equal(ctx.registerCalls.length, 2)
  assert.deepEqual((await ctx.provided.list()).map((d) => d.name).sort(), ['alpha', 'beta'])
})

test('project root shadows user root on duplicate name', async () => {
  const userDir = mkTmpDir()
  const projectRoot = mkTmpDir()
  const projectDir = path.join(projectRoot, '.claude', 'agents')
  fs.mkdirSync(projectDir, { recursive: true })
  writeAgent(userDir, 'shared', { body: 'user version' })
  writeAgent(projectDir, 'shared', { body: 'project version' })

  const ctx = fakeCtx()
  const cwd = process.cwd()
  process.chdir(projectRoot)
  try {
    await apply(ctx, Config({ userDir, projectDirName: '.claude/agents', watch: false }))
  } finally {
    process.chdir(cwd)
  }

  const descriptor = await ctx.provided.get('shared')
  assert.equal(descriptor.body, 'project version')
})

test('a rejecting register keeps that agent out of ctx.agentsMd', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'good')
  writeAgent(dir, 'bad')
  const ctx = fakeCtx()
  ctx.agentPresets.register = async (def) => {
    if (def.name === 'bad') throw new Error('activation failed')
    return async () => {}
  }
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false }))

  assert.deepEqual((await ctx.provided.list()).map((d) => d.name), ['good'])
  assert.ok(ctx.warnings.some((w) => w.includes('bad') && w.includes('failed to register')))
})

test('an activation failure is read lazily (never during apply) and excluded from ctx.agentsMd', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'good')
  writeAgent(dir, 'leaky')
  const ctx = fakeCtx()
  let resolvedDuringApply = false
  let applyReturned = false
  ctx.agentPresets.resolve = async (id) => {
    if (!applyReturned) resolvedDuringApply = true
    return id.endsWith('leaky') ? { id, broken: 'Preset services require isolate realms: agentsMd' } : { id }
  }
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false }))
  applyReturned = true

  assert.deepEqual((await ctx.provided.list()).map((d) => d.name), ['good'])
  assert.equal(await ctx.provided.get('leaky'), undefined)
  assert.ok(ctx.warnings.some((w) => w.includes('leaky') && w.includes('isolate realms')))
  assert.equal(resolvedDuringApply, false, 'resolve() must not be called while apply() is still running')
})

test('every disposer is called on teardown', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha')
  writeAgent(dir, 'beta')
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false }))

  await ctx.runTeardown()
  assert.deepEqual(ctx.disposed.sort(), ['cc-alpha', 'cc-beta'])
})

test('an empty tree yields an empty catalog and no throw', async () => {
  const dir = mkTmpDir()
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false }))
  assert.deepEqual(await ctx.provided.list(), [])
  assert.equal(ctx.provided.revision, 0)
})

test('revision bumps once per reconcile that changes something', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha')
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false }))
  assert.equal(ctx.provided.revision, 1)
})

test('onChange fires once per bump, after revision has already advanced', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha', { body: 'v1' })
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: true }))

  const seen = []
  const dispose = ctx.provided.onChange((revision) => seen.push([revision, ctx.provided.revision]))

  await waitForChange(
    () => writeAgent(dir, 'alpha', { body: 'v2' }),
    () => ctx.provided.revision === 2,
  )

  assert.deepEqual(seen, [[2, 2]], 'listener receives the new revision, and it already matches ctx.agentsMd.revision')
  dispose()

  // disposer actually removes the listener
  await waitForChange(
    () => writeAgent(dir, 'alpha', { body: 'v3' }),
    () => ctx.provided.revision === 3,
  )
  assert.deepEqual(seen, [[2, 2]], 'no further calls after dispose()')

  await ctx.runTeardown()
})

test('revision bumps again after a real reload through the file watcher', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha', { body: 'v1' })
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: true }))
  assert.equal(ctx.provided.revision, 1)

  await waitForChange(
    () => writeAgent(dir, 'alpha', { body: 'v2' }),
    () => ctx.provided.revision === 2,
  )
  assert.equal((await ctx.provided.get('alpha')).body, 'v2')

  await ctx.runTeardown()
})

test('rapid consecutive writes debounce into one reconcile, never a duplicate registration', async () => {
  const dir = mkTmpDir()
  const alphaPath = path.join(dir, 'alpha.md')
  writeAgent(dir, 'alpha', { body: 'v1' })
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: true }))
  assert.equal(ctx.registerCalls.filter((d) => d.id === 'cc-alpha').length, 1)

  // register-call counting alone cannot tell a real debounce from mere luck
  // (content-based dedup in index.js's reconcile() — or the OS coalescing
  // both native fs.watch events into one callback on its own — would also
  // produce exactly one extra register call). Count actual reconcile()
  // passes directly instead, by spying on the real fs.readFileSync() every
  // reconcile() calls exactly once per roster file.
  const originalReadFileSync = fs.readFileSync
  let readsOfAlpha = 0
  fs.readFileSync = (p, ...rest) => {
    if (p === alphaPath) readsOfAlpha += 1
    return originalReadFileSync(p, ...rest)
  }

  try {
    // Two writes close together should emit (at least) two fs.watch events,
    // all collapsed by the debounce into exactly one reconcile pass that
    // only ever sees the latest content.
    writeAgent(dir, 'alpha', { body: 'v2' })
    writeAgent(dir, 'alpha', { body: 'v3' })
    // Nudge only ever re-asserts the SAME final content ('v3'), never 'v2'
    // again — idempotent once mounted, so a retry can only ever compensate
    // for a dropped native event, never fabricate an extra legitimate
    // v1->v2->v3 two-step transition that would wrongly inflate the count.
    await waitForChange(
      () => writeAgent(dir, 'alpha', { body: 'v3' }),
      async () => (await ctx.provided.get('alpha'))?.body === 'v3',
    )

    // Give any second, wrongly-undebounced reconcile() pass a chance to run
    // before asserting — a false pass here would hide a regression.
    await wait(WATCH_DEBOUNCE_MS * 2)
  } finally {
    fs.readFileSync = originalReadFileSync
  }

  assert.equal(readsOfAlpha, 1, 'two rapid writes must cause exactly one reconcile() pass (one read), not two')

  const calls = ctx.registerCalls.filter((d) => d.id === 'cc-alpha')
  assert.equal(calls.length, 2, 'exactly one additional register call after the debounce window, not two')
  assert.equal((await ctx.provided.get('alpha')).body, 'v3')
  assert.deepEqual(ctx.warnings.filter((w) => w.includes('Duplicate agent preset')), [])

  await ctx.runTeardown()
})

test('tools and disallowedTools are recorded, not merged away', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha', { extra: 'tools: Read, Edit\ndisallowedTools: Bash\n' })
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false }))
  const descriptor = await ctx.provided.get('alpha')
  assert.deepEqual(descriptor.tools, ['Read', 'Edit'])
  assert.deepEqual(descriptor.disallowedTools, ['Bash'])
})

test('dshTools/dshDisallowedTools carry the normalized dsh tool names alongside the CC originals', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha', { extra: 'tools: Read, Edit\ndisallowedTools: Bash\n' })
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false }))
  const descriptor = await ctx.provided.get('alpha')
  assert.deepEqual(descriptor.tools, ['Read', 'Edit'])
  assert.deepEqual(descriptor.disallowedTools, ['Bash'])
  assert.deepEqual(descriptor.dshTools, ['read', 'read_image', 'edit'])
  assert.deepEqual(descriptor.dshDisallowedTools, ['bash'])
})

test('an unknown CC tool name is dropped from dshTools and warned exactly once', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha', { extra: 'tools: Read, MadeUpTool\n' })
  writeAgent(dir, 'beta', { extra: 'tools: MadeUpTool\n' })
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false }))
  assert.deepEqual((await ctx.provided.get('alpha')).dshTools, ['read', 'read_image'])
  assert.deepEqual((await ctx.provided.get('beta')).dshTools, [])
  const warnings = ctx.warnings.filter((w) => w.includes('MadeUpTool'))
  assert.equal(warnings.length, 1, 'expected exactly one warning across both files sharing the unknown name')
})

test('an agent with no model key inherits defaultModel', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha')
  const ctx = fakeCtx()
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false, defaultModel: 'opus' }))
  assert.equal((await ctx.provided.get('alpha')).model, 'opus')
})

test('inheritPlugins is appended after the persona row for a registered preset', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha')
  const ctx = fakeCtx()
  const inheritPlugins = [{ name: '@deepseek-ai/dsh-tool-fs' }]
  await apply(ctx, Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false, inheritPlugins }))
  const def = ctx.registerCalls[0]
  assert.equal(def.plugins[0].name, '@deepseek-ai/dsh-persona')
  assert.deepEqual(def.plugins[1], inheritPlugins[0])
})

test('a file that regresses to unparseable keeps the last-good descriptor', async () => {
  const dir = mkTmpDir()
  writeAgent(dir, 'alpha', { body: 'first version' })
  const ctx = fakeCtx()
  const config = Config({ userDir: dir, projectDirName: '.claude/agents-nonexistent', watch: false })
  await apply(ctx, config)
  assert.equal((await ctx.provided.get('alpha')).body, 'first version')

  // Break the file (drop the required `description` key) and re-scan directly
  // through the same roster builder the plugin uses on a watch tick.
  fs.writeFileSync(path.join(dir, 'alpha.md'), '---\nname: alpha\n---\nbroken now')
  const { buildRoster } = await import('../lib/catalog.js')
  const mounted = new Map([['alpha', { descriptor: await ctx.provided.get('alpha'), filePath: path.join(dir, 'alpha.md') }]])
  const roster = buildRoster((p) => fs.readFileSync(p, 'utf8'), config, mounted, () => {})
  assert.equal(roster.get('alpha').descriptor.body, 'first version')
})
