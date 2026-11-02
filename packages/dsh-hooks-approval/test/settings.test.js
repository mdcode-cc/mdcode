import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectHookGroups } from '@deepseek-ai/dsh-hook-protocol'
import { loadApprovalHookConfig, parseApprovalHookConfig } from '../lib/settings.js'

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-approval-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('parseApprovalHookConfig: reads PermissionRequest and SessionEnd only, ignores PreToolUse', () => {
  const { config, skipped } = parseApprovalHookConfig({
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pretool' }] }],
      PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pr', timeout: 30 }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'echo se' }] }],
    },
  })
  assert.equal(config.PreToolUse, undefined)
  assert.deepEqual(config.PermissionRequest, [{ matcher: 'Bash', hooks: [{ command: 'echo pr', timeoutSec: 30 }] }])
  assert.deepEqual(config.SessionEnd, [{ hooks: [{ command: 'echo se' }] }])
  assert.deepEqual(skipped, [])
})

test('parseApprovalHookConfig: SessionEnd matcher is always discarded (no subject to match)', () => {
  const { config } = parseApprovalHookConfig({
    hooks: { SessionEnd: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo se' }] }] },
  })
  assert.equal(config.SessionEnd[0].matcher, undefined)
})

test('parseApprovalHookConfig: non-command hooks are skipped and reported', () => {
  const { config, skipped } = parseApprovalHookConfig({
    hooks: { PermissionRequest: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] },
  })
  assert.equal(config.PermissionRequest, undefined)
  assert.deepEqual(skipped, [{ event: 'PermissionRequest', type: 'prompt' }])
})

test('parseApprovalHookConfig: accepts a bare event map (no outer `hooks` key)', () => {
  const { config } = parseApprovalHookConfig({
    PermissionRequest: [{ hooks: [{ type: 'command', command: 'echo bare' }] }],
  })
  assert.deepEqual(config.PermissionRequest, [{ hooks: [{ command: 'echo bare' }] }])
})

test('parseApprovalHookConfig: an invalid PermissionRequest matcher regex throws', () => {
  assert.throws(
    () => parseApprovalHookConfig({ hooks: { PermissionRequest: [{ matcher: '(', hooks: [{ type: 'command', command: 'x' }] }] } }),
    SyntaxError,
  )
})

test('parseApprovalHookConfig: malformed input (not an object) returns empty config', () => {
  assert.deepEqual(parseApprovalHookConfig(null), { config: {}, skipped: [] })
  assert.deepEqual(parseApprovalHookConfig('nope'), { config: {}, skipped: [] })
})

test('loadApprovalHookConfig: reads a real settings.json file from disk', () => {
  withTmp(dir => {
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'echo ok' }] }] },
    }))
    const { config } = loadApprovalHookConfig(settingsPath)
    assert.deepEqual(config.PermissionRequest, [{ hooks: [{ command: 'echo ok' }] }])
  })
})

test('matcher selection: same semantics as the bridge (selectHookGroups, claude-code mode)', () => {
  const { config } = parseApprovalHookConfig({
    hooks: {
      PermissionRequest: [
        { matcher: 'Bash|Write', hooks: [{ type: 'command', command: 'echo matched' }] },
        { matcher: 'Read', hooks: [{ type: 'command', command: 'echo not-matched' }] },
      ],
    },
  })
  const selected = selectHookGroups(config.PermissionRequest, 'Bash', 'claude-code')
  assert.equal(selected.length, 1)
  assert.equal(selected[0].hooks[0].command, 'echo matched')
})
