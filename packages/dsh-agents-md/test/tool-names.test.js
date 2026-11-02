import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toDshToolNames, CC_TO_DSH_TOOL_NAMES, NO_DSH_EQUIVALENT } from '../lib/tool-names.js'

test('maps every CC name in the table to at least one dsh name', () => {
  for (const [ccName, dshNames] of Object.entries(CC_TO_DSH_TOOL_NAMES)) {
    assert.ok(Array.isArray(dshNames) && dshNames.length > 0, `${ccName}: expected a non-empty mapping`)
  }
})

test('Read maps to both the text and image fs tools', () => {
  const warned = []
  assert.deepEqual(toDshToolNames(['Read'], (n) => warned.push(n)), ['read', 'read_image'])
  assert.deepEqual(warned, [])
})

test('Grep and Glob map to the fs-search tool names', () => {
  const warned = []
  assert.deepEqual(toDshToolNames(['Grep', 'Glob'], (n) => warned.push(n)), ['grep', 'glob'])
  assert.deepEqual(warned, [])
})

test('duplicate dsh names across CC names are deduplicated', () => {
  const warned = []
  // NotebookEdit and Edit both map to "edit".
  assert.deepEqual(toDshToolNames(['Edit', 'NotebookEdit'], (n) => warned.push(n)), ['edit'])
  assert.deepEqual(warned, [])
})

test('an unknown CC name is dropped and reported via warnUnknown', () => {
  const warned = []
  assert.deepEqual(toDshToolNames(['Read', 'TotallyMadeUpTool'], (n) => warned.push(n)), ['read', 'read_image'])
  assert.deepEqual(warned, ['TotallyMadeUpTool'])
})

test('an empty list maps to an empty list (no restriction stays no restriction)', () => {
  const warned = []
  assert.deepEqual(toDshToolNames([], (n) => warned.push(n)), [])
  assert.deepEqual(warned, [])
})

test("Claude Code's three task-tracker tools fold into dsh's single todo_write", () => {
  const warned = []
  assert.deepEqual(toDshToolNames(['TaskCreate', 'TaskUpdate', 'TaskList'], (n) => warned.push(n)), ['todo_write'])
  assert.deepEqual(warned, [])
})

test('AskUserQuestion maps to ask_user_question', () => {
  const warned = []
  assert.deepEqual(toDshToolNames(['AskUserQuestion'], (n) => warned.push(n)), ['ask_user_question'])
  assert.deepEqual(warned, [])
})

test('BashOutput and KillShell map to the dsh-tool-jobs tool names', () => {
  const warned = []
  assert.deepEqual(toDshToolNames(['BashOutput', 'KillShell'], (n) => warned.push(n)), ['job_output', 'job_kill'])
  assert.deepEqual(warned, [])
})

test('ExitPlanMode maps to exit_plan_mode', () => {
  const warned = []
  assert.deepEqual(toDshToolNames(['ExitPlanMode'], (n) => warned.push(n)), ['exit_plan_mode'])
  assert.deepEqual(warned, [])
})

test('SlashCommand has no dsh equivalent and is dropped silently, no warn', () => {
  const warned = []
  assert.deepEqual(toDshToolNames(['Read', 'SlashCommand'], (n) => warned.push(n)), ['read', 'read_image'])
  assert.deepEqual(warned, [], 'a known-but-unmapped name must not call warnUnknown')
  assert.ok(NO_DSH_EQUIVALENT.has('SlashCommand'))
})
