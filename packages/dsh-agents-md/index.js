/**
 * @mdcode-cc/dsh-agents-md — one dsh agent preset per Claude-Code-style agent
 * markdown file (`~/.claude/agents/*.md`, `<project>/.claude/agents/*.md`).
 * Publishes the parsed roster as `ctx.agentsMd`. See ./README.md for the spec.
 */

import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { buildRoster, createCatalog } from './lib/catalog.js'
import { resolveRoots } from './lib/roots.js'
import { buildPresetDefinition } from './lib/preset.js'

export const name = 'dsh-agents-md'
export const inject = ['agentPresets']

const WATCH_DEBOUNCE_MS = 200

export const Config = z.object({
  userDir: z.string().description('User-level agent directory.').default('~/.claude/agents'),
  projectDirName: z.string().description('Project-relative agent directory.').default('.claude/agents'),
  extraDirs: z.array(z.string()).description('Extra roots, highest precedence last.').default([]),
  watch: z.boolean().description('Re-register presets when a file changes.').default(true),
  maxPromptBytes: z.natural().description('Cap on one agent body; a longer body is rejected, never truncated.').default(65536),
  defaultModel: z.union(['haiku', 'sonnet', 'opus']).description('Tier for an agent with no model key.').default('sonnet'),
  presetIdPrefix: z.string().description('Prefix for registered preset ids.').default('cc-'),
  inheritPlugins: z.array(z.any()).description('Cordis entry rows every generated preset mounts beneath its persona.').default([]),
})

// Reads the host filesystem directly with node:fs, not the ctx.get('fs')
// harness seam: that service is fully async (dsh-fs/lib/types/index.d.ts has
// no *Sync methods), so a sync branch on it could never run. See README
// "Behaviour".
function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

export async function apply(ctx, config) {
  const mounted = new Map() // name -> { descriptor, filePath, presetId, dispose }
  const watchers = []
  let debounceTimer = null
  let pendingReconcile = Promise.resolve()
  const warn = (message) => ctx.logger.warn(`dsh-agents-md: ${message}`)
  const { catalog, bump } = createCatalog(mounted, (id) => ctx.agentPresets.resolve(id), warn)
  const warnedUnknownTools = new Set()
  const warnUnknownTool = (ccName) => {
    if (warnedUnknownTools.has(ccName)) return
    warnedUnknownTools.add(ccName)
    warn(`unknown tool "${ccName}" has no dsh mapping (lib/tool-names.js); dropped from dshTools`)
  }

  // Registered before any await, so a later throw (e.g. ctx.provide) still
  // disposes whatever got mounted up to that point instead of leaking.
  ctx.effect(() => async () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    for (const watcher of watchers) watcher.close()
    await pendingReconcile.catch(() => {})
    for (const { dispose } of mounted.values()) await dispose()
    mounted.clear()
  }, 'dsh-agents-md')

  async function registerOne(name, descriptor, filePath) {
    const def = buildPresetDefinition(descriptor, config)
    try {
      const dispose = await ctx.agentPresets.register(def)
      mounted.set(name, { descriptor, filePath, presetId: def.id, dispose })
    } catch (error) {
      warn(`preset "${def.id}" failed to register: ${error.message}`)
    }
  }

  async function reconcile() {
    const roster = buildRoster(readFile, config, mounted, warn, warnUnknownTool)
    let changed = false

    for (const name of [...mounted.keys()]) {
      if (!roster.has(name)) {
        changed = true
        await mounted.get(name).dispose()
        mounted.delete(name)
      }
    }
    for (const [name, { descriptor, filePath }] of roster) {
      const current = mounted.get(name)
      if (current !== undefined && current.filePath === filePath && JSON.stringify(current.descriptor) === JSON.stringify(descriptor)) continue
      changed = true
      if (current !== undefined) await current.dispose()
      mounted.delete(name)
      await registerOne(name, descriptor, filePath)
    }
    if (changed) bump()
  }

  await reconcile()
  ctx.logger.info(`dsh-agents-md: registered ${mounted.size} preset(s): ${[...mounted.keys()].sort().join(', ') || '(none)'}`)

  if (config.watch) {
    const onFsEvent = () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        // Serialised: a second fs event firing mid-reconcile queues behind it
        // instead of running concurrently, which could otherwise hit the
        // registry's "Duplicate agent preset" guard or drop a disposer.
        pendingReconcile = pendingReconcile.then(() => reconcile()).catch((error) => warn(`reload failed: ${error.message}`))
      }, WATCH_DEBOUNCE_MS)
    }
    for (const dir of resolveRoots(config)) {
      try {
        // persistent: false — a one-shot headless run must still be able to exit.
        watchers.push(fs.watch(dir, { persistent: false }, onFsEvent))
      } catch {
        // Root does not exist (yet); nothing to watch there.
      }
    }
  }

  ctx.provide('agentsMd', catalog)
}

export default { name, Config, inject, apply }
