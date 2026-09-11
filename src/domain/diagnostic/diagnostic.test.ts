import { describe, expect, it } from 'vitest'

import { getConcept } from '../curriculum/graph'
import { MISCONCEPTIONS_BY_ID } from '../curriculum/misconceptions'
import type { OnboardingAnswers } from '../onboarding/self-report'
import { DIAGNOSTIC_ITEMS, getDiagnosticItem, isDeterministic } from './items'
import {
  FAILURES_BEFORE_SKIP,
  MAX_ITEMS,
  MIN_ITEMS,
  conceptsAsked,
  estimatedLevel,
  remaining,
  isWorthAsking,
  nextDecision,
  type AnsweredItem,
} from './plan'
import { normaliseAnswer, scoreAnswer } from './score'

/**
 * The diagnostic: the item bank, deterministic scoring, and the selection rules.
 *
 * The rule under most scrutiny here is the one about what is *not* asked. Skipping an item
 * because its prerequisites failed has to mean the tutor knows less, not more — a diagnostic
 * that inferred from silence would produce a confident and wrong profile.
 */

const BEGINNER: OnboardingAnswers = {
  goal: 'Learn Python.',
  experience: 'new-to-programming',
  interests: [],
  confidence: {},
}

const EXPERIENCED: OnboardingAnswers = {
  goal: 'Fill the gaps.',
  experience: 'regular-python',
  interests: [],
  confidence: { loops: 'confident', functions: 'confident' },
}

describe('the item bank', () => {
  it('has unique ids', () => {
    const ids = DIAGNOSTIC_ITEMS.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('offers more items than any one diagnostic asks', () => {
    // Otherwise selection would be a fixed list in disguise.
    expect(DIAGNOSTIC_ITEMS.length).toBeGreaterThan(MAX_ITEMS)
  })

  it('targets concepts that exist', () => {
    for (const item of DIAGNOSTIC_ITEMS) {
      expect(() => getConcept(item.conceptId), item.id).not.toThrow()
    }
  })

  it('covers a spread of competence areas', () => {
    const areas = new Set(DIAGNOSTIC_ITEMS.map((item) => getConcept(item.conceptId).area))
    expect(areas.size).toBeGreaterThanOrEqual(6)
  })

  it('is mixed, not a multiple-choice quiz', () => {
    const kinds = new Set(DIAGNOSTIC_ITEMS.map((item) => item.kind))
    expect(kinds).toContain('choice')
    expect(kinds).toContain('predict-output')
    expect(kinds).toContain('explain')
    expect(kinds).toContain('code')
  })

  it('scores all but the free-text items without a model', () => {
    // A model that is slow, costly or unavailable must not be able to stop a learner being
    // assessed on what code does.
    const deterministic = DIAGNOSTIC_ITEMS.filter(isDeterministic)
    expect(deterministic.length).toBeGreaterThanOrEqual(DIAGNOSTIC_ITEMS.length - 1)
  })

  it('includes exactly one practical task using real execution', () => {
    expect(DIAGNOSTIC_ITEMS.filter((item) => item.kind === 'code')).toHaveLength(1)
  })

  it('maps every named distractor to a catalogued misconception', () => {
    for (const item of DIAGNOSTIC_ITEMS) {
      if (item.kind === 'choice') {
        expect(item.optionMisconceptions, item.id).toHaveLength(item.options.length)
        expect(item.correctIndex).toBeLessThan(item.options.length)
      }
    }
  })

  /*
   * Two structural checks on the bank's misconception data, both written after review found
   * entries that named a misconception the item could not possibly demonstrate — an
   * accumulator question blamed on "an if repeats", an indexing question blamed on "range
   * includes its endpoint". `scoreAnswer` refuses to guess at a misconception for an
   * unrecognised wrong answer, but that refusal is worth nothing if the recognised ones are
   * mislabelled: they go straight into `misconception_observation` and drive remediation.
   */
  it('never blames a misconception unrelated to what the item tests', () => {
    for (const item of DIAGNOSTIC_ITEMS) {
      const named =
        item.kind === 'choice'
          ? item.optionMisconceptions
          : item.kind === 'predict-output'
            ? item.knownWrongAnswers.map((wrong) => wrong.misconception)
            : []

      for (const id of named) {
        if (id === null) continue
        const misconception = MISCONCEPTIONS_BY_ID.get(id)
        expect(misconception, `${item.id} names unknown misconception ${id}`).toBeDefined()
        expect(
          misconception?.relatedConcepts,
          `${item.id} tests ${item.conceptId}, which ${id} says nothing about`,
        ).toContain(item.conceptId)
      }
    }
  })

  it('never attributes a misconception to the correct option', () => {
    for (const item of DIAGNOSTIC_ITEMS) {
      if (item.kind !== 'choice') continue
      // Getting it right is not evidence of a confusion. `scoreChoice` guards against this
      // too, but the guard should not be the only thing standing between bad data and the
      // learner's record.
      expect(item.optionMisconceptions[item.correctIndex], item.id).toBeNull()
    }
  })

  it('starts easy and reaches the harder end of the curriculum', () => {
    const difficulties = DIAGNOSTIC_ITEMS.map((item) => item.difficulty)
    expect(Math.min(...difficulties)).toBeLessThan(-1.5)
    expect(Math.max(...difficulties)).toBeGreaterThan(0.9)
  })

  it('rejects an unknown item id rather than returning nothing', () => {
    expect(() => getDiagnosticItem('does-not-exist')).toThrow(/Unknown diagnostic item/)
  })
})

describe('scoring a multiple choice', () => {
  const item = getDiagnosticItem('assign-vs-compare')

  it('accepts the correct option', () => {
    const verdict = scoreAnswer(item, '0')
    expect(verdict).toEqual({
      kind: 'scored',
      correct: true,
      source: 'deterministic',
      misconceptions: [],
    })
  })

  it('names the misconception behind a wrong choice', () => {
    const verdict = scoreAnswer(item, '1')
    if (verdict.kind !== 'scored') throw new Error('expected a score')

    expect(verdict.correct).toBe(false)
    expect(verdict.misconceptions).toEqual(['assign-compares'])
  })

  it('records no misconception for the correct answer, even where the data maps one', () => {
    // Acting on a wrong idea cannot be what led them to the right answer.
    const verdict = scoreAnswer(getDiagnosticItem('boolean-direct'), '0')
    if (verdict.kind !== 'scored') throw new Error('expected a score')
    expect(verdict.misconceptions).toEqual([])
  })

  it('treats a malformed selection as wrong but blames nothing on the learner', () => {
    for (const answer of ['', '9', '-1', 'banana']) {
      const verdict = scoreAnswer(item, answer)
      if (verdict.kind !== 'scored') throw new Error('expected a score')
      expect(verdict.correct, answer).toBe(false)
      expect(verdict.misconceptions, answer).toEqual([])
    }
  })
})

describe('scoring an output prediction', () => {
  const item = getDiagnosticItem('range-values')

  it('accepts the right output', () => {
    const verdict = scoreAnswer(item, '0\n1\n2')
    if (verdict.kind !== 'scored') throw new Error('expected a score')
    expect(verdict.correct).toBe(true)
  })

  it('is generous about form and strict about content', () => {
    // Spacing and capitalisation are not what is being assessed.
    for (const answer of ['0\n1\n2', ' 0 \n 1 \n 2 ', '0\n\n1\n2\n', '0\n1\n2\n\n']) {
      const verdict = scoreAnswer(item, answer)
      if (verdict.kind !== 'scored') throw new Error('expected a score')
      expect(verdict.correct, JSON.stringify(answer)).toBe(true)
    }

    const wrong = scoreAnswer(item, '0 1 2')
    if (wrong.kind !== 'scored') throw new Error('expected a score')
    // Three lines and one line are different answers about what the program does.
    expect(wrong.correct).toBe(false)
  })

  it('recognises a known wrong answer and says what it shows', () => {
    const verdict = scoreAnswer(item, '0\n1\n2\n3')
    if (verdict.kind !== 'scored') throw new Error('expected a score')

    expect(verdict.correct).toBe(false)
    expect(verdict.misconceptions).toEqual(['range-endpoint-inclusive'])
  })

  it('records no misconception for an unrecognised wrong answer', () => {
    // Guessing which wrong idea it showed would be a fabricated diagnosis, acted on later.
    const verdict = scoreAnswer(item, 'no idea')
    if (verdict.kind !== 'scored') throw new Error('expected a score')

    expect(verdict.correct).toBe(false)
    expect(verdict.misconceptions).toEqual([])
  })
})

describe('what the help text promises about form', () => {
  const item = getDiagnosticItem('list-aliasing')

  it('accepts a printed list whether or not the commas are spaced', () => {
    // The answer box says capitalisation and the spaces around commas are not checked. This is
    // what makes that true. Before it was, a learner who correctly predicted the aliasing
    // result but typed it without spaces was marked wrong and given negative evidence.
    for (const typed of ['[1, 2, 3]', '[1,2,3]', '[1 , 2 , 3]', '  [1, 2, 3]  ']) {
      const verdict = scoreAnswer(item, typed)
      if (verdict.kind !== 'scored') throw new Error('expected a score')
      expect(verdict.correct, typed).toBe(true)
    }
  })

  it('still tells two different answers apart', () => {
    for (const typed of ['[1, 2]', '[1, 2, 3, 4]', '123']) {
      const verdict = scoreAnswer(item, typed)
      if (verdict.kind !== 'scored') throw new Error('expected a score')
      expect(verdict.correct, typed).toBe(false)
    }
  })

  it('does not run words together', () => {
    expect(normaliseAnswer('hello world')).not.toBe(normaliseAnswer('helloworld'))
  })
})

describe('scoring a practical task', () => {
  const item = getDiagnosticItem('code-count-evens')

  it('is correct only when every test passed', () => {
    const passed = scoreAnswer(item, 'code', { allTestsPassed: true, failedTests: [] })
    if (passed.kind !== 'scored') throw new Error('expected a score')
    expect(passed.correct).toBe(true)
    expect(passed.source).toBe('execution')

    const failed = scoreAnswer(item, 'code', {
      allTestsPassed: false,
      failedTests: ['counts evens in a mixed list'],
    })
    if (failed.kind !== 'scored') throw new Error('expected a score')
    expect(failed.correct).toBe(false)
  })

  it('treats a run where nothing passed as incorrect, however it ended', () => {
    // A program that raised, timed out or was terminated reports no passes, and that is the
    // only fact needed: there is no separate "did it crash" flag to keep in step.
    const verdict = scoreAnswer(item, 'code', { allTestsPassed: false, failedTests: [] })
    if (verdict.kind !== 'scored') throw new Error('expected a score')
    expect(verdict.correct).toBe(false)
  })

  it('refuses to score without a run result rather than guessing', () => {
    expect(() => scoreAnswer(item, 'code')).toThrow(/cannot be scored without a run result/)
  })
})

describe('scoring a free-text explanation', () => {
  it('declines, rather than pretending to judge it', () => {
    // The model boundary is kept visible instead of hidden inside a scoring function.
    expect(scoreAnswer(getDiagnosticItem('explain-scope'), 'because it is local')).toEqual({
      kind: 'needs-judgement',
    })
  })
})

describe('normalising an answer', () => {
  it('ignores case, blank lines and repeated spaces', () => {
    expect(normaliseAnswer('  Hello \n\n  World  ')).toBe('hello\nworld')
  })

  it('keeps line structure, because it is part of the answer', () => {
    expect(normaliseAnswer('a\nb')).not.toBe(normaliseAnswer('a b'))
  })
})

describe('choosing what to ask', () => {
  const plan = (answers: readonly AnsweredItem[], onboarding = BEGINNER) =>
    nextDecision({ answers, onboarding })

  it('starts a beginner at the easiest end', () => {
    const decision = plan([])
    if (decision.kind !== 'ask') throw new Error('expected an item')

    expect(decision.item.difficulty).toBeLessThan(-1)
    expect(decision.position).toBe(1)
  })

  it('starts an experienced learner higher up, without assuming they know it', () => {
    const beginnerFirst = plan([])
    const experiencedFirst = plan([], EXPERIENCED)
    if (beginnerFirst.kind !== 'ask' || experiencedFirst.kind !== 'ask') {
      throw new Error('expected items')
    }

    expect(experiencedFirst.item.difficulty).toBeGreaterThan(beginnerFirst.item.difficulty)
  })

  it('never asks the same item twice', () => {
    const answered: AnsweredItem[] = [
      { itemId: 'exec-order', conceptId: 'program-execution', correct: true },
    ]
    const decision = plan(answered)
    if (decision.kind !== 'ask') throw new Error('expected an item')

    expect(decision.item.id).not.toBe('exec-order')
  })

  it('gets harder after a correct answer and easier after a wrong one', () => {
    const rising = estimatedLevel({
      answers: [{ itemId: 'a', conceptId: 'program-execution', correct: true }],
      onboarding: BEGINNER,
    })
    const falling = estimatedLevel({
      answers: [{ itemId: 'a', conceptId: 'program-execution', correct: false }],
      onboarding: BEGINNER,
    })

    expect(rising).toBeGreaterThan(falling)
  })

  it('prefers an area it has not sampled yet', () => {
    // Six questions about loops tell us about loops. Coverage is what makes the profile useful.
    const decision = plan([
      { itemId: 'range-values', conceptId: 'for-loops-and-range', correct: true },
      { itemId: 'accumulator', conceptId: 'loop-accumulation', correct: true },
    ])
    if (decision.kind !== 'ask') throw new Error('expected an item')

    expect(getConcept(decision.item.conceptId).area).not.toBe('loops')
  })

  it('is deterministic', () => {
    const answers: AnsweredItem[] = [
      { itemId: 'exec-order', conceptId: 'program-execution', correct: true },
    ]
    expect(plan(answers)).toEqual(plan(answers))
  })
})

describe('what is deliberately not asked', () => {
  const failTwice = (conceptId: AnsweredItem['conceptId']): AnsweredItem[] => [
    { itemId: 'x1', conceptId, correct: false },
    { itemId: 'x2', conceptId, correct: false },
  ]

  it('takes two failures, not one, before writing off a concept', () => {
    // A single wrong answer is usually a slip, and cutting a learner off from a branch of the
    // curriculum on one mistake would be both wrong and demoralising.
    const once: AnsweredItem[] = [
      { itemId: 'x1', conceptId: 'if-statements', correct: false },
    ]
    const item = getDiagnosticItem('range-values')

    expect(FAILURES_BEFORE_SKIP).toBe(2)
    expect(isWorthAsking(item, { answers: once, onboarding: BEGINNER })).toBe(true)
    expect(
      isWorthAsking(item, { answers: failTwice('if-statements'), onboarding: BEGINNER }),
    ).toBe(false)
  })

  it('stops asking about concepts that rest on something clearly failed', () => {
    // Asking someone who cannot read a conditional to reason about nested loops tells us
    // nothing new and costs them an item.
    const answers = failTwice('if-statements')

    expect(isWorthAsking(getDiagnosticItem('accumulator'), { answers, onboarding: BEGINNER })).toBe(
      false,
    )
  })

  it('still asks about concepts on an unaffected branch', () => {
    const answers = failTwice('list-mutation-and-aliasing')

    expect(isWorthAsking(getDiagnosticItem('exec-order'), { answers, onboarding: BEGINNER })).toBe(
      true,
    )
  })

  it('reports only the concepts actually asked, so the rest stay unknown', () => {
    // Nothing is inferred from a skipped item. Those concepts remain not-started.
    const answers: AnsweredItem[] = [
      { itemId: 'exec-order', conceptId: 'program-execution', correct: true },
      { itemId: 'range-values', conceptId: 'for-loops-and-range', correct: false },
    ]

    expect(conceptsAsked(answers)).toEqual(['program-execution', 'for-loops-and-range'])
  })
})

describe('stopping', () => {
  function answerMany(count: number, correct: boolean): AnsweredItem[] {
    return DIAGNOSTIC_ITEMS.slice(0, count).map((item) => ({
      itemId: item.id,
      conceptId: item.conceptId,
      correct,
    }))
  }

  it('never asks more than the limit', () => {
    const decision = nextDecision({ answers: answerMany(MAX_ITEMS, true), onboarding: BEGINNER })

    expect(decision.kind).toBe('finished')
    if (decision.kind !== 'finished') throw new Error('expected finished')
    expect(decision.reason).toBe('reached-limit')
  })

  it('does not stop before the minimum, however clear the picture looks', () => {
    const decision = nextDecision({ answers: answerMany(MIN_ITEMS - 1, true), onboarding: BEGINNER })
    expect(decision.kind).toBe('ask')
  })

  it('can finish early once enough areas have been covered', () => {
    // The early-stop rule, stated exactly: past the minimum, with the target number of
    // competence areas sampled.
    const answers: AnsweredItem[] = [
      { itemId: 'exec-order', conceptId: 'program-execution', correct: true },
      { itemId: 'reassignment', conceptId: 'variables-and-assignment', correct: true },
      { itemId: 'division-result', conceptId: 'arithmetic-operators', correct: true },
      { itemId: 'if-else-once', conceptId: 'if-statements', correct: true },
      { itemId: 'range-values', conceptId: 'for-loops-and-range', correct: true },
      { itemId: 'list-index', conceptId: 'indexing-and-slicing', correct: true },
      { itemId: 'return-vs-print', conceptId: 'return-values', correct: true },
    ]

    const decision = nextDecision({ answers, onboarding: BEGINNER })
    expect(decision.kind).toBe('finished')
    if (decision.kind !== 'finished') throw new Error('expected finished')
    expect(decision.reason).toBe('covered-enough')
  })

  it('finishes when everything worth asking has been ruled out', () => {
    // A learner who fails the fundamentals has nothing left that would be informative.
    const answers: AnsweredItem[] = DIAGNOSTIC_ITEMS.map((item) => ({
      itemId: item.id,
      conceptId: item.conceptId,
      correct: false,
    }))

    const decision = nextDecision({ answers, onboarding: BEGINNER })
    if (decision.kind !== 'finished') throw new Error('expected finished')
    expect(decision.reason).toBe('nothing-left')
  })

  it('runs a whole diagnostic to completion for a strong learner', () => {
    const answers: AnsweredItem[] = []
    let asked = 0

    for (let step = 0; step < 30; step += 1) {
      const decision = nextDecision({ answers, onboarding: EXPERIENCED })
      if (decision.kind === 'finished') break
      answers.push({
        itemId: decision.item.id,
        conceptId: decision.item.conceptId,
        correct: true,
      })
      asked += 1
    }

    expect(asked).toBeGreaterThanOrEqual(MIN_ITEMS)
    expect(asked).toBeLessThanOrEqual(MAX_ITEMS)
  })

  it('runs a whole diagnostic to completion for a struggling learner', () => {
    const answers: AnsweredItem[] = []
    let asked = 0

    for (let step = 0; step < 30; step += 1) {
      const decision = nextDecision({ answers, onboarding: BEGINNER })
      if (decision.kind === 'finished') break
      answers.push({
        itemId: decision.item.id,
        conceptId: decision.item.conceptId,
        correct: false,
      })
      asked += 1
    }

    // Ends sooner than a strong learner's, because failed prerequisites rule items out — and
    // ends, rather than looping.
    expect(asked).toBeGreaterThan(0)
    expect(asked).toBeLessThanOrEqual(MAX_ITEMS)
  })
})

/*
 * The previous version of this told the learner "about 12" for the whole of a run that ended
 * at 7, and the test that was supposed to catch it compared a constant against itself. What is
 * asserted now is the property that actually matters: the range must contain the truth, and
 * neither end may move the wrong way.
 */
describe('what the learner is told about length', () => {
  it('never promises more questions than the limit', () => {
    expect(remaining({ answers: [], onboarding: BEGINNER }).most).toBeLessThanOrEqual(MAX_ITEMS)
  })

  it('starts by promising at least the minimum', () => {
    expect(remaining({ answers: [], onboarding: BEGINNER }).least).toBe(MIN_ITEMS)
  })

  it('closes on the truth from both sides, and never widens', () => {
    const answers: AnsweredItem[] = []
    let previous = remaining({ answers, onboarding: BEGINNER })
    let asked = 0

    for (let step = 0; step < 20; step += 1) {
      const decision = nextDecision({ answers, onboarding: BEGINNER })
      if (decision.kind === 'finished') break

      // The range always covers this question and every one still to come.
      expect(previous.least).toBeGreaterThanOrEqual(0)
      expect(previous.most).toBeGreaterThanOrEqual(previous.least)
      expect(previous.most).toBeGreaterThanOrEqual(1)

      answers.push({
        itemId: decision.item.id,
        conceptId: decision.item.conceptId,
        correct: step % 2 === 0,
      })
      asked += 1

      const now = remaining({ answers, onboarding: BEGINNER })
      // One question nearer the end: the far end can only come closer, and the near end can
      // only stay put or close in behind it.
      expect(now.most).toBeLessThanOrEqual(previous.most)
      expect(now.least).toBeLessThanOrEqual(previous.least)
      previous = now
    }

    // And the range really did contain the answer: nothing is left to ask.
    expect(remaining({ answers, onboarding: BEGINNER }).least).toBe(0)
    expect(asked).toBeGreaterThanOrEqual(MIN_ITEMS)
  })

  it('says the last question is the last one', () => {
    const answers: AnsweredItem[] = []
    const flags: boolean[] = []

    for (let step = 0; step < 20; step += 1) {
      const decision = nextDecision({ answers, onboarding: BEGINNER })
      if (decision.kind === 'finished') break
      flags.push(decision.isLast)
      answers.push({
        itemId: decision.item.id,
        conceptId: decision.item.conceptId,
        correct: true,
      })
    }

    // Exactly one question is announced as the last, and it is the last one asked.
    expect(flags.filter(Boolean)).toHaveLength(1)
    expect(flags[flags.length - 1]).toBe(true)
  })
})
