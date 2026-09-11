import { describe, expect, it } from 'vitest'

import { DIAGNOSTIC_ITEMS } from '@/domain/diagnostic/items'
import { parseAuthoredText } from './AuthoredText'

/**
 * Authoring syntax must never reach the learner, and must never swallow their content either.
 *
 * The second half is the reason this is parsed rather than string-replaced: a lone backtick in
 * a sentence has to survive as a backtick.
 */
describe('parseAuthoredText', () => {
  it('leaves prose with no backticks alone', () => {
    expect(parseAuthoredText('Statements run top to bottom.')).toEqual([
      { kind: 'text', value: 'Statements run top to bottom.' },
    ])
  })

  it('lifts a backtick pair out as code', () => {
    expect(parseAuthoredText('What does `warm` hold?')).toEqual([
      { kind: 'text', value: 'What does ' },
      { kind: 'code', value: 'warm' },
      { kind: 'text', value: ' hold?' },
    ])
  })

  it('handles several in one sentence, including at either end', () => {
    expect(parseAuthoredText('`==` compares, `=` assigns')).toEqual([
      { kind: 'code', value: '==' },
      { kind: 'text', value: ' compares, ' },
      { kind: 'code', value: '=' },
      { kind: 'text', value: ' assigns' },
    ])
  })

  it('leaves an unpaired backtick as ordinary text', () => {
    // The failure that makes careless Markdown handling worse than none: a stray backtick
    // must not swallow the rest of the sentence.
    expect(parseAuthoredText('a ` b c')).toEqual([{ kind: 'text', value: 'a ` b c' }])
  })

  it('does not let a pair span a line break', () => {
    const parsed = parseAuthoredText('first `one\nsecond` two')
    expect(parsed.every((segment) => segment.kind === 'text')).toBe(true)
  })

  it('treats an empty pair as text, since there is no code in it', () => {
    expect(parseAuthoredText('nothing `` here')).toEqual([{ kind: 'text', value: 'nothing `` here' }])
  })

  it('interprets nothing else — no emphasis, no links, no lists', () => {
    const source = '**bold** _under_ [link](x) # heading - item <b>html</b>'
    expect(parseAuthoredText(source)).toEqual([{ kind: 'text', value: source }])
  })
})

describe('the authored bank', () => {
  /** Every string the learner is shown before or after answering. */
  function learnerFacing(): readonly { readonly id: string; readonly field: string; readonly value: string }[] {
    return DIAGNOSTIC_ITEMS.flatMap((item) => [
      { id: item.id, field: 'prompt', value: item.prompt },
      ...('explanation' in item ? [{ id: item.id, field: 'explanation', value: item.explanation }] : []),
      ...(item.kind === 'choice'
        ? item.options.map((option, index) => ({ id: item.id, field: `option ${String(index)}`, value: option }))
        : []),
    ])
  }

  it('never leaves an unpaired backtick where a learner would see it', () => {
    for (const { id, field, value } of learnerFacing()) {
      const backticks = (value.match(/`/g) ?? []).length
      expect(backticks % 2, `${id} ${field}: ${value}`).toBe(0)
    }
  })

  it('renders every backtick pair as code rather than showing the syntax', () => {
    for (const { id, field, value } of learnerFacing()) {
      if (!value.includes('`')) continue

      const parsed = parseAuthoredText(value)
      expect(parsed.some((segment) => segment.kind === 'code'), `${id} ${field}`).toBe(true)
      // Nothing that reaches the screen still carries the syntax.
      for (const segment of parsed) {
        expect(segment.value, `${id} ${field}`).not.toContain('`')
      }
    }
  })
})
