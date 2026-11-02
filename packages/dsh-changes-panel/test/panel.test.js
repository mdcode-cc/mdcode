import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChangesPanel, truncateLeft } from '../lib/panel.js'

/** A minimal fake React: createElement records a plain tree node;
 * useState/useEffect/useMemo/useSyncExternalStore are real-enough stubs
 * (single render pass, no scheduler) to drive the component without a
 * real renderer. Good enough to assert on the recorded tree and on which
 * arguments the panel's own hooks were called with. */
function fakeReact() {
  const effects = []
  function createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat().filter(c => c !== null && c !== undefined) }
  }
  function useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  }
  function useEffect(fn) {
    effects.push(fn)
  }
  function useMemo(fn) {
    return fn()
  }
  function useSyncExternalStore(subscribe, getSnapshot) {
    return getSnapshot()
  }
  return { createElement, useState, useEffect, useMemo, useSyncExternalStore, effects }
}

function fakeUi(animationTimeValues = []) {
  const animationTimeCalls = []
  let callIndex = 0
  return {
    Box: 'Box',
    Text: 'Text',
    Image: 'Image',
    ScrollBox: 'ScrollBox',
    Divider: 'Divider',
    useAnimationTime(ms) {
      animationTimeCalls.push(ms)
      const value = animationTimeValues[callIndex] ?? null
      callIndex += 1
      return value
    },
    useTheme() {
      return { colors: {} }
    },
    animationTimeCalls,
  }
}

function fakeWatcher(snapshot) {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: async () => {},
    setCwd: () => {},
  }
}

function fakeHost(cwd = '/repo') {
  return { snapshot: () => ({ cwd }), focused: true }
}

function renderOnce(component, { React, ui, host, width = 60, height = 20, visible = true, mode = 'split' }) {
  const element = component({ React, ui, host, width, height, visible, focused: true, mode })
  // Run effects once, mimicking a mount commit.
  for (const effect of React.effects) effect()
  return element
}

test('truncateLeft keeps the basename when truncating a long path', () => {
  const out = truncateLeft('packages/dsh-changes-panel/lib/git-status.js', 20)
  assert.ok(out.length <= 20)
  assert.ok(out.endsWith('git-status.js'))
  assert.ok(out.startsWith('…'))
})

test('truncateLeft is a no-op under the width limit', () => {
  assert.equal(truncateLeft('short.js', 20), 'short.js')
})

for (const [label, snapshot] of [
  ['loading', { loading: true }],
  ['non-repo', { ok: true, repo: false, loading: false }],
  ['error', { ok: false, error: 'boom', loading: false }],
  ['empty', { ok: true, repo: true, loading: false, branch: 'main', staged: [], unstaged: [], untracked: [], totals: { files: 0, added: 0, deleted: 0 }, truncated: 0 }],
  ['populated', { ok: true, repo: true, loading: false, branch: 'main',
    staged: [{ path: 'a.js', display: 'a.js', x: 'M', y: ' ', added: 2, deleted: 1, binary: false }],
    unstaged: [{ path: 'b.js', display: 'b.js', x: ' ', y: 'M', added: 1, deleted: 0, binary: false }],
    untracked: [{ path: 'c.js', display: 'c.js', x: '?', y: '?', added: 0, deleted: 0, binary: false }],
    totals: { files: 3, added: 3, deleted: 1 }, truncated: 0 }],
  ['truncated', { ok: true, repo: true, loading: false, branch: 'main',
    staged: [], unstaged: [], untracked: [{ path: 'x.js', display: 'x.js', x: '?', y: '?', added: 0, deleted: 0, binary: false }],
    totals: { files: 1, added: 0, deleted: 0 }, truncated: 5 }],
]) {
  test(`panel renders without throwing: ${label}`, () => {
    const React = fakeReact()
    const ui = fakeUi()
    const watcher = fakeWatcher(snapshot)
    const component = createChangesPanel({ watcher, config: { refreshMs: 2000 } })
    assert.doesNotThrow(() => renderOnce(component, { React, ui, host: fakeHost() }))
  })
}

test('panel passes null to useAnimationTime when visible is false', () => {
  const React = fakeReact()
  const ui = fakeUi()
  const watcher = fakeWatcher({ ok: true, repo: true, loading: false, branch: 'main', staged: [], unstaged: [], untracked: [], totals: { files: 0, added: 0, deleted: 0 }, truncated: 0 })
  const component = createChangesPanel({ watcher, config: { refreshMs: 1234 } })
  renderOnce(component, { React, ui, host: fakeHost(), visible: false })
  assert.deepEqual(ui.animationTimeCalls, [null])
})

test('panel passes config.refreshMs to useAnimationTime when visible is true', () => {
  const React = fakeReact()
  const ui = fakeUi()
  const watcher = fakeWatcher({ ok: true, repo: true, loading: false, branch: 'main', staged: [], unstaged: [], untracked: [], totals: { files: 0, added: 0, deleted: 0 }, truncated: 0 })
  const component = createChangesPanel({ watcher, config: { refreshMs: 1234 } })
  renderOnce(component, { React, ui, host: fakeHost(), visible: true })
  assert.deepEqual(ui.animationTimeCalls, [1234])
})

test('panel never throws when host.snapshot() returns undefined', () => {
  const React = fakeReact()
  const ui = fakeUi()
  const watcher = fakeWatcher({ ok: true, repo: true, loading: false, branch: 'main', staged: [], unstaged: [], untracked: [], totals: { files: 0, added: 0, deleted: 0 }, truncated: 0 })
  const component = createChangesPanel({ watcher, config: { refreshMs: 2000 } })
  const host = { snapshot: () => undefined }
  assert.doesNotThrow(() => renderOnce(component, { React, ui, host }))
})

test('panel never throws when host.snapshot() throws', () => {
  const React = fakeReact()
  const ui = fakeUi()
  const watcher = fakeWatcher({ ok: true, repo: true, loading: false, branch: 'main', staged: [], unstaged: [], untracked: [], totals: { files: 0, added: 0, deleted: 0 }, truncated: 0 })
  const component = createChangesPanel({ watcher, config: { refreshMs: 2000 } })
  const host = { snapshot: () => { throw new Error('nope') } }
  assert.doesNotThrow(() => renderOnce(component, { React, ui, host }))
})

test('panel falls back to useState/useEffect subscription when useSyncExternalStore is absent', () => {
  const React = fakeReact()
  delete React.useSyncExternalStore
  const ui = fakeUi()
  const snapshot = { ok: true, repo: true, loading: false, branch: 'main', staged: [], unstaged: [], untracked: [], totals: { files: 0, added: 0, deleted: 0 }, truncated: 0 }
  const watcher = fakeWatcher(snapshot)
  const component = createChangesPanel({ watcher, config: { refreshMs: 2000 } })
  assert.doesNotThrow(() => renderOnce(component, { React, ui, host: fakeHost() }))
})
