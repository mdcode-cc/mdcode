/**
 * Scan every root into a roster, keeping a mounted agent's last-good
 * descriptor when its file regresses to unparseable (spec: "a file that
 * becomes unparseable keeps the last good descriptor"), and the live,
 * read-time catalog view (`ctx.agentsMd`).
 */

import path from 'node:path'
import { parseAgentFile } from './parse.js'
import { resolveRoots, listAgentFiles } from './roots.js'
import { toDshToolNames } from './tool-names.js'

/** Read and parse every top-level `*.md` across all roots, precedence order. */
function scanFiles(readFile, config) {
  const files = []
  for (const dir of resolveRoots(config)) {
    for (const filePath of listAgentFiles(dir)) {
      const stem = path.basename(filePath, '.md')
      let result
      try {
        result = parseAgentFile(readFile(filePath), stem, config.maxPromptBytes)
      } catch (error) {
        result = { ok: false, error: `cannot read file: ${error.message}` }
      }
      files.push({ filePath, result })
    }
  }
  return files
}

/**
 * @param readFile `(filePath) => string`
 * @param config plugin config (roots + maxPromptBytes + defaultModel)
 * @param mounted current `name -> { descriptor, filePath }` map
 * @param warn `(message) => void`
 * @param warnUnknownTool `(ccName) => void` — a CC tool name with no entry in
 *   `lib/tool-names.js`; called once per unknown name by the caller's own
 *   dedup, not here (see `index.js`).
 * @returns `name -> { descriptor, filePath }`, later roots shadowing earlier ones
 */
export function buildRoster(readFile, config, mounted, warn, warnUnknownTool = () => {}) {
  const roster = new Map()
  const failedPaths = new Set()
  for (const { filePath, result } of scanFiles(readFile, config)) {
    if (!result.ok) {
      failedPaths.add(filePath)
      warn(`${filePath}: ${result.error}`)
      continue
    }
    const { descriptor: parsed } = result
    const descriptor = {
      ...parsed,
      // An agent file with no `model:` key inherits the plugin's configured tier.
      model: parsed.model ?? config.defaultModel,
      // Claude-Code tool names, normalized to the dsh names dsh-task-tool's
      // mask guard actually checks against (lib/tool-names.js). Originals
      // are kept untouched above.
      dshTools: toDshToolNames(parsed.tools, warnUnknownTool),
      dshDisallowedTools: toDshToolNames(parsed.disallowedTools, warnUnknownTool),
    }
    if (roster.has(descriptor.name)) warn(`"${descriptor.name}" redefined by ${filePath}`)
    roster.set(descriptor.name, { descriptor, filePath })
  }
  for (const [name, entry] of mounted) {
    if (!roster.has(name) && failedPaths.has(entry.filePath)) roster.set(name, entry)
  }
  return roster
}

/**
 * Build the live `ctx.agentsMd` view, plus a `bump()` the caller's own
 * `reconcile()` invokes on every change. Revision and change-notification
 * are owned here, not in `index.js`, so `onChange` and `revision` can never
 * drift apart. `bump` is returned SEPARATELY from the catalog — it is not
 * part of the published `ctx.agentsMd` shape, so a consumer calling
 * `ctx.agentsMd.bump()` is not a thing that can happen.
 *
 * The broken-activation check is a read-time filter, cached per revision:
 * `dsh-agent-preset-registry`'s `resolve()` can await the Host loader
 * settling once a mounted row is merely pending, and that must never happen
 * from inside this plugin's own `apply()` (one of the rows the loader is
 * settling). See README "Behaviour" / "Failure modes".
 * @param mounted `name -> { descriptor, presetId }`
 * @param resolvePreset `(presetId) => Promise<{id, broken?}>` — `ctx.agentPresets.resolve`
 * @param warn `(message) => void`
 * @returns `{ catalog, bump }`
 */
export function createCatalog(mounted, resolvePreset, warn) {
  let revision = 0
  let brokenCache = null // { revision, ids: Set<presetId> }
  const listeners = new Set()

  async function brokenPresetIds() {
    if (brokenCache !== null && brokenCache.revision === revision) return brokenCache.ids
    // Captured BEFORE the await: a bump() mid-flight must not stamp this
    // result as valid for the NEW revision — it was computed against
    // whatever `mounted` looked like at `at`, not at the live `revision`.
    const at = revision
    const ids = new Set()
    await Promise.all([...mounted.values()].map(async ({ presetId }) => {
      try {
        const status = await resolvePreset(presetId)
        if (status.broken !== undefined) {
          warn(`preset "${presetId}" failed to activate: ${status.broken}`)
          ids.add(presetId)
        }
      } catch (error) {
        warn(`preset "${presetId}" activation check failed: ${error.message}`)
      }
    }))
    brokenCache = { revision: at, ids }
    return ids
  }

  const catalog = {
    async list() {
      const broken = await brokenPresetIds()
      return [...mounted.values()].filter((m) => !broken.has(m.presetId)).map((m) => Object.freeze({ ...m.descriptor })).sort((a, b) => a.name.localeCompare(b.name))
    },
    async get(agentName) {
      const m = mounted.get(agentName)
      if (m === undefined) return undefined
      const broken = await brokenPresetIds()
      return broken.has(m.presetId) ? undefined : Object.freeze({ ...m.descriptor })
    },
    async presetId(agentName) {
      const m = mounted.get(agentName)
      if (m === undefined) return undefined
      const broken = await brokenPresetIds()
      return broken.has(m.presetId) ? undefined : m.presetId
    },
    get revision() { return revision },
    /** @param cb `(revision) => void`, called after every `bump()`. @returns disposer */
    onChange(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
  }

  /** Increment revision and notify every `onChange` listener. One listener throwing never blocks another. */
  function bump() {
    revision += 1
    for (const cb of listeners) {
      try {
        cb(revision)
      } catch (error) {
        warn(`agentsMd.onChange listener threw: ${error.message}`)
      }
    }
  }

  return { catalog, bump }
}
