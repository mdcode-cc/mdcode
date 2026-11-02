import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, name, inject } from '../index.js'

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-commands-md-apply-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function fakeCtx() {
  const registrations = new Map()
  const logs = { info: [], warn: [] }
  let teardown
  const ctx = {
    commands: {
      register(definition) {
        if (registrations.has(definition.name)) throw new Error(`duplicate: ${definition.name}`)
        registrations.set(definition.name, definition)
        return () => registrations.delete(definition.name)
      },
    },
    logger: {
      info: message => logs.info.push(message),
      warn: message => logs.warn.push(message),
    },
    effect(execute) {
      teardown = execute()
    },
  }
  return { ctx, registrations, logs, runTeardown: () => teardown?.() }
}

function resolvedConfig(overrides) {
  // Mirrors what cordis would hand `apply()` after validating against `export const Config`.
  const defaults = new Config()
  return { ...defaults, watch: false, ...overrides }
}

test('plugin shape: name, inject, Config, apply, default export', async () => {
  assert.equal(name, 'dsh-commands-md')
  assert.deepEqual(inject, ['commands'])
  assert.equal(typeof Config, 'function')
  assert.equal(typeof apply, 'function')
  const mod = await import('../index.js')
  assert.equal(mod.default.name, 'dsh-commands-md')
  assert.equal(mod.default.apply, apply)
})

test('apply: registers one command per file and logs the registered names', () => {
  withTmp(dir => {
    const userCommands = join(dir, 'commands')
    mkdirSync(userCommands, { recursive: true })
    writeFileSync(join(userCommands, 'devkit.md'), 'Set up dev tools.\n\nArguments: $ARGUMENTS\n')
    const { ctx, registrations, logs } = fakeCtx()
    apply(ctx, resolvedConfig({ userCommandDir: userCommands, includeSkillDirs: false }))
    assert.ok(registrations.has('devkit'))
    assert.ok(logs.info.some(line => line.includes('registered 1 command') && line.includes('devkit')))
  })
})

test('apply: project commands shadow user commands with the same name', () => {
  withTmp(dir => {
    const userCommands = join(dir, 'user-commands')
    const projectRoot = join(dir, 'proj')
    mkdirSync(userCommands, { recursive: true })
    mkdirSync(join(projectRoot, '.claude', 'commands'), { recursive: true })
    mkdirSync(join(projectRoot, '.git'))
    writeFileSync(join(userCommands, 'build.md'), 'user body')
    writeFileSync(join(projectRoot, '.claude', 'commands', 'build.md'), 'project body')
    const { ctx, registrations } = fakeCtx()
    const originalCwd = process.cwd()
    process.chdir(projectRoot)
    try {
      apply(ctx, resolvedConfig({ userCommandDir: userCommands, includeSkillDirs: false }))
    } finally {
      process.chdir(originalCwd)
    }
    assert.equal(registrations.get('build').description, 'project body')
  })
})

test('apply: a skipNames entry is never registered', () => {
  withTmp(dir => {
    const userCommands = join(dir, 'commands')
    mkdirSync(userCommands, { recursive: true })
    writeFileSync(join(userCommands, 'compact.md'), 'Should not register.')
    const { ctx, registrations } = fakeCtx()
    apply(ctx, resolvedConfig({ userCommandDir: userCommands, includeSkillDirs: false }))
    assert.equal(registrations.has('compact'), false)
  })
})

test('apply: user-invocable: false skills are not registered; disable-model-invocation: true ones are', () => {
  withTmp(dir => {
    const userSkills = join(dir, 'skills')
    mkdirSync(join(userSkills, 'hidden'), { recursive: true })
    writeFileSync(join(userSkills, 'hidden', 'SKILL.md'), '---\ndescription: x\nuser-invocable: false\n---\nbody')
    mkdirSync(join(userSkills, 'daily-review'), { recursive: true })
    writeFileSync(join(userSkills, 'daily-review', 'SKILL.md'), '---\ndescription: x\ndisable-model-invocation: true\n---\nbody')
    const { ctx, registrations } = fakeCtx()
    apply(ctx, resolvedConfig({ userCommandDir: join(dir, 'no-commands'), userSkillDir: userSkills }))
    assert.equal(registrations.has('hidden'), false)
    assert.ok(registrations.has('daily-review'))
  })
})

test('apply: teardown calls every unregister', () => {
  withTmp(dir => {
    const userCommands = join(dir, 'commands')
    mkdirSync(userCommands, { recursive: true })
    writeFileSync(join(userCommands, 'a.md'), 'A body.')
    writeFileSync(join(userCommands, 'b.md'), 'B body.')
    const { ctx, registrations, runTeardown } = fakeCtx()
    apply(ctx, resolvedConfig({ userCommandDir: userCommands, includeSkillDirs: false }))
    assert.equal(registrations.size, 2)
    runTeardown()
    assert.equal(registrations.size, 0)
  })
})

test('apply: namePrefix is applied to every registered command', () => {
  withTmp(dir => {
    const userCommands = join(dir, 'commands')
    mkdirSync(userCommands, { recursive: true })
    writeFileSync(join(userCommands, 'a.md'), 'A body.')
    const { ctx, registrations } = fakeCtx()
    apply(ctx, resolvedConfig({ userCommandDir: userCommands, includeSkillDirs: false, namePrefix: 'md-' }))
    assert.ok(registrations.has('md-a'))
  })
})

test('apply: stderrMirror defaults to false — console.error stays silent', () => {
  withTmp(dir => {
    const userCommands = join(dir, 'commands')
    mkdirSync(userCommands, { recursive: true })
    writeFileSync(join(userCommands, 'a.md'), 'A body.')
    const { ctx } = fakeCtx()
    const originalConsoleError = console.error
    const consoleCalls = []
    console.error = message => consoleCalls.push(message)
    try {
      apply(ctx, resolvedConfig({ userCommandDir: userCommands, includeSkillDirs: false }))
    } finally {
      console.error = originalConsoleError
    }
    assert.deepEqual(consoleCalls, [])
  })
})

test('apply: stderrMirror: true also writes the summary to console.error', () => {
  withTmp(dir => {
    const userCommands = join(dir, 'commands')
    mkdirSync(userCommands, { recursive: true })
    writeFileSync(join(userCommands, 'a.md'), 'A body.')
    const { ctx } = fakeCtx()
    const originalConsoleError = console.error
    const consoleCalls = []
    console.error = message => consoleCalls.push(message)
    try {
      apply(ctx, resolvedConfig({ userCommandDir: userCommands, includeSkillDirs: false, stderrMirror: true }))
    } finally {
      console.error = originalConsoleError
    }
    assert.ok(consoleCalls.some(line => line.includes('registered 1 command') && line.includes('a')))
  })
})
