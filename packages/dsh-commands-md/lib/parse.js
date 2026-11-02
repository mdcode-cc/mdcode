/**
 * Frontmatter parsing and command-entry construction for one `.md` file.
 *
 * YAML-lite by design: only the shapes real command/skill files use — plain
 * scalars, quoted scalars, inline `[a, b]` arrays, and one level of nested
 * block (consumed but not parsed, e.g. a skill's `requires:` block). No YAML
 * dependency; this is not a general YAML parser.
 */

import { readFileSync } from 'node:fs'

/** Host grammar, exactly (`dsh-commands/lib/index.js`'s `COMMAND_NAME`): must start with a letter. */
const NAME_RE = /^[a-z][a-z0-9_-]*$/u

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])

/** Accepts YAML booleans plus true/false, yes/no, on/off, 1/0 (case-insensitive). */
export function parseBoolean(raw) {
  if (typeof raw !== 'string') return undefined
  const lower = raw.toLowerCase()
  if (TRUE_WORDS.has(lower)) return true
  if (FALSE_WORDS.has(lower)) return false
  return undefined
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

function parseScalarOrArray(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map(part => unquote(part.trim()))
  }
  return unquote(trimmed)
}

/**
 * Split `raw` into `{attrs, body}`. No leading `---` frontmatter block is
 * legal — `attrs` is then `{}` and `body` is the whole file.
 */
export function parseFrontmatter(raw) {
  const match = FRONTMATTER_RE.exec(raw)
  if (match === null) return { attrs: {}, body: raw }
  const [, block, body] = match
  const attrs = {}
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || /^\s/.test(line)) continue
    const keyMatch = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (keyMatch === null) continue
    const [, key, rawValue] = keyMatch
    if (rawValue === '') {
      // Nested block (e.g. `requires:` -> `bins: [...]` / `auth: true`): consumed,
      // not parsed — recorded only as "present" per the README's `extra` contract.
      let j = i + 1
      while (j < lines.length && /^\s/.test(lines[j]) && lines[j].trim() !== '') j += 1
      attrs[key] = { nested: true }
      i = j - 1
      continue
    }
    attrs[key] = parseScalarOrArray(rawValue)
  }
  return { attrs, body }
}

/**
 * Parse one command/skill file into a registrable entry, or a rejection with
 * a `reason` a caller can log. `kind` is `'command'` or `'skill'`; only
 * `'skill'` honours `user-invocable`.
 */
export function readEntry(filePath, stem, kind, config) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    return { ok: false, reason: 'read-error', filePath, detail: String(error?.message ?? error) }
  }
  const { attrs, body } = parseFrontmatter(raw)

  const declaredName = typeof attrs.name === 'string' ? attrs.name : undefined
  if (declaredName !== undefined && declaredName !== stem) {
    return { ok: false, reason: 'name-mismatch', filePath, name: declaredName }
  }
  const name = declaredName ?? stem
  if (!NAME_RE.test(name)) return { ok: false, reason: 'invalid-name', filePath, name }

  let description = typeof attrs.description === 'string' ? attrs.description : undefined
  if (description === undefined) {
    const firstLine = body.split(/\r?\n/).find(line => line.trim() !== '')
    description = firstLine === undefined ? '' : firstLine.trim().slice(0, 200)
  }
  if (description === '') return { ok: false, reason: 'no-description', filePath, name }

  if (kind === 'skill' && attrs['user-invocable'] !== undefined) {
    const parsed = parseBoolean(attrs['user-invocable'])
    if (parsed === undefined) return { ok: false, reason: 'invalid-user-invocable', filePath, name }
    if (parsed === false) return { ok: false, reason: 'not-user-invocable', filePath, name }
  }

  let disableModelInvocation = false
  if (attrs['disable-model-invocation'] !== undefined) {
    const parsed = parseBoolean(attrs['disable-model-invocation'])
    if (parsed === undefined) return { ok: false, reason: 'invalid-disable-model-invocation', filePath, name }
    disableModelInvocation = parsed
  }

  const bodyBytes = Buffer.byteLength(body, 'utf8')
  if (bodyBytes > config.maxBodyBytes) return { ok: false, reason: 'body-too-large', filePath, name, bytes: bodyBytes }

  // The host's CommandInputDescriptor rejects an empty-string hint ("command
  // ... input hint must not be empty") — real files like `daily-review` and
  // `restore-prod-db` declare `argument-hint: ""` for "takes no arguments",
  // so an empty hint means "no hint", not "empty hint".
  const rawHint = attrs['argument-hint']
  const hint = typeof rawHint === 'string' && rawHint !== '' ? rawHint : undefined
  const argNames = Array.isArray(attrs.arguments) ? attrs.arguments : []
  const allowedTools = typeof attrs['allowed-tools'] === 'string'
    ? attrs['allowed-tools'].split(',').map(part => part.trim()).filter(part => part !== '')
    : []
  const model = typeof attrs.model === 'string' ? attrs.model : undefined

  return {
    ok: true,
    entry: {
      name,
      description,
      hint,
      argNames,
      allowedTools,
      disableModelInvocation,
      model,
      extra: { version: attrs.version, requires: attrs.requires },
      body,
      kind,
      filePath,
    },
  }
}
