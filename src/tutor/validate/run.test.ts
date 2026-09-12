import { describe, expect, it } from 'vitest'

import * as fixtures from '@/llm/fixtures'
import { MockProvider } from '@/llm/mock-provider'

import { answerEvaluateStrategy, quizGenerateStrategy } from '../strategies/assessment'
import { hintStrategy } from '../strategies/coding'
import { profileUpdateStrategy } from '../strategies/profile'
import { UNKNOWN_LEARNER } from '../blocks/learner'
import { runStructured } from './run'

/**
 * The validation pipeline: schema, invariants, one repair, deterministic fallback.
 *
 * This is the seam where untrusted output becomes something the application acts on, so the
 * behaviour that matters is what happens when it is *wrong* — and specifically that wrong
 * output is rejected whole rather than quietly patched into something plausible.
 */

const answerInput = {
  learner: UNKNOWN_LEARNER,
  conceptId: 'for-loops-and-range',
  question: 'What does range(3) produce?',
  expected: '0, 1, 2',
  learnerAnswer: '0 1 2',
} as const

const quizInput = {
  learner: UNKNOWN_LEARNER,
  conceptId: 'for-loops-and-range',
  avoid: [],
} as const

const profileInput = {
  learner: UNKNOWN_LEARNER,
  conceptId: 'for-loops-and-range',
  activityDescription: 'What does range(3) produce?',
  learnerResponse: '0 1 2 3',
  wasCorrect: false,
  hintDepth: 0,
} as const

describe('a valid response passes straight through', () => {
  it('returns the value without repairing anything', async () => {
    const provider = new MockProvider().on('answer.evaluate', fixtures.ANSWER_CORRECT)

    const outcome = await runStructured(provider, answerEvaluateStrategy, answerInput)

    expect(outcome.ok).toBe(true)
    expect(outcome.value?.verdict).toBe('correct')
    expect(outcome.repairAttempted).toBe(false)
    expect(outcome.ok && outcome.source).toBe('model')
    expect(outcome.problems).toEqual([])
    expect(provider.calls).toHaveLength(1)
  })
})

describe('schema violations', () => {
  it('rejects a response missing a required field', async () => {
    const provider = fixtures.repairFails('answer.evaluate', fixtures.INVALID_MISSING_FIELD)

    const outcome = await runStructured(provider, answerEvaluateStrategy, answerInput)

    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? null : outcome.failureReason).toBe('invalid')
    expect(outcome.problems.map((problem) => problem.code)).toContain('schema-violation')
  })

  it('rejects text past the cap rather than truncating it', async () => {
    // Truncating would change what the explanation says, and the learner would read the
    // half of it that survived as though it were the whole thought.
    const provider = fixtures.repairFails('answer.evaluate', fixtures.INVALID_OVERSIZED)

    const outcome = await runStructured(provider, answerEvaluateStrategy, answerInput)

    expect(outcome.ok).toBe(false)
    expect(outcome.value).toBeNull()
  })

  it('rejects a response that is not the right shape at all', async () => {
    const provider = fixtures.repairFails('answer.evaluate', fixtures.INVALID_NONSENSE)

    expect((await runStructured(provider, answerEvaluateStrategy, answerInput)).ok).toBe(false)
  })
})

describe('invariant violations the schema cannot express', () => {
  it('rejects duplicated quiz options', async () => {
    const provider = fixtures.repairFails('quiz.generate', fixtures.INVALID_DUPLICATE_OPTIONS)

    const outcome = await runStructured(provider, quizGenerateStrategy, quizInput)

    expect(outcome.ok).toBe(false)
    expect(outcome.problems.map((problem) => problem.code)).toContain('duplicate-options')
  })

  it('rejects a misconception attached to the correct option', async () => {
    const provider = fixtures.repairFails('quiz.generate', {
      kind: 'value',
      value: {
        ...(fixtures.QUIZ_ON_RANGE as { value: Record<string, unknown> }).value,
        distractorMisconceptions: ['range-endpoint-inclusive', null, null, null],
      },
    })

    const outcome = await runStructured(provider, quizGenerateStrategy, quizInput)

    expect(outcome.problems.map((problem) => problem.code)).toContain(
      'misconception-on-correct-option',
    )
  })

  it('rejects an answer marked correct that also carries misconceptions', async () => {
    // Contradictory as evidence: the same attempt would count for and against the concept.
    const provider = fixtures.repairFails('answer.evaluate', {
      kind: 'value',
      value: {
        verdict: 'correct',
        explanation: 'Right.',
        misconceptions: ['range-endpoint-inclusive'],
        nearMiss: false,
      },
    })

    const outcome = await runStructured(provider, answerEvaluateStrategy, answerInput)

    expect(outcome.problems.map((problem) => problem.code)).toContain(
      'misconception-on-correct-answer',
    )
  })

  it('rejects an observation about a concept the activity was not about', async () => {
    const provider = fixtures.repairFails('profile.update', {
      kind: 'value',
      value: {
        demonstratedConcepts: ['classes-and-objects'],
        misconceptions: [],
        judgement: 'slip',
        evidence: 'They got it wrong.',
      },
    })

    const outcome = await runStructured(provider, profileUpdateStrategy, profileInput)

    expect(outcome.problems.map((problem) => problem.code)).toContain('concept-not-covered')
  })

  it('rejects a judgement that contradicts an outcome already decided', async () => {
    const provider = fixtures.repairFails('profile.update', {
      kind: 'value',
      value: {
        demonstratedConcepts: ['for-loops-and-range'],
        misconceptions: [],
        judgement: 'sound',
        evidence: 'Looks fine.',
      },
    })

    const outcome = await runStructured(provider, profileUpdateStrategy, profileInput)

    expect(outcome.problems.map((problem) => problem.code)).toContain(
      'judgement-contradicts-outcome',
    )
  })

  it('rejects a hint that hands over the solution', async () => {
    const provider = fixtures.repairFails('hint', fixtures.INVALID_HINT_REVEALS_SOLUTION)

    const outcome = await runStructured(provider, hintStrategy, {
      learner: UNKNOWN_LEARNER,
      conceptId: 'for-loops-and-range',
      brief: 'Count the even numbers in a list.',
      learnerAttempt: null,
      depth: 1,
      previousHints: [],
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.problems.map((problem) => problem.code)).toContain('reveals-solution')
  })
})

describe('unknown identifiers never reach the domain', () => {
  it('rejects a concept that does not exist', async () => {
    const provider = fixtures.repairFails('profile.update', fixtures.INVALID_UNKNOWN_CONCEPT)

    const outcome = await runStructured(provider, profileUpdateStrategy, profileInput)

    expect(outcome.value?.demonstratedConcepts).not.toContain('quantum-loops')
    expect(outcome.ok && outcome.source).toBe('fallback')
  })

  it('rejects a misconception that does not exist', async () => {
    const provider = fixtures.repairFails(
      'answer.evaluate',
      fixtures.INVALID_UNKNOWN_MISCONCEPTION,
    )

    const outcome = await runStructured(provider, answerEvaluateStrategy, answerInput)

    expect(outcome.ok).toBe(false)
    expect(outcome.value).toBeNull()
  })
})

describe('bounded repair', () => {
  it('asks once, and uses the corrected response', async () => {
    const provider = fixtures.repairSucceeds(
      'quiz.generate',
      fixtures.INVALID_DUPLICATE_OPTIONS,
      fixtures.QUIZ_ON_RANGE,
    )

    const outcome = await runStructured(provider, quizGenerateStrategy, quizInput)

    expect(outcome.ok).toBe(true)
    expect(outcome.repairAttempted).toBe(true)
    expect(outcome.repairSucceeded).toBe(true)
    expect(provider.calls).toHaveLength(2)
  })

  it('tells the model what was wrong, without echoing its bad output back', async () => {
    const provider = fixtures.repairSucceeds(
      'quiz.generate',
      fixtures.INVALID_DUPLICATE_OPTIONS,
      fixtures.QUIZ_ON_RANGE,
    )

    await runStructured(provider, quizGenerateStrategy, quizInput)

    const repairPrompt = provider.calls[1]?.prompt ?? ''
    expect(repairPrompt).toContain('could not be used')
    expect(repairPrompt).toContain('Every option must be distinct')
    // Re-sending the invalid response invites editing around it rather than reconsidering.
    expect(repairPrompt).not.toContain('"correctIndex"')
  })

  it('gives up after one repair rather than looping', async () => {
    const provider = fixtures.repairFails('quiz.generate', fixtures.INVALID_DUPLICATE_OPTIONS)

    const outcome = await runStructured(provider, quizGenerateStrategy, quizInput)

    expect(outcome.ok).toBe(false)
    expect(outcome.repairSucceeded).toBe(false)
    // Exactly two calls: the original and one repair. Never a third.
    expect(provider.calls).toHaveLength(2)
  })

  it('records every problem from both attempts', async () => {
    const provider = fixtures.repairFails('quiz.generate', fixtures.INVALID_DUPLICATE_OPTIONS)

    const outcome = await runStructured(provider, quizGenerateStrategy, quizInput)

    expect(outcome.problems.length).toBeGreaterThanOrEqual(2)
  })
})

describe('failures that repair cannot fix', () => {
  it('does not retry a refusal', async () => {
    // The model did not produce something wrong; it produced nothing. Asking again just asks
    // the same question.
    const provider = new MockProvider().on('answer.evaluate', fixtures.REFUSED)

    const outcome = await runStructured(provider, answerEvaluateStrategy, answerInput)

    expect(outcome.ok ? null : outcome.failureReason).toBe('refused')
    expect(outcome.repairAttempted).toBe(false)
    expect(provider.calls).toHaveLength(1)
  })

  it('does not retry an unreachable provider', async () => {
    const provider = new MockProvider().on('answer.evaluate', fixtures.UNAVAILABLE)

    const outcome = await runStructured(provider, answerEvaluateStrategy, answerInput)

    expect(outcome.ok ? null : outcome.failureReason).toBe('unavailable')
    expect(provider.calls).toHaveLength(1)
  })

  it('reports a configuration problem distinctly from an outage', async () => {
    const provider = new MockProvider().on('answer.evaluate', fixtures.MISCONFIGURED)

    const outcome = await runStructured(provider, answerEvaluateStrategy, answerInput)

    expect(outcome.ok ? null : outcome.failureReason).toBe('misconfigured')
    expect(outcome.ok ? null : outcome.message).toContain('configured')
  })

  it('never puts provider detail into the learner-facing message', async () => {
    const provider = new MockProvider().on('answer.evaluate', fixtures.UNAVAILABLE)

    const outcome = await runStructured(provider, answerEvaluateStrategy, answerInput)

    expect(outcome.ok ? null : outcome.message).not.toContain('ETIMEDOUT')
  })
})

describe('deterministic fallbacks', () => {
  it('falls back for profile.update, because the attempt still happened', async () => {
    const provider = fixtures.repairFails('profile.update', fixtures.INVALID_NONSENSE)

    const outcome = await runStructured(provider, profileUpdateStrategy, profileInput)

    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.source).toBe('fallback')
    expect(outcome.value?.demonstratedConcepts).toEqual(['for-loops-and-range'])
    expect(outcome.value?.misconceptions).toEqual([])
    expect(outcome.value?.judgement).toBe('unclear')
    expect(outcome.value?.evidence).toContain('could not interpret')
  })

  it('invents nothing in that fallback', async () => {
    // No misconception, no confident judgement — only what is certainly true.
    const provider = fixtures.repairFails('profile.update', fixtures.INVALID_NONSENSE)

    const outcome = await runStructured(provider, profileUpdateStrategy, profileInput)

    expect(outcome.value?.misconceptions).toEqual([])
    expect(outcome.value?.judgement).toBe('unclear')
  })

  it('has no fallback for anything that would fabricate a judgement', async () => {
    // A made-up quiz would be asked of a real learner and its answer recorded as evidence.
    const provider = fixtures.repairFails('quiz.generate', fixtures.INVALID_NONSENSE)

    const outcome = await runStructured(provider, quizGenerateStrategy, quizInput)

    expect(outcome.value).toBeNull()
    expect(outcome.ok).toBe(false)
  })

  it('is deterministic', async () => {
    const first = await runStructured(
      fixtures.repairFails('profile.update', fixtures.INVALID_NONSENSE),
      profileUpdateStrategy,
      profileInput,
    )
    const second = await runStructured(
      fixtures.repairFails('profile.update', fixtures.INVALID_NONSENSE),
      profileUpdateStrategy,
      profileInput,
    )

    expect(first.value).toEqual(second.value)
  })
})

describe('nothing is silently coerced', () => {
  it('does not drop the offending option to make a quiz valid', async () => {
    const provider = fixtures.repairFails('quiz.generate', fixtures.INVALID_DUPLICATE_OPTIONS)

    const outcome = await runStructured(provider, quizGenerateStrategy, quizInput)

    // Removing a duplicate would leave three options and change the question.
    expect(outcome.value).toBeNull()
  })

  it('does not strip an unknown identifier and keep the rest', async () => {
    const provider = fixtures.repairFails('profile.update', {
      kind: 'value',
      value: {
        demonstratedConcepts: ['for-loops-and-range', 'quantum-loops'],
        misconceptions: [],
        judgement: 'slip',
        evidence: 'They mis-read the endpoint.',
      },
    })

    const outcome = await runStructured(provider, profileUpdateStrategy, profileInput)

    // It fell back rather than keeping the half that parsed: a partially-believed
    // observation is not a smaller version of the truth, it is a different claim.
    expect(outcome.ok && outcome.source).toBe('fallback')
    expect(outcome.value?.judgement).toBe('unclear')
  })
})
