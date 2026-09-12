import { describe, expect, it } from 'vitest'

import { PRACTICE_ITEMS } from './items'
import { presentActivity, type StoredActivity } from './present'

/**
 * What the browser is allowed to know about a question it is about to ask.
 *
 * `present.ts` said this was "asserted over the whole bank in `present.test.ts`". It was not:
 * the file did not exist. The guarantee was real — `presentActivity` builds its result from an
 * explicit list of fields, so there is no path for an answer to travel — but a guarantee nobody
 * checks is a guarantee that lasts until the next field is added, and this one is the
 * difference between an assessment and a quiz whose answers ship with it.
 *
 * Asserted over the serialised result rather than field by field, so a field added to an item
 * later cannot leak by being forgotten here too.
 */

function storedFrom(item: (typeof PRACTICE_ITEMS)[number]): StoredActivity {
  const base = {
    id: `activity-${item.id}`,
    conceptId: item.conceptId,
    kind: item.kind,
    prompt: item.prompt,
    code: item.code ?? null,
    explanation: item.explanation,
    selectionGround: 'A check on this, because it has been going wrong.',
  }

  if (item.kind === 'choice') {
    return {
      ...base,
      options: item.options,
      correctIndex: item.correctIndex,
      optionMisconceptions: item.optionMisconceptions,
      expectedOutput: null,
      knownWrongAnswers: null,
      expectedPoints: null,
    }
  }

  if (item.kind === 'predict-output') {
    return {
      ...base,
      options: null,
      correctIndex: null,
      optionMisconceptions: null,
      expectedOutput: item.expectedOutput,
      knownWrongAnswers: item.knownWrongAnswers.map((wrong) => ({ ...wrong })),
      expectedPoints: null,
    }
  }

  return {
    ...base,
    options: null,
    correctIndex: null,
    optionMisconceptions: null,
    expectedOutput: null,
    knownWrongAnswers: null,
    expectedPoints: item.expectedPoints,
  }
}

describe('what is sent to the browser', () => {
  it('carries no field the learner could mark themselves with', () => {
    const forbidden = [
      'correctIndex',
      'optionMisconceptions',
      'expectedOutput',
      'knownWrongAnswers',
      'expectedPoints',
      'explanation',
    ]

    for (const item of PRACTICE_ITEMS) {
      const presented = presentActivity(storedFrom(item))

      for (const field of forbidden) {
        expect(Object.keys(presented), `${item.id} carries ${field}`).not.toContain(field)
      }
    }
  })

  it('does not carry the answer as a value either, however it is spelled', () => {
    for (const item of PRACTICE_ITEMS) {
      const serialised = JSON.stringify(presentActivity(storedFrom(item)))

      // The explanation names the right answer, so its presence would give the question away
      // even under a different field name.
      expect(serialised, item.id).not.toContain(item.explanation)

      if (item.kind === 'predict-output') {
        expect(serialised, item.id).not.toContain(`"${item.expectedOutput}"`)
      }
      if (item.kind === 'short-response') {
        expect(serialised, item.id).not.toContain(item.expectedPoints)
      }
    }
  })

  it('still carries everything needed to answer', () => {
    for (const item of PRACTICE_ITEMS) {
      const presented = presentActivity(storedFrom(item))

      expect(presented.prompt, item.id).toBe(item.prompt)
      expect(presented.code, item.id).toBe(item.code ?? null)
      expect(presented.ground.length, item.id).toBeGreaterThan(0)

      if (presented.kind === 'choice' && item.kind === 'choice') {
        // In the order they will be shown, which is the shuffled order the marking uses.
        expect(presented.options, item.id).toEqual(item.options)
      }
    }
  })

  /*
   * The shuffled order is what travels, and the correct index stays behind. Together those two
   * facts are what stop the position of the answer being readable from the payload.
   */
  it('sends options without saying which of them is right', () => {
    const [choice] = PRACTICE_ITEMS.filter((item) => item.kind === 'choice')
    if (choice === undefined) throw new Error('no choice item')

    const presented = presentActivity(storedFrom(choice))
    const serialised = JSON.stringify(presented)

    expect(serialised).toContain(choice.options[choice.correctIndex] ?? '')
    expect(serialised).not.toContain(String(choice.correctIndex) + ',')
    expect(Object.keys(presented)).toEqual(['id', 'conceptId', 'prompt', 'code', 'ground', 'kind', 'options'])
  })
})
