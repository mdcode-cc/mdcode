/**
 * Scan-and-diff logic, kept free of `ctx` so it is cheaply unit-testable:
 * `collectEntries` turns disk state into a name->entry map, `reconcile`
 * diffs that map against the live registrations and tells the caller what
 * to register/unregister.
 */

import { readEntry } from './parse.js'
import { listRoots } from './roots.js'

/**
 * One scan pass. `attempted` carries every stem seen on disk (parse success
 * or failure) so `reconcile` can tell "file still there but unparseable"
 * (keep the previous good registration) from "file genuinely gone" (drop it).
 */
export function collectEntries(config, cwd, warn) {
  const entries = new Map()
  const attempted = new Set()
  for (const candidate of listRoots(config, cwd)) {
    attempted.add(candidate.stem)
    const result = readEntry(candidate.file, candidate.stem, candidate.kind, config)
    if (!result.ok) {
      if (result.reason !== 'not-user-invocable') warn(`${candidate.file}: ${result.reason}`)
      continue
    }
    entries.set(result.entry.name, result.entry)
  }
  return { entries, attempted }
}

function stripPrefix(name, prefix) {
  return prefix !== '' && name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/** Identity of an entry's registrable content — everything except `filePath` (so moving/renaming the source file without changing its content is not a "change"). */
export function entrySignature(entry) {
  const { filePath, ...rest } = entry
  return JSON.stringify(rest)
}

/**
 * Diff `entries` (this scan's survivors) against `live` (name -> {entry,
 * unregister, signature}) and apply `register`/unregister as needed.
 *
 * - Unchanged entry (same signature, i.e. identical content apart from
 *   `filePath`): left alone.
 * - New or changed entry: unregister the old row (if any), register the new one.
 * - A `register` throw (name collision) is caught per-entry: the old row, if
 *   any, is kept; the rest of the scan continues.
 * - Entry no longer producible (name vanished from `entries`): unregistered
 *   only if its file is also gone from `attempted` — a file that is still on
 *   disk but failed to parse this pass keeps its last-good registration.
 *
 * @returns `{live, registeredNames}` — the new live map and the names registered this pass.
 */
export function reconcile({ config, live, entries, attempted, register, warn }) {
  const next = new Map()
  const registeredNames = []

  for (const [rawName, entry] of entries) {
    const commandName = `${config.namePrefix}${rawName}`
    if (config.skipNames.includes(rawName) || config.skipNames.includes(commandName)) {
      warn(`skipping "${commandName}" (in skipNames)`)
      continue
    }
    const current = live.get(commandName)
    const signature = entrySignature(entry)
    if (current !== undefined && current.signature === signature) {
      next.set(commandName, current)
      registeredNames.push(commandName)
      continue
    }
    // Unregister before re-registering: the name is still held by `current`
    // and a same-name `register` would otherwise collide with itself.
    if (current !== undefined) current.unregister()
    try {
      const unregister = register(commandName, entry)
      next.set(commandName, { entry, unregister, signature })
      registeredNames.push(commandName)
    } catch (error) {
      // `current` (if any) is already unregistered above — there is nothing
      // good left to keep. This file's command is simply not registered
      // until the next successful scan. Our own parse-time grammar check
      // mirrors the host's (`dsh-commands`'s `COMMAND_NAME`), but `namePrefix`
      // is applied AFTER that check and can still produce an invalid final
      // name (e.g. a prefix starting with a digit) — distinguish that from
      // an actual name collision with a different, accurate message.
      const message = String(error?.message ?? error)
      if (/must match/.test(message)) {
        warn(`"${commandName}" (${entry.filePath}) is not a valid command name, skipped: ${message}`)
      } else {
        warn(`"${commandName}" (${entry.filePath}) collides with an existing command, skipped: ${message}`)
      }
    }
  }

  for (const [commandName, record] of live) {
    if (next.has(commandName)) continue
    if (attempted.has(stripPrefix(commandName, config.namePrefix))) {
      next.set(commandName, record) // still on disk, just unparseable this pass
    } else {
      record.unregister() // file is genuinely gone
    }
  }

  return { live: next, registeredNames }
}
