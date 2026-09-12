import { describe, expect, it } from 'vitest'

import { getMisconception } from '../curriculum/graph'
import { PRACTICE_ITEMS } from './items'
import { composeFeedback, markChoice, markJudgement, markPrediction } from './score'
import { shuffleOptions } from './shuffle'

/**
 * Marking, and the line between a verdict and evidence.
 *
 * The tests that matter most here are the ones about *not* recording something: a malformed
 * submission, a judge that cannot tell, a provider that failed. Each has to end in an unmarked
 * attempt, because the alternative is false evidence in a record about a person — and false
 * evidence is undetectable afterwards, since the log looks perfectly consistent either way.
 */

describe('marking a multiple choice', () => {
  const presented = {
    correctIndex: 2,
    optionMisconceptions: [null, 'range-endpoint-inclusive', null, 'if-is-loop'] as const,
  }

  it('is right when the chosen index is the correct one', () => {
    const marking = markChoice('2', presented)

    expect(marking.kind).toBe('marked')
    expect(marking.kind === 'marked' && marking.correct).toBe(true)
    expect(marking.kind === 'marked' && marking.source).toBe('deterministic')
    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([])
  })

  it('names the misconception the chosen distractor represents', () => {
    const marking = markChoice('3', presented)

    expect(marking.kind === 'marked' && marking.correct).toBe(false)
    expect(marking.kind === 'marked' && marking.misconceptions).toEqual(['if-is-loop'])
  })

  it('records no misconception for a distractor that is merely wrong', () => {
    const marking = markChoice('0', presented)

    expect(marking.kind === 'marked' && marking.correct).toBe(false)
    // Guessing at which wrong idea an unlabelled option shows would be a fabricated diagnosis.
    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([])
  })

  /*
   * A malformed submission is not a wrong answer. Marking it wrong would put evidence against
   * the learner for something they did not do.
   */
  it('leaves a malformed submission unmarked rather than wrong', () => {
    // '1.5' and '2abc' are the interesting ones: `parseInt` would have turned them into a
    // valid index and marked the learner on a choice they never made.
    for (const answer of ['', 'two', '-1', '9', '1.5', '2abc', ' ', 'null', '0x1', '+1']) {
      const marking = markChoice(answer, presented)
      expect(marking.kind, answer).toBe('unmarked')
    }
  })

  it('never carries a misconception on a correct answer, whatever the data says', () => {
    // The correct option should hold null, and an invariant asserts it does. This is the second
    // lock: even given data that breaks that rule, a right answer records no confusion.
    const broken = {
      correctIndex: 0,
      optionMisconceptions: ['if-is-loop', null] as const,
    }

    const marking = markChoice('0', broken)
    expect(marking.kind === 'marked' && marking.correct).toBe(true)
    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([])
  })
})

describe('marking an output prediction', () => {
  const item = {
    expectedOutput: '[1, 2, 3]',
    knownWrongAnswers: [{ answer: '[1, 2]', misconception: 'assignment-copies-object' }] as const,
  }

  it('accepts the expected output', () => {
    expect(markPrediction('[1, 2, 3]', item).kind === 'marked').toBe(true)
    expect(
      markPrediction('[1, 2, 3]', item).kind === 'marked' &&
        (markPrediction('[1, 2, 3]', item) as { correct: boolean }).correct,
    ).toBe(true)
  })

  it('accepts it however the commas are spaced', () => {
    for (const typed of ['[1,2,3]', '[1 , 2 , 3]', '  [1, 2, 3]  ', '[1, 2, 3]\n']) {
      const marking = markPrediction(typed, item)
      expect(marking.kind === 'marked' && marking.correct, typed).toBe(true)
    }
  })

  /*
   * Case is folded, and that is a decision with a cost.
   *
   * A learner typing `first` for `First` has not misunderstood anything, so leniency is right.
   * But it means no item may rest on case alone to tell a right answer from a wrong one — two
   * items did, and the marker read their recognised wrong answer as correct, told a learner who
   * held the exact misconception being probed that they were right, and recorded positive
   * evidence for it. `items.test.ts` now asserts through the marker that no item can do this.
   */
  it('folds case, so no item may depend on it alone', () => {
    expect(markPrediction('[1, 2, 3]'.toUpperCase(), item).kind).toBe('marked')
    expect(markPrediction('TRUE', { expectedOutput: 'True', knownWrongAnswers: [] })).toMatchObject(
      { kind: 'marked', correct: true },
    )
  })

  it('names the misconception behind a recognised wrong answer', () => {
    const marking = markPrediction('[1, 2]', item)

    expect(marking.kind === 'marked' && marking.correct).toBe(false)
    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([
      'assignment-copies-object',
    ])
  })

  it('records no misconception for an unrecognised wrong answer', () => {
    const marking = markPrediction('something else', item)

    expect(marking.kind === 'marked' && marking.correct).toBe(false)
    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([])
  })

  it('leaves an empty answer unmarked', () => {
    expect(markPrediction('   ', item).kind).toBe('unmarked')
  })
})

/*
 * The model path, and the reason the verdict is four words rather than a boolean.
 *
 * M2 recorded `answer.evaluate.correct` as the real trust boundary. The problem was never that
 * a boolean is coarse; it is that a judge with no opinion had to invent one, and the invented
 * one became a numeric change in a learner's record.
 */
describe('marking from a model judgement', () => {
  it('treats a correct verdict as unaided success', () => {
    const marking = markJudgement({ verdict: 'correct', misconceptions: [] })

    expect(marking.kind === 'marked' && marking.correct).toBe(true)
    expect(marking.kind === 'marked' && marking.partial).toBe(false)
    expect(marking.kind === 'marked' && marking.source).toBe('model')
  })

  it('treats a partially correct verdict as a success with something missing', () => {
    const marking = markJudgement({ verdict: 'partially-correct', misconceptions: [] })

    // Still a success — the learner got there. Attenuated, not downgraded: ADR-0005 forbids a
    // correct answer from lowering anything.
    expect(marking.kind === 'marked' && marking.correct).toBe(true)
    expect(marking.kind === 'marked' && marking.partial).toBe(true)
  })

  it('treats an incorrect verdict as incorrect, with whatever it named', () => {
    const marking = markJudgement({
      verdict: 'incorrect',
      misconceptions: ['range-endpoint-inclusive'],
    })

    expect(marking.kind === 'marked' && marking.correct).toBe(false)
    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([
      'range-endpoint-inclusive',
    ])
  })

  it('records nothing at all when the judge cannot tell', () => {
    const marking = markJudgement({ verdict: 'cannot-tell', misconceptions: [] })

    // The case a boolean could not express. No evidence either way, which costs the learner
    // nothing and keeps a guess out of their profile.
    expect(marking.kind).toBe('unmarked')
  })

  it('discards misconceptions the judge attached to a correct verdict', () => {
    // The strategy's invariants reject this combination, so it should never arrive. If it did,
    // a right answer would still record no confusion.
    const marking = markJudgement({
      verdict: 'correct',
      misconceptions: ['range-endpoint-inclusive'],
    })

    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([])
  })

  it('records no mastery of any kind, because there is no field for one', () => {
    const marking = markJudgement({ verdict: 'correct', misconceptions: [] })
    const serialised = JSON.stringify(marking)

    for (const forbidden of ['theta', 'mastery', 'band', 'score', 'percent', 'delta']) {
      expect(serialised.toLowerCase(), forbidden).not.toContain(forbidden)
    }
  })
})

describe('the feedback a learner reads', () => {
  it('acknowledges a correct answer briefly and explains the reasoning', () => {
    const feedback = composeFeedback({
      marking: { kind: 'marked', correct: true, partial: false, source: 'deterministic', misconceptions: [] },
      explanation: 'Statements run top to bottom.',
    })

    expect(feedback).toContain('That is right.')
    expect(feedback).toContain('Statements run top to bottom.')
    // No effusiveness: one question does not warrant congratulation.
    expect(feedback).not.toMatch(/excellent|amazing|well done|fantastic|great job/i)
    expect(feedback.length).toBeLessThan(400)
  })

  it('says what a partially correct answer was missing rather than calling it right', () => {
    const feedback = composeFeedback({
      marking: { kind: 'marked', correct: true, partial: true, source: 'model', misconceptions: [] },
      explanation: 'The name survives between passes.',
    })

    expect(feedback).toContain('broadly right')
  })

  /*
   * The requirement: the learner should understand both what was wrong and what to think about
   * differently. Composed from the catalogue rather than generated, so it is specific, instant,
   * and cannot contradict the marking.
   */
  it('names the wrong idea behind the answer, and what is actually true', () => {
    const feedback = composeFeedback({
      marking: {
        kind: 'marked',
        correct: false,
        partial: false,
        source: 'deterministic',
        misconceptions: ['range-endpoint-inclusive'],
      },
      explanation: 'range(3) gives 0, 1 and 2.',
    })

    const misconception = getMisconception('range-endpoint-inclusive')
    expect(feedback).toContain('Not quite.')
    // The belief comes from the catalogue: only it knows what picking that answer suggests.
    expect(feedback).toContain(lowerFirst(misconception.belief))
    // The correction comes from the item, about the code the learner just read.
    expect(feedback).toContain('range(3) gives 0, 1 and 2.')
    expect(feedback).not.toBe('Incorrect. Try again.')
  })

  /*
   * The general statement about a wrong idea is the fallback, not the default.
   *
   * Written to be true anywhere, it was being stitched onto whichever question happened to
   * name the misconception — which produced feedback about `range` under a question on slices,
   * and in one case handed over the complete answer to a different item on the same concept.
   */
  it('uses the catalogue’s general statement only when the item has none of its own', () => {
    const feedback = composeFeedback({
      marking: {
        kind: 'marked',
        correct: false,
        partial: false,
        source: 'deterministic',
        misconceptions: ['range-endpoint-inclusive'],
      },
      explanation: '',
    })

    expect(feedback).toContain(getMisconception('range-endpoint-inclusive').reality)
  })

  it('does not add the general statement when the item explains itself', () => {
    const feedback = composeFeedback({
      marking: {
        kind: 'marked',
        correct: false,
        partial: false,
        source: 'deterministic',
        misconceptions: ['range-endpoint-inclusive'],
      },
      explanation: 'range(3) gives 0, 1 and 2.',
    })

    expect(feedback).not.toContain(getMisconception('range-endpoint-inclusive').reality)
  })

  it('falls back to the explanation when no wrong idea was identified', () => {
    const feedback = composeFeedback({
      marking: { kind: 'marked', correct: false, partial: false, source: 'deterministic', misconceptions: [] },
      explanation: 'The list has three items.',
    })

    expect(feedback).toContain('Not quite.')
    expect(feedback).toContain('The list has three items.')
  })

  it('prefers the judge’s own words where a model read the answer', () => {
    const feedback = composeFeedback({
      marking: { kind: 'marked', correct: false, partial: false, source: 'model', misconceptions: [] },
      explanation: 'The authored explanation.',
      judgeExplanation: 'You have described what print does, not what return does.',
    })

    // The judge's reading of their particular answer leads, and the item's authored
    // explanation still follows it — documented as shown whatever the verdict.
    expect(feedback).toContain('You have described what print does, not what return does.')
    expect(feedback).toContain('The authored explanation.')
  })

  it('says plainly when nothing was marked', () => {
    const feedback = composeFeedback({
      marking: { kind: 'unmarked', reason: 'That could not be marked just now.' },
      explanation: 'irrelevant',
    })

    expect(feedback).toBe('That could not be marked just now.')
    // Crucially, it does not leak the right answer for a question that was never marked.
    expect(feedback).not.toContain('irrelevant')
  })

  it('is never generic, for any item in the bank answered wrongly', () => {
    for (const item of PRACTICE_ITEMS) {
      if (item.kind !== 'choice') continue
      const wrongIndex = (item.correctIndex + 1) % item.options.length
      const named = item.optionMisconceptions[wrongIndex] ?? null

      const feedback = composeFeedback({
        marking: {
          kind: 'marked',
          correct: false,
          partial: false,
          source: 'deterministic',
          misconceptions: named === null ? [] : [named],
        },
        explanation: item.explanation,
      })

      expect(feedback.length, item.id).toBeGreaterThan(60)
      expect(feedback, item.id).not.toBe('Not quite.')
    }
  })
})

/*
 * The shuffle. The M3 audit found every correct answer at index 0; this is what makes that
 * impossible rather than merely fixed.
 */
describe('ordering the options', () => {
  const set = {
    options: ['a', 'b', 'c', 'd'],
    correctIndex: 0,
    optionMisconceptions: ['x', null, 'y', null] as (string | null)[],
  }

  it('keeps the answer attached to the option it belongs to', () => {
    for (const seed of ['one', 'two', 'three', 'four', 'five']) {
      const shuffled = shuffleOptions(set, seed)
      expect(shuffled.options[shuffled.correctIndex], seed).toBe('a')
    }
  })

  it('keeps each misconception attached to its own option', () => {
    for (const seed of ['one', 'two', 'three', 'four', 'five']) {
      const shuffled = shuffleOptions(set, seed)

      for (let index = 0; index < shuffled.options.length; index += 1) {
        const option = shuffled.options[index]
        const expected = option === 'a' ? 'x' : option === 'c' ? 'y' : null
        expect(shuffled.optionMisconceptions[index], `${seed}/${option ?? ''}`).toBe(expected)
      }
    }
  })

  it('loses no option and invents none', () => {
    const shuffled = shuffleOptions(set, 'seed')
    expect([...shuffled.options].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('gives the same order for the same seed, so a reload does not reshuffle', () => {
    expect(shuffleOptions(set, 'stable')).toEqual(shuffleOptions(set, 'stable'))
  })

  it('spreads the answer across every position over many activities', () => {
    const positions = new Map<number, number>()

    for (let index = 0; index < 400; index += 1) {
      const shuffled = shuffleOptions(set, `activity-${String(index)}`)
      positions.set(shuffled.correctIndex, (positions.get(shuffled.correctIndex) ?? 0) + 1)
    }

    // Every position used, and none dominating. A learner cannot learn the position because
    // there is no position to learn.
    expect(positions.size).toBe(4)
    for (const count of positions.values()) {
      expect(count).toBeGreaterThan(400 / 8)
      expect(count).toBeLessThan((400 / 4) * 2)
    }
  })

  it('copes with two options, and with one', () => {
    expect(
      shuffleOptions({ options: ['a', 'b'], correctIndex: 1, optionMisconceptions: [null, null] }, 's')
        .options,
    ).toHaveLength(2)
    expect(
      shuffleOptions({ options: ['only'], correctIndex: 0, optionMisconceptions: [null] }, 's'),
    ).toEqual({ options: ['only'], correctIndex: 0, optionMisconceptions: [null] })
  })
})

/** Mirrors the composer's own casing, so the assertion compares what a learner would read. */
function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1)
}
