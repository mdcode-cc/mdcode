/**
 * Validate `lib/inherit-plugins-reference.js` against the real packages'
 * own `Config` schemas (schemastery throws on a missing required field with
 * no default). This is how the "every preset fails activation" class of bug
 * is caught before a real host mount: a config gap here throws here too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { referenceInheritPlugins } from '../lib/inherit-plugins-reference.js'

// profiles/cc/cordis.patch.yml is the thing lib/inherit-plugins-reference.js
// claims to mirror — read-only, never written by this package.
const profilePatchPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../profiles/cc/cordis.patch.yml')

const CONFIG_LOADERS = {
  '@deepseek-ai/dsh-tool-fs': async () => (await import('@deepseek-ai/dsh-tool-fs')).Config,
  '@deepseek-ai/dsh-tool-fs-search': async () => (await import('@deepseek-ai/dsh-tool-fs-search')).Config,
  '@deepseek-ai/dsh-tool-bash': async () => (await import('@deepseek-ai/dsh-tool-bash')).Config,
  '@deepseek-ai/dsh-tool-todo': async () => (await import('@deepseek-ai/dsh-tool-todo')).Config,
  '@deepseek-ai/dsh-tool-skill': async () => (await import('@deepseek-ai/dsh-tool-skill')).Config,
  '@deepseek-ai/dsh-skill-filesystem': async () => (await import('@deepseek-ai/dsh-skill-filesystem')).Config,
  '@deepseek-ai/dsh-tool-ask-user': async () => (await import('@deepseek-ai/dsh-tool-ask-user')).Config,
  '@deepseek-ai/dsh-compaction-tool-result-pruner': async () => (await import('@deepseek-ai/dsh-compaction-tool-result-pruner')).default.Config,
  '@deepseek-ai/dsh-compaction-basic': async () => (await import('@deepseek-ai/dsh-compaction-basic')).default.Config,
}

/** Flatten `cordis:group` rows; they carry no Config of their own. */
function flattenRows(rows) {
  const out = []
  for (const row of rows) {
    if (row.group === true) {
      out.push(...flattenRows(row.config))
    } else {
      out.push(row)
    }
  }
  return out
}

test('every referenceInheritPlugins row satisfies its package Config schema', async () => {
  const rows = flattenRows(referenceInheritPlugins)
  assert.ok(rows.length >= 9, `expected at least 9 flattened rows, found ${rows.length}`)

  for (const row of rows) {
    const loadConfig = CONFIG_LOADERS[row.name]
    assert.ok(loadConfig !== undefined, `no Config loader registered for "${row.name}" — add one to this test`)
    const Config = await loadConfig()
    assert.doesNotThrow(
      () => Config(row.config ?? {}),
      (error) => { throw new Error(`${row.name}: ${error.message}`) },
    )
  }
})

test('dsh-tool-fs-search and dsh-tool-todo reject an empty config (the bug this fix catches)', async () => {
  const fsSearchConfig = (await import('@deepseek-ai/dsh-tool-fs-search')).Config
  const todoConfig = (await import('@deepseek-ai/dsh-tool-todo')).Config
  assert.throws(() => fsSearchConfig({}), /sampleOverCapGlobResults/)
  assert.throws(() => todoConfig({}), /allowParallelInProgress/)
})

test(
  'referenceInheritPlugins matches the live inheritPlugins rows in profiles/cc/cordis.patch.yml',
  { skip: !fs.existsSync(profilePatchPath) },
  () => {
    const raw = fs.readFileSync(profilePatchPath, 'utf8')
    // The full patch file is one YAML document mixing plain rows and `!!js`
    // expression scalars elsewhere; entryListSchema (the same schema
    // dsh-agent-preset-registry's own Loader uses to read this dialect)
    // parses `!!js` without executing it, so this never runs profile code.
    const topLevel = yaml.load(raw, { schema: entryListSchema })
    assert.ok(Array.isArray(topLevel), 'expected the patch file to parse as a top-level list')

    let ccAgentsMdRow
    for (const entry of topLevel) {
      const insertRows = entry?.insert
      if (!Array.isArray(insertRows)) continue
      const found = insertRows.find((row) => row.id === 'cc-agents-md')
      if (found !== undefined) ccAgentsMdRow = found
    }
    assert.ok(ccAgentsMdRow !== undefined, 'expected an `insert:` row with id: cc-agents-md in profiles/cc/cordis.patch.yml')

    const liveInheritPlugins = ccAgentsMdRow.config?.inheritPlugins
    assert.ok(Array.isArray(liveInheritPlugins), 'expected cc-agents-md.config.inheritPlugins to be a list')
    assert.deepEqual(
      liveInheritPlugins,
      referenceInheritPlugins,
      'lib/inherit-plugins-reference.js has drifted from the profile it claims to mirror — update whichever one is stale',
    )
  },
)
