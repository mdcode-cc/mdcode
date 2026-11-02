/**
 * Minimal YAML-frontmatter parser for Claude-Code-style agent markdown.
 *
 * Handwritten, not a YAML library (no extra runtime deps). Covers exactly
 * what a real agent roster uses: scalar strings, quoted strings,
 * `[a, b]` arrays, comma-separated scalars, and one folded block scalar
 * (`key: >`) form.
 */

const KNOWN_KEYS = new Set([
  'name', 'description', 'model', 'effort', 'tools', 'disallowedTools',
  'permissionMode', 'maxTurns', 'skills',
])
const ARRAY_KEYS = new Set(['tools', 'disallowedTools', 'skills'])
const EFFORT_VALUES = new Set(['off', 'low', 'medium', 'high', 'max'])
const PERMISSION_VALUES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions'])

function unquote(s) {
  const v = s.trim()
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1)
  }
  return v
}

function parseValue(raw) {
  const v = raw.trim()
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map((s) => unquote(s))
  }
  return unquote(v)
}

/**
 * Split `---\n...\n---\n` frontmatter from the body; null when no block
 * opens the file. Splits on `\r?\n` throughout (not just the delimiter
 * lines) so a CRLF file parses identically to an LF one.
 */
function splitFrontmatter(raw) {
  const lines = raw.split(/\r\n|\n/)
  if (lines[0]?.trim() !== '---') return null
  let closeAt = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { closeAt = i; break }
  }
  if (closeAt === -1) return null
  return { fmLines: lines.slice(1, closeAt), body: lines.slice(closeAt + 1).join('\n') }
}

/** One raw `key: value` entry per line, folding `>` / `>-` block scalars. */
function scanEntries(fmLines) {
  const entries = []
  let i = 0
  while (i < fmLines.length) {
    const line = fmLines[i]
    const m = /^([A-Za-z][\w-]*):[ \t]?(.*)$/.exec(line)
    if (!m) { i += 1; continue }
    const [, key, head] = m
    i += 1
    if (head === '>' || head === '>-' || head === '|' || head === '|-') {
      const block = []
      while (i < fmLines.length && (fmLines[i].trim() === '' || /^\s/.test(fmLines[i]))) {
        if (fmLines[i].trim() !== '') block.push(fmLines[i].trim())
        i += 1
      }
      entries.push([key, block.join(' ')])
    } else {
      entries.push([key, head])
    }
  }
  return entries
}

function toStringList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean)
  if (typeof value === 'string') return value === '' ? [] : value.split(',').map((s) => s.trim()).filter(Boolean)
  return null
}

/**
 * Parse one agent markdown file.
 * @param raw file contents
 * @param stem filename without extension — `name` must match it when present
 * @param maxPromptBytes cap on the body, in bytes
 * @returns `{ ok: true, descriptor }` or `{ ok: false, error }`
 */
export function parseAgentFile(raw, stem, maxPromptBytes = 65536) {
  const split = splitFrontmatter(raw)
  if (split === null) return { ok: false, error: 'missing frontmatter block' }

  const out = {}
  const extra = {}
  for (const [key, rawValue] of scanEntries(split.fmLines)) {
    const value = parseValue(rawValue)
    if (!KNOWN_KEYS.has(key)) { extra[key] = value; continue }

    if (ARRAY_KEYS.has(key)) {
      const list = toStringList(value)
      if (list === null) return { ok: false, error: `invalid ${key}: expected a list or comma-separated string` }
      out[key] = list
      continue
    }
    if (key === 'maxTurns') {
      const n = typeof value === 'string' ? Number(value) : NaN
      if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'invalid maxTurns: expected a positive integer' }
      out.maxTurns = n
      continue
    }
    if (typeof value !== 'string' || value === '') return { ok: false, error: `invalid ${key}: expected a non-empty string` }
    if (key === 'effort' && !EFFORT_VALUES.has(value)) return { ok: false, error: `invalid effort: ${value}` }
    if (key === 'permissionMode' && !PERMISSION_VALUES.has(value)) return { ok: false, error: `invalid permissionMode: ${value}` }
    out[key] = value
  }

  if (!out.description) return { ok: false, error: 'missing required key: description' }
  if (out.name !== undefined && out.name !== stem) {
    return { ok: false, error: `name "${out.name}" does not match filename "${stem}"` }
  }
  const effectiveName = out.name ?? stem
  // The registry's entire preset-id grammar is "non-empty after trim"
  // (dsh-agent-preset-registry/lib/index.js: `if (!definition.id.trim())
  // throw new Error('Preset id must not be empty')`, read verbatim on this
  // host — no stricter character-class rule exists). Applying exactly that
  // rule here turns a would-be registry throw into a parse-time rejection
  // with the actual file named, instead of a generic registry warn.
  if (effectiveName.trim() === '') return { ok: false, error: 'empty name: the preset id would be empty after the configured prefix' }

  const body = split.body.trim()
  if (body === '') return { ok: false, error: 'missing agent body: empty after the frontmatter block' }
  if (Buffer.byteLength(body, 'utf8') > maxPromptBytes) {
    return { ok: false, error: `body exceeds maxPromptBytes (${maxPromptBytes})` }
  }

  return {
    ok: true,
    descriptor: {
      name: effectiveName,
      description: out.description,
      model: out.model,
      effort: out.effort,
      tools: out.tools ?? [],
      disallowedTools: out.disallowedTools ?? [],
      permissionMode: out.permissionMode,
      maxTurns: out.maxTurns,
      skills: out.skills ?? [],
      extra,
      body,
    },
  }
}
