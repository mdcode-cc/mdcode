import { test } from 'node:test'
import assert from 'node:assert/strict'
import { substitute } from '../lib/substitute.js'

test('$ARGUMENTS -> the whole rawInput', () => {
  const { text, empty } = substitute('Ask: $ARGUMENTS', 'fix the login bug', [])
  assert.equal(text, 'Ask: fix the login bug')
  assert.deepEqual(empty, [])
})

test('$ARGUMENTS empty is reported', () => {
  const { text, empty } = substitute('Ask: $ARGUMENTS', '', [])
  assert.equal(text, 'Ask: ')
  assert.deepEqual(empty, ['$ARGUMENTS'])
})

test('single declared argument absorbs the whole remainder, not just its own token', () => {
  const { text, empty } = substitute('Item: $item', 'docs/claudedocs/work/foo.md please', ['item'])
  assert.equal(text, 'Item: docs/claudedocs/work/foo.md please')
  assert.deepEqual(empty, [])
})

test('$1 mirrors the sole declared name when arguments has exactly one entry', () => {
  const { text } = substitute('$1 / $item', 'a b c', ['item'])
  assert.equal(text, 'a b c / a b c')
})

test('more declared names than tokens: trailing names resolve empty and are reported', () => {
  const { text, empty } = substitute('$a $b $c', 'only-one', ['a', 'b', 'c'])
  assert.equal(text, 'only-one  ')
  assert.deepEqual(empty, ['$b', '$c'])
})

test('fewer declared names than tokens: the last name absorbs the rest; $1 is still plain', () => {
  const { text } = substitute('[$1][$2]', 'alpha beta gamma delta', ['first', 'second'])
  assert.equal(text, '[alpha][beta gamma delta]')
})

test('no declared arguments: $1..$9 are plain whitespace tokens, nothing absorbs', () => {
  const { text, empty } = substitute('$1|$2|$3', 'one two', [])
  assert.equal(text, 'one|two|')
  assert.deepEqual(empty, ['$3'])
})

test('a literal $ not followed by a digit 1-9 or a declared name is left alone', () => {
  const { text } = substitute('see $undeclared and a bare $$ sign', 'x', ['item'])
  assert.equal(text, 'see $undeclared and a bare $$ sign')
})

test('$1-$9 are real placeholders even with no matching declared name (e.g. $5)', () => {
  const { text, empty } = substitute('fifth: $5', 'a b c', ['item'])
  assert.equal(text, 'fifth: ')
  assert.deepEqual(empty, ['$5'])
})

test('$<name> only resolves for a name actually declared in arguments', () => {
  const { text } = substitute('$item vs $other', 'val', ['item'])
  assert.equal(text, 'val vs $other')
})
