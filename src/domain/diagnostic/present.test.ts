import { describe, expect, it } from 'vitest'

import { DIAGNOSTIC_ITEMS } from './items'
import { presentItem } from './present'

/**
 * The answer key must not travel with the question.
 *
 * Asserted over the whole bank rather than over a couple of examples, so a new item authored
 * later cannot quietly leak its answer by being shaped differently from the existing ones.
 */
describe('presentItem', () => {
  it('keeps the correct option out of what the browser is sent', () => {
    for (const item of DIAGNOSTIC_ITEMS) {
      if (item.kind !== 'choice') continue

      const presented = presentItem(item)
      expect(Object.keys(presented)).not.toContain('correctIndex')
      expect(Object.keys(presented)).not.toContain('optionMisconceptions')
      expect(Object.keys(presented)).not.toContain('explanation')
    }
  })

  /*
   * Deliberately not a substring search over the whole payload. The answer to "what does this
   * print?" is usually a word visible in the program being read — that is what makes it a
   * reading question. What must not travel is the *field* naming it as the answer, and any
   * copy of it outside the question text itself.
   */
  it('keeps the expected output out of a prediction question', () => {
    for (const item of DIAGNOSTIC_ITEMS) {
      if (item.kind !== 'predict-output') continue

      const presented = presentItem(item)
      expect(Object.keys(presented)).not.toContain('expectedOutput')
      expect(Object.keys(presented)).not.toContain('knownWrongAnswers')
      expect(JSON.stringify({ ...presented, code: '', prompt: '' })).not.toContain(
        item.expectedOutput,
      )
    }
  })

  it('keeps the marking notes out of a written question', () => {
    for (const item of DIAGNOSTIC_ITEMS) {
      if (item.kind !== 'explain') continue

      const serialised = JSON.stringify(presentItem(item))
      expect(serialised).not.toContain(item.expectedPoints)
    }
  })

  it('never carries a field named like an answer, whatever the kind', () => {
    const forbidden = ['correctIndex', 'expectedOutput', 'expectedPoints', 'knownWrongAnswers']

    for (const item of DIAGNOSTIC_ITEMS) {
      const keys = Object.keys(presentItem(item))
      for (const name of forbidden) {
        expect(keys).not.toContain(name)
      }
    }
  })

  it('does send the practical item’s tests, because that is where Python runs', () => {
    const item = DIAGNOSTIC_ITEMS.find((candidate) => candidate.kind === 'code')
    if (item?.kind !== 'code') throw new Error('the bank has no practical item')

    const presented = presentItem(item)
    if (presented.kind !== 'code') throw new Error('presented as the wrong kind')

    expect(presented.tests).toEqual(item.tests)
    expect(presented.starterCode).toBe(item.starterCode)
  })

  it('carries every question’s prompt and code through unchanged', () => {
    for (const item of DIAGNOSTIC_ITEMS) {
      const presented = presentItem(item)
      expect(presented.prompt).toBe(item.prompt)
      expect(presented.code).toBe(item.code ?? null)
    }
  })
})
