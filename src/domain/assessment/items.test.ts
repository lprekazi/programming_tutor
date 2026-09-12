import { describe, expect, it } from 'vitest'

import { CONCEPTS_BY_ID } from '../curriculum/concepts'
import { MISCONCEPTIONS_BY_ID } from '../curriculum/misconceptions'
import { PRACTICE_ITEMS, itemsProbing, practiceItemsFor } from './items'
import { DIAGNOSTIC_ITEMS } from '../diagnostic/items'
import { markPrediction } from './score'

/**
 * The practice bank, held to the rules the M3 diagnostic audit produced.
 *
 * That audit found four classes of defect in authored assessment data, and every one of them
 * is now a test rather than a matter of the author remembering:
 *
 *   - a distractor that was valid Python satisfying the question as asked, so a learner got
 *     negative evidence for writing something that works;
 *   - a misconception named on an item that could not possibly demonstrate it;
 *   - a misconception attached to the *correct* option;
 *   - every correct answer at the same index, so the bank could be beaten without reading.
 *
 * The last of those is now impossible by construction — options are shuffled per activity —
 * but the rest are properties of the data and are checked here.
 */

describe('the practice bank', () => {
  it('covers every kind of question the milestone promises', () => {
    const kinds = new Set(PRACTICE_ITEMS.map((item) => item.kind))

    expect(kinds).toContain('choice')
    expect(kinds).toContain('predict-output')
    expect(kinds).toContain('short-response')
  })

  it('marks all but the written questions without a model', () => {
    const needsModel = PRACTICE_ITEMS.filter((item) => item.kind === 'short-response')

    // Deterministic marking is preferred wherever it is possible, so the model-marked items
    // should be a small minority of the bank.
    expect(needsModel.length).toBeLessThan(PRACTICE_ITEMS.length / 4)
    for (const item of needsModel) expect(item.kind).toBe('short-response')
  })

  it('gives every item a unique id', () => {
    const ids = PRACTICE_ITEMS.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  /*
   * Practice and diagnosis must not share questions. A learner who meets an item twice learns
   * that they have seen it before, which is not something worth measuring.
   */
  it('shares no question with the diagnostic bank', () => {
    const diagnosticPrompts = new Set(
      DIAGNOSTIC_ITEMS.map((item) => `${item.prompt}::${item.code ?? ''}`),
    )

    for (const item of PRACTICE_ITEMS) {
      const key = `${item.prompt}::${item.code ?? ''}`
      expect(diagnosticPrompts.has(key), item.id).toBe(false)
    }
  })

  it('names a concept that exists, and a difficulty on the ability scale', () => {
    for (const item of PRACTICE_ITEMS) {
      expect(CONCEPTS_BY_ID.has(item.conceptId), item.id).toBe(true)
      expect(Number.isFinite(item.difficulty), item.id).toBe(true)
      expect(Math.abs(item.difficulty), item.id).toBeLessThanOrEqual(3)
    }
  })

  it('gives every item a prompt and an explanation worth reading', () => {
    for (const item of PRACTICE_ITEMS) {
      expect(item.prompt.length, item.id).toBeGreaterThan(10)
      expect(item.explanation.length, item.id).toBeGreaterThan(30)
    }
  })
})

describe('multiple-choice items', () => {
  const choices = PRACTICE_ITEMS.filter((item) => item.kind === 'choice')

  it('offers exactly one correct answer, structurally', () => {
    for (const item of choices) {
      // An index rather than a flag per option: there is no arrangement of this data that has
      // two correct answers or none.
      expect(item.correctIndex, item.id).toBeGreaterThanOrEqual(0)
      expect(item.correctIndex, item.id).toBeLessThan(item.options.length)
      expect(item.options.length, item.id).toBeGreaterThanOrEqual(3)
    }
  })

  it('never repeats an option', () => {
    for (const item of choices) {
      const normalised = item.options.map((option) => option.trim().toLowerCase())
      expect(new Set(normalised).size, item.id).toBe(item.options.length)
    }
  })

  it('keeps a misconception for every option, in step with the options', () => {
    for (const item of choices) {
      expect(item.optionMisconceptions.length, item.id).toBe(item.options.length)
    }
  })

  /*
   * Getting it right is never evidence of a confusion. `markChoice` guards this at run time
   * too, but the guard should not be the only thing standing between bad data and a learner's
   * record.
   */
  it('never attributes a misconception to the correct option', () => {
    for (const item of choices) {
      expect(item.optionMisconceptions[item.correctIndex], item.id).toBeNull()
    }
  })

  it('never blames a misconception unrelated to what the item tests', () => {
    for (const item of choices) {

      for (const id of item.optionMisconceptions) {
        if (id === null) continue
        const misconception = MISCONCEPTIONS_BY_ID.get(id)
        expect(misconception, `${item.id} names unknown ${id}`).toBeDefined()
        expect(
          misconception?.relatedConcepts,
          `${item.id} tests ${item.conceptId}, which ${id} says nothing about`,
        ).toContain(item.conceptId)
      }
    }
  })

  /*
   * The length giveaway. A learner who notices that the longest option is always the answer can
   * score without reading, which is the same defect as a fixed position in a different coat.
   */
  it('does not let the correct answer be picked by its length', () => {
    const longest = choices.filter((item) => {
      const lengths = item.options.map((option) => option.length)
      const max = Math.max(...lengths)
      return lengths[item.correctIndex] === max && lengths.filter((l) => l === max).length === 1
    })

    // Some items will unavoidably have a longer correct answer; what must not happen is that
    // being the rule. A quarter is well inside what chance would produce.
    expect(longest.length).toBeLessThanOrEqual(Math.ceil(choices.length / 4))
  })
})

/*
 * A probe that cannot record its own result is not a probe.
 *
 * `describeGround` tells the learner the tutor is "checking one specific thing: whether the idea
 * behind an earlier wrong answer is still there". If no answer to the item maps to that idea,
 * the check can neither confirm nor disconfirm it, and the reason shown is a claim about
 * something that was never measurable. One item was in exactly that state.
 */
describe('an item that claims to probe a misconception', () => {
  it('has an answer that would record it', () => {
    for (const item of PRACTICE_ITEMS) {
      if (item.probes === null) continue
      // A written answer is read by a model, which names the misconceptions it sees; there is
      // no fixed answer to map, so these are exempt by construction.
      if (item.kind === 'short-response') continue

      const recordable =
        item.kind === 'choice'
          ? item.optionMisconceptions.includes(item.probes)
          : item.knownWrongAnswers.some((wrong) => wrong.misconception === item.probes)

      expect(recordable, `${item.id} probes ${item.probes} but no answer maps to it`).toBe(true)
    }
  })
})

describe('output-prediction items', () => {
  const predictions = PRACTICE_ITEMS.filter((item) => item.kind === 'predict-output')

  it('has code to read and an expected output', () => {
    for (const item of predictions) {
      expect(item.code.length, item.id).toBeGreaterThan(5)
      expect(item.expectedOutput.length, item.id).toBeGreaterThan(0)
    }
  })

  /*
   * Asserted through the marker rather than with `!==`, which is the whole point.
   *
   * The weaker version of this test passed while two items were unmarkable: their recognised
   * wrong answer differed from the expected output only in letter case, and the marker folds
   * case before comparing. `'CAT' !== 'cat'` is true, so the assertion held — and a learner
   * who typed the wrong answer was told they were right and given positive evidence. A test
   * that claims a property of the marking has to ask the marking.
   */
  it('marks every recognised wrong answer as wrong, under the real marking rule', () => {
    for (const item of predictions) {
      for (const wrong of item.knownWrongAnswers) {
        const marking = markPrediction(wrong.answer, item)

        expect(marking.kind, `${item.id}: "${wrong.answer}"`).toBe('marked')
        expect(
          marking.kind === 'marked' && marking.correct,
          `${item.id}: "${wrong.answer}" is marked correct`,
        ).toBe(false)
        expect(
          marking.kind === 'marked' && marking.misconceptions,
          `${item.id}: "${wrong.answer}" records nothing`,
        ).toEqual([wrong.misconception])
      }
    }
  })

  it('marks its own expected output as correct', () => {
    for (const item of predictions) {
      const marking = markPrediction(item.expectedOutput, item)

      expect(marking.kind === 'marked' && marking.correct, item.id).toBe(true)
    }
  })

  it('names a catalogued misconception for every recognised wrong answer', () => {
    for (const item of predictions) {
      for (const wrong of item.knownWrongAnswers) {
        const misconception = MISCONCEPTIONS_BY_ID.get(wrong.misconception)
        expect(misconception, `${item.id} names unknown ${wrong.misconception}`).toBeDefined()
        expect(
          misconception?.relatedConcepts,
          `${item.id} tests ${item.conceptId}, which ${wrong.misconception} says nothing about`,
        ).toContain(item.conceptId)
      }
    }
  })
})

describe('written-response items', () => {
  it('says what a good answer contains, without showing it first', () => {
    for (const item of PRACTICE_ITEMS) {
      if (item.kind !== 'short-response') continue
      // The judge needs something to judge against, and it has to be substantive enough to
      // distinguish a real answer from a plausible-sounding one.
      expect(item.expectedPoints.length, item.id).toBeGreaterThan(60)
    }
  })
})

describe('probing a misconception', () => {
  /*
   * The requirement: "a learner returning to a weak misconception should receive an activity
   * that actually probes that misconception". That is only possible if items say which
   * misconception they are for, and if enough of them do.
   */
  it('has items designed for specific wrong ideas, across several areas', () => {
    const probed = new Set(
      PRACTICE_ITEMS.flatMap((item) => (item.probes === null ? [] : [item.probes])),
    )

    expect(probed.size).toBeGreaterThanOrEqual(12)

    const areas = new Set(
      [...probed].flatMap((id) =>
        (MISCONCEPTIONS_BY_ID.get(id)?.relatedConcepts ?? []).map(
          (conceptId) => CONCEPTS_BY_ID.get(conceptId)?.area,
        ),
      ),
    )
    expect(areas.size).toBeGreaterThanOrEqual(6)
  })

  it('probes a misconception its own concept is related to', () => {
    for (const item of PRACTICE_ITEMS) {
      if (item.probes === null) continue
      const misconception = MISCONCEPTIONS_BY_ID.get(item.probes)
      expect(misconception, `${item.id} probes unknown ${item.probes}`).toBeDefined()
      expect(misconception?.relatedConcepts, item.id).toContain(item.conceptId)
    }
  })

  it('finds the items that probe a given wrong idea', () => {
    const probes = itemsProbing('break-leaves-all-loops')
    expect(probes.length).toBeGreaterThan(0)
    for (const item of probes) expect(item.probes).toBe('break-leaves-all-loops')
  })

  it('finds the items for a given concept', () => {
    const forLoops = practiceItemsFor('loop-control')
    expect(forLoops.length).toBeGreaterThan(0)
    for (const item of forLoops) expect(item.conceptId).toBe('loop-control')
  })
})
