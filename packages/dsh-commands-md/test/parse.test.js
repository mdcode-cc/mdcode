import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter, parseBoolean, readEntry } from '../lib/parse.js'

const CONFIG = { maxBodyBytes: 131072 }

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-commands-md-parse-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('parseFrontmatter: no frontmatter block is legal', () => {
  const { attrs, body } = parseFrontmatter('Just a body.\nSecond line.\n')
  assert.deepEqual(attrs, {})
  assert.equal(body, 'Just a body.\nSecond line.\n')
})

test('parseFrontmatter: scalars, quoted strings, inline arrays, nested block', () => {
  const raw = [
    '---',
    'name: build',
    'description: Plan and build a work item.',
    'argument-hint: "<path>"',
    'arguments: [item]',
    'allowed-tools: Agent, Bash, Read',
    'disable-model-invocation: true',
    'requires:',
    '  bins: ["sentry"]',
    '  auth: true',
    '---',
    'Body text.',
  ].join('\n')
  const { attrs, body } = parseFrontmatter(raw)
  assert.equal(attrs.name, 'build')
  assert.equal(attrs.description, 'Plan and build a work item.')
  assert.equal(attrs['argument-hint'], '<path>')
  assert.deepEqual(attrs.arguments, ['item'])
  assert.equal(attrs['allowed-tools'], 'Agent, Bash, Read')
  assert.equal(attrs['disable-model-invocation'], 'true')
  assert.deepEqual(attrs.requires, { nested: true })
  assert.equal(body, 'Body text.')
})

test('parseBoolean: accepts the documented spellings, rejects anything else', () => {
  for (const word of ['true', 'TRUE', 'yes', 'on', '1']) assert.equal(parseBoolean(word), true)
  for (const word of ['false', 'FALSE', 'no', 'off', '0']) assert.equal(parseBoolean(word), false)
  assert.equal(parseBoolean('nah'), undefined)
  assert.equal(parseBoolean(42), undefined)
})

test('readEntry: no-frontmatter file derives name from filename, description from first line', () => {
  withTmp(dir => {
    const file = join(dir, 'devkit.md')
    writeFileSync(file, 'Set up dev tools.\n\nMore body.\n')
    const result = readEntry(file, 'devkit', 'command', CONFIG)
    assert.equal(result.ok, true)
    assert.equal(result.entry.name, 'devkit')
    assert.equal(result.entry.description, 'Set up dev tools.')
    assert.equal(result.entry.hint, undefined)
    assert.deepEqual(result.entry.argNames, [])
  })
})

test('readEntry: frontmatter name must match the file stem', () => {
  withTmp(dir => {
    const file = join(dir, 'build.md')
    writeFileSync(file, '---\nname: ship\ndescription: x\n---\nbody')
    const result = readEntry(file, 'build', 'command', CONFIG)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'name-mismatch')
  })
})

test('readEntry: invalid name per host grammar is rejected', () => {
  withTmp(dir => {
    const file = join(dir, 'My_Command.md')
    writeFileSync(file, '---\ndescription: x\n---\nbody')
    const result = readEntry(file, 'My_Command', 'command', CONFIG)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid-name')
  })
})

test('readEntry: name must START with a letter, exactly the host\'s /^[a-z][a-z0-9_-]*$/u', () => {
  // dsh-commands/lib/index.js's COMMAND_NAME requires a leading letter —
  // our own check must reject the same names BEFORE they ever reach
  // ctx.commands.register(), or the host throws a TypeError our registry
  // layer would otherwise mislabel as a name collision.
  withTmp(dir => {
    for (const stem of ['1build', '-build', '_build']) {
      const file = join(dir, `${stem}.md`)
      writeFileSync(file, '---\ndescription: x\n---\nbody')
      const result = readEntry(file, stem, 'command', CONFIG)
      assert.equal(result.ok, false, `expected "${stem}" to be rejected`)
      assert.equal(result.reason, 'invalid-name')
    }
  })
})

test('readEntry: missing description and empty body is rejected', () => {
  withTmp(dir => {
    const file = join(dir, 'empty.md')
    writeFileSync(file, '   \n\n   ')
    const result = readEntry(file, 'empty', 'command', CONFIG)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no-description')
  })
})

test('readEntry: over-cap body is rejected, never truncated', () => {
  withTmp(dir => {
    const file = join(dir, 'big.md')
    writeFileSync(file, `First line.\n${'x'.repeat(50)}`)
    const result = readEntry(file, 'big', 'command', { maxBodyBytes: 10 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'body-too-large')
  })
})

test('readEntry: SKILL.md directory form takes its name from the directory', () => {
  withTmp(dir => {
    const skillDir = join(dir, 'intake')
    mkdirSync(skillDir)
    const file = join(skillDir, 'SKILL.md')
    writeFileSync(file, '---\ndescription: Turn an ask into a work item.\n---\nBody.')
    const result = readEntry(file, 'intake', 'skill', CONFIG)
    assert.equal(result.ok, true)
    assert.equal(result.entry.name, 'intake')
  })
})

test('readEntry: skill with user-invocable: false is rejected (not registered)', () => {
  withTmp(dir => {
    const file = join(dir, 'hidden.md')
    writeFileSync(file, '---\ndescription: x\nuser-invocable: false\n---\nbody')
    const result = readEntry(file, 'hidden', 'skill', CONFIG)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-user-invocable')
  })
})

test('readEntry: disable-model-invocation: true is still registered (human-invocable)', () => {
  withTmp(dir => {
    const file = join(dir, 'daily-review.md')
    writeFileSync(file, '---\ndescription: x\ndisable-model-invocation: true\n---\nbody')
    const result = readEntry(file, 'daily-review', 'skill', CONFIG)
    assert.equal(result.ok, true)
    assert.equal(result.entry.disableModelInvocation, true)
  })
})

test('readEntry: empty argument-hint ("") normalizes to no hint at all', () => {
  // Regression: the real host's ctx.commands.register() throws "input hint
  // must not be empty" for input: {hint: ''} — found via a real headless
  // boot against daily-review/SKILL.md and restore-prod-db/SKILL.md, which
  // both declare `argument-hint: ""` for "takes no arguments".
  withTmp(dir => {
    const file = join(dir, 'daily-review.md')
    writeFileSync(file, '---\ndescription: x\nargument-hint: ""\n---\nbody')
    const result = readEntry(file, 'daily-review', 'command', CONFIG)
    assert.equal(result.ok, true)
    assert.equal(result.entry.hint, undefined)
  })
})

test('readEntry: invalid disable-model-invocation spelling drops the whole entry', () => {
  withTmp(dir => {
    const file = join(dir, 'x.md')
    writeFileSync(file, '---\ndescription: x\ndisable-model-invocation: maybe\n---\nbody')
    const result = readEntry(file, 'x', 'command', CONFIG)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'invalid-disable-model-invocation')
  })
})
