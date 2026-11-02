import { test } from 'node:test'
import assert from 'node:assert/strict'
import { permissionRequestPayload, sessionEndPayload } from '../lib/payload.js'

test('permissionRequestPayload: fields present, tool_input from the pre-execute cache, tool_use_id = callId', () => {
  const payload = permissionRequestPayload({
    sessionId: 'sess-1',
    toolName: 'Bash',
    toolInput: { command: 'pwd' },
    callId: 'call-1',
    reason: 'tool "Bash" requires approval',
    cwd: '/tmp/project',
  })
  assert.deepEqual(payload, {
    session_id: 'sess-1',
    transcript_path: '',
    hook_event_name: 'PermissionRequest',
    cwd: '/tmp/project',
    tool_name: 'Bash',
    tool_input: { command: 'pwd' },
    tool_use_id: 'call-1',
    reason: 'tool "Bash" requires approval',
  })
})

test('permissionRequestPayload: missing tool_input (cache miss) defaults to {}', () => {
  const payload = permissionRequestPayload({ sessionId: 's', toolName: 'Bash', callId: 'c', cwd: '/tmp' })
  assert.deepEqual(payload.tool_input, {})
  assert.equal('reason' in payload, false)
})

test('permissionRequestPayload: missing sessionId defaults to empty string', () => {
  const payload = permissionRequestPayload({ toolName: 'Bash', callId: 'c', cwd: '/tmp' })
  assert.equal(payload.session_id, '')
})

test('sessionEndPayload: fields present, reason is always "other"', () => {
  const payload = sessionEndPayload({ sessionId: 'sess-1', cwd: '/tmp/project' })
  assert.deepEqual(payload, {
    session_id: 'sess-1',
    transcript_path: '',
    hook_event_name: 'SessionEnd',
    cwd: '/tmp/project',
    reason: 'other',
  })
})
