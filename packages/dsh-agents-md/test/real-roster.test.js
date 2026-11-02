/**
 * Read-only pass over whatever real agent roster exists on this machine.
 * Reads outside the repo (`~/.claude/agents`); never writes anything. Skips
 * when that directory is absent (e.g. CI, a clean checkout) and never
 * prints file names or file contents — only counts and generic reasons.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseAgentFile } from '../lib/parse.js'
import { listAgentFiles } from '../lib/roots.js'

const userDir = path.join(os.homedir(), '.claude', 'agents')
const skipReason = `skipped: ${userDir} not present on this machine`

test('every real agent file in ~/.claude/agents parses with its declared model and tools', { skip: !fs.existsSync(userDir) && skipReason }, () => {
  const files = listAgentFiles(userDir)
  assert.ok(files.length >= 1, `expected at least one real agent file, found ${files.length}`)

  for (const filePath of files) {
    const stem = path.basename(filePath, '.md')
    const raw = fs.readFileSync(filePath, 'utf8')
    const result = parseAgentFile(raw, stem)
    assert.equal(result.ok, true, `a real agent file failed to parse: ${result.ok ? '' : result.error}`)
    assert.equal(result.descriptor.name, stem)
    assert.ok(result.descriptor.description.length > 0)

    // Every real file declares `tools:`.
    assert.ok(Array.isArray(result.descriptor.tools), 'tools must be an array')
    assert.ok(result.descriptor.tools.length > 0, 'expected at least one tool')

    // Not every real file declares `model:` — some rely on the plugin's
    // configured defaultModel instead.
    const declaresModel = /^model:/m.test(raw)
    if (declaresModel) {
      assert.equal(typeof result.descriptor.model, 'string', 'expected a declared model')
      assert.ok(result.descriptor.model.length > 0)
    } else {
      assert.equal(result.descriptor.model, undefined, 'expected no model (falls back to defaultModel)')
    }
  }
})
