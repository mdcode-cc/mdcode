import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, name } from '../index.js'

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-log-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Mirrors just enough of a real cordis ctx: `logger.exporter()` itself
 * registers through `effect()` — same nesting as the real
 * `LoggerService.prototype.exporter()` in cordis/src/logger.ts. `emit`
 * replicates the real severity gate from `Logger.prototype._method`
 * (cordis/src/logger.ts:155-156): `if (targetLevel < message.level)
 * continue` — a message is dropped, not exported, when the exporter's
 * threshold is lower than the message's own level. */
function fakeCtx() {
  let exporter
  let teardown
  const ctx = {
    effect(execute) {
      teardown = execute()
      return teardown
    },
    logger: {
      exporter(e) {
        return ctx.effect(() => {
          exporter = e
          return () => { exporter = undefined }
        })
      },
    },
  }
  return {
    ctx,
    emit(message) {
      if (!exporter) return
      const targetLevel = exporter.levels?.[message.name] ?? exporter.levels?.default ?? 1
      if (targetLevel < message.level) return
      exporter.export(message)
    },
    dispose: () => teardown?.(),
  }
}

function resolvedConfig(overrides) {
  return { ...new Config(), ...overrides }
}

test('plugin shape: name, Config, apply, default export', () => {
  assert.equal(name, 'dsh-plugin-log')
  assert.equal(typeof Config, 'function')
  assert.equal(typeof apply, 'function')
})

test('Config defaults', () => {
  const config = new Config()
  assert.equal(config.path, '$DSH_HOME/logs/plugins.log')
  assert.equal(config.level, 'info')
  assert.deepEqual(config.names, [])
})

test('apply: export() appends a formatted line to the log file', () => {
  withTmp(dir => {
    const logPath = join(dir, 'plugins.log')
    const { ctx, emit } = fakeCtx()
    apply(ctx, resolvedConfig({ path: logPath }))
    emit({ sn: 1, ts: Date.now(), name: 'dsh-commands-md', type: 'info', level: 1, args: ['hello %s', 'world'] })
    const content = readFileSync(logPath, 'utf8')
    assert.match(content, /dsh-commands-md: hello world/)
  })
})

test('apply: names filter only includes matching logger-name prefixes', () => {
  withTmp(dir => {
    const logPath = join(dir, 'plugins.log')
    const { ctx, emit } = fakeCtx()
    apply(ctx, resolvedConfig({ path: logPath, names: ['dsh-'] }))
    emit({ sn: 1, ts: Date.now(), name: 'other', type: 'info', level: 1, args: ['skip me'] })
    emit({ sn: 2, ts: Date.now(), name: 'dsh-x', type: 'info', level: 1, args: ['keep me'] })
    const content = readFileSync(logPath, 'utf8')
    assert.ok(!content.includes('skip me'))
    assert.ok(content.includes('keep me'))
  })
})

test('apply: a warn message (level 2) IS written at the default level (info)', () => {
  withTmp(dir => {
    const logPath = join(dir, 'plugins.log')
    const { ctx, emit } = fakeCtx()
    apply(ctx, resolvedConfig({ path: logPath })) // level: 'info' (default)
    emit({ sn: 1, ts: Date.now(), name: 'agent-preset-registry', type: 'warn', level: 2, args: ['agent preset standard: broken'] })
    const content = readFileSync(logPath, 'utf8')
    assert.match(content, /agent-preset-registry: agent preset standard: broken/)
  })
})

test('apply: a debug message (level 3) is NOT written at the default level (info)', () => {
  withTmp(dir => {
    const logPath = join(dir, 'plugins.log')
    const { ctx, emit } = fakeCtx()
    apply(ctx, resolvedConfig({ path: logPath }))
    emit({ sn: 1, ts: Date.now(), name: 'x', type: 'debug', level: 3, args: ['verbose'] })
    // Correctly gated: appendFileSync never ran, so the file was never created.
    assert.throws(() => readFileSync(logPath, 'utf8'), { code: 'ENOENT' })
  })
})

test('apply: dispose() stops the exporter from appending further lines', () => {
  withTmp(dir => {
    const logPath = join(dir, 'plugins.log')
    const { ctx, emit, dispose } = fakeCtx()
    apply(ctx, resolvedConfig({ path: logPath }))
    emit({ sn: 1, ts: Date.now(), name: 'x', type: 'info', level: 1, args: ['first'] })
    dispose()
    emit({ sn: 2, ts: Date.now(), name: 'x', type: 'info', level: 1, args: ['second'] })
    const content = readFileSync(logPath, 'utf8')
    assert.ok(content.includes('first'))
    assert.ok(!content.includes('second'))
  })
})
