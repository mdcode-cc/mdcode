/**
 * Claude-Code-style body substitution: `$ARGUMENTS`, `$1`…`$9`, `$<name>`.
 *
 * Positional tokens are whitespace-split from `rawInput`. When `arguments`
 * declares fewer names than tokens, the LAST declared name (and its matching
 * `$N`) absorbs the remainder of `rawInput` from that token's start to the
 * end of the string — not just its own token — so a single-argument command
 * like `/intake fix the login bug` gets the whole phrase, not just "fix". A
 * literal `$` not followed by `ARGUMENTS`, a digit 1-9, or a declared name is
 * left alone.
 */

const PLACEHOLDER_RE = /\$(ARGUMENTS|[1-9]|[A-Za-z_][A-Za-z0-9_-]*)/g

function splitTokens(rawInput) {
  const tokens = []
  const re = /\S+/g
  let match = re.exec(rawInput)
  while (match !== null) {
    tokens.push({ value: match[0], start: match.index })
    match = re.exec(rawInput)
  }
  return tokens
}

/**
 * @param body - the command/skill file's prompt body.
 * @param rawInput - exact text typed after the command name.
 * @param argNames - declared positional names, in order (`arguments:` frontmatter).
 * @returns `{text, empty}` — the substituted body and the `$...` placeholders that resolved to `''`.
 */
export function substitute(body, rawInput, argNames) {
  const tokens = splitTokens(rawInput)
  const empty = []

  const valueForPosition = (position) => {
    if (position < 1 || position - 1 >= tokens.length) return ''
    if (position === argNames.length) return rawInput.slice(tokens[position - 1].start)
    return tokens[position - 1].value
  }

  const text = body.replace(PLACEHOLDER_RE, (full, token) => {
    if (token === 'ARGUMENTS') {
      if (rawInput === '') empty.push('$ARGUMENTS')
      return rawInput
    }
    if (/^[1-9]$/.test(token)) {
      const value = valueForPosition(Number(token))
      if (value === '') empty.push(`$${token}`)
      return value
    }
    const position = argNames.indexOf(token) + 1
    if (position === 0) return full // not a declared name — leave the literal `$name` alone
    const value = valueForPosition(position)
    if (value === '') empty.push(`$${token}`)
    return value
  })

  return { text, empty }
}
