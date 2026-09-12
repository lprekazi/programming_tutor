import { describe, expect, it } from 'vitest'

import { practiceItemsFor } from '@/domain/assessment/items'
import { markJudgement } from '@/domain/assessment/score'
import { decideCheck } from '@/domain/assessment/select'
import { initialConceptState } from '@/domain/learner-model/state'
import {
  ANSWER_CANNOT_TELL,
  ANSWER_CANNOT_TELL_WITH_TAG,
  ANSWER_CORRECT,
  ANSWER_PARTIAL,
  ANSWER_SHOWS_MISCONCEPTION,
  INVALID_DUPLICATE_OPTIONS,
  INVALID_MISSING_FIELD,
  INVALID_NONSENSE,
  INVALID_OVERSIZED,
  QUIZ_MISCONCEPTION_ON_CORRECT,
  QUIZ_ON_RANGE,
  QUIZ_UNKNOWN_MISCONCEPTION,
  REFUSED,
  UNAVAILABLE,
  repairFails,
  repairSucceeds,
} from '@/llm/fixtures'
import { MockProvider, type MockResponse } from '@/llm/mock-provider'

import { InMemoryCallLog } from '../logging/call-log'
import { answerEvaluateStrategy } from '../strategies/assessment'
import { prepareAuthored, prepareGenerated } from './checks'
import { runLoggedStructured } from './tutor'
import { tutoringContext } from './context'

/**
 * The two places a model touches a check: writing one, and reading a written answer.
 *
 * Both are trust boundaries, and they fail differently. A generated question that is subtly
 * broken gets *asked of a real learner* and its answer recorded as evidence about them, so
 * nothing questionable may be shown at all. A judged answer is evidence directly, so a judge
 * that cannot be trusted on a particular answer has to be able to say so and be believed.
 *
 * Every case here is a provider behaving badly in a way providers actually behave: a repeated
 * option, an invented misconception id, a refusal, an outage, a diagnosis attached to an
 * answer it has just said it cannot read.
 */

const LEARNER = tutoringContext({
  goal: 'Understand loops',
  conceptId: 'for-loops-and-range',
  states: [initialConceptState('for-loops-and-range')],
  recentMisconceptions: [],
})

function generateWith(provider: MockProvider, log = new InMemoryCallLog()) {
  return prepareGenerated({
    provider,
    model: 'test-model',
    conceptId: 'for-loops-and-range',
    learner: LEARNER,
    avoid: [],
    ground: { kind: 'no-evidence-yet' },
    seed: 'seed-1',
    log,
    now: () => 1_000,
  })
}

function generatorReturning(response: MockResponse): MockProvider {
  return new MockProvider().on('quiz.generate', response)
}

describe('generating a question', () => {
  it('produces one that can be stored, marked and attributed', async () => {
    const log = new InMemoryCallLog()
    const prepared = await generateWith(generatorReturning(QUIZ_ON_RANGE), log)

    if (prepared === null) throw new Error('expected a question')
    expect(prepared.origin).toBe('generated')
    expect(prepared.options).toHaveLength(4)
    expect(prepared.kind).toBe('choice')
    // Attributable to the prompt that wrote it, which is what makes a later audit possible.
    expect(prepared.strategyId).toBe('quiz.generate')
    expect(prepared.strategyVersion).toBe('2')
    expect(prepared.model).toBe('test-model')
    expect(prepared.itemId).toBeNull()
    expect(log.logs).toHaveLength(1)
  })

  it('shuffles the options, so the generator cannot decide where the answer sits', async () => {
    const positions = new Set<number>()

    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const prepared = await prepareGenerated({
        provider: generatorReturning(QUIZ_ON_RANGE),
        model: 'test-model',
        conceptId: 'for-loops-and-range',
        learner: LEARNER,
        avoid: [],
        ground: { kind: 'no-evidence-yet' },
        seed,
        log: new InMemoryCallLog(),
        now: () => 1_000,
      })
      if (prepared === null) throw new Error('expected a question')

      // Whatever the order, the stored answer and its options stay consistent with each other.
      expect(prepared.options?.[prepared.correctIndex ?? -1]).toBe('0 1 2')
      positions.add(prepared.correctIndex ?? -1)
    }

    expect(positions.size).toBeGreaterThan(1)
  })

  /*
   * Each of these is shown to nobody. The alternative — asking it anyway — would put a
   * question the system knows to be broken in front of a learner and then record their answer
   * as evidence about them.
   */
  it.each([
    ['two options that say the same thing', INVALID_DUPLICATE_OPTIONS],
    ['a misconception on the correct option', QUIZ_MISCONCEPTION_ON_CORRECT],
    ['a misconception id that does not exist', QUIZ_UNKNOWN_MISCONCEPTION],
    ['a missing field', INVALID_MISSING_FIELD],
    ['nothing usable at all', INVALID_NONSENSE],
  ])('asks nothing when the model returns %s', async (_case, response) => {
    expect(await generateWith(repairFails('quiz.generate', response))).toBeNull()
  })

  it('records why nothing was asked, in codes an audit can count', async () => {
    const log = new InMemoryCallLog()
    await generateWith(repairFails('quiz.generate', INVALID_DUPLICATE_OPTIONS), log)

    const entry = log.logs[0]
    expect(entry?.outcome).toBe('failed')
    expect(entry?.repairAttempted).toBe(true)
    expect(entry?.problemCodes).toContain('duplicate-options')
    // Nothing the model wrote is in the log. A prompt or a response there would make the log a
    // second copy of the conversation.
    expect(JSON.stringify(entry)).not.toContain('range(3)')
  })

  it('asks the repaired question when the second attempt is sound', async () => {
    const log = new InMemoryCallLog()
    const prepared = await generateWith(
      repairSucceeds('quiz.generate', INVALID_DUPLICATE_OPTIONS, QUIZ_ON_RANGE),
      log,
    )

    expect(prepared).not.toBeNull()
    expect(log.logs[0]?.outcome).toBe('ok-after-repair')
    expect(log.logs[0]?.repairSucceeded).toBe(true)
  })

  it.each([
    ['refuses', REFUSED],
    ['is unreachable', UNAVAILABLE],
  ])('asks nothing when the provider %s', async (_case, response) => {
    expect(await generateWith(generatorReturning(response))).toBeNull()
  })

  it('asks nothing when the model returns a question already asked', async () => {
    // The mock returns the same fixture however often it is asked, which is exactly the
    // behaviour a real model shows when it ignores the avoid list.
    const prepared = await prepareGenerated({
      provider: repairFails('quiz.generate', QUIZ_ON_RANGE),
      model: 'test-model',
      conceptId: 'for-loops-and-range',
      learner: LEARNER,
      avoid: ['What does this print?\n\nfor i in range(3):\n    print(i)'],
      ground: { kind: 'no-evidence-yet' },
      seed: 'seed-1',
      log: new InMemoryCallLog(),
      now: () => 1_000,
    })

    expect(prepared).toBeNull()
  })

  it('has no fallback question, because there is no fair one', async () => {
    // The point of a null fallback: a generic question would still be marked, and its answer
    // would still change what the application believes about a person.
    const prepared = await generateWith(repairFails('quiz.generate', INVALID_NONSENSE))

    expect(prepared).toBeNull()
  })
})

describe('judging a written answer', () => {
  async function judge(response: MockResponse, log = new InMemoryCallLog()) {
    return await runLoggedStructured(
      new MockProvider().on('answer.evaluate', response),
      answerEvaluateStrategy,
      {
        learner: LEARNER,
        conceptId: 'for-loops-and-range',
        question: 'In your own words: what does range(3) give you?',
        expected: 'The values 0, 1 and 2.',
        learnerAnswer: 'It counts 0, 1, 2 and stops before 3.',
      },
      { model: 'test-model', log, now: () => 1_000 },
    )
  }

  it('turns a sound judgement into evidence, marked as a judgement', async () => {
    const outcome = await judge(ANSWER_CORRECT)
    if (!outcome.ok) throw new Error('expected a verdict')

    const marking = markJudgement(outcome.value)
    expect(marking).toMatchObject({ kind: 'marked', correct: true, partial: false, source: 'model' })
  })

  it('treats a partial answer as a success that counts for less', async () => {
    const outcome = await judge(ANSWER_PARTIAL)
    if (!outcome.ok) throw new Error('expected a verdict')

    // ADR-0005: never a penalty, never a band drop — a success with something missing.
    expect(markJudgement(outcome.value)).toMatchObject({
      kind: 'marked',
      correct: true,
      partial: true,
    })
  })

  it('records the wrong idea it names, when it says the answer is wrong', async () => {
    const outcome = await judge(ANSWER_SHOWS_MISCONCEPTION)
    if (!outcome.ok) throw new Error('expected a verdict')

    expect(markJudgement(outcome.value)).toMatchObject({
      kind: 'marked',
      correct: false,
      misconceptions: ['range-endpoint-inclusive'],
    })
  })

  /*
   * The verdict M5 added, and the reason for adding it. A judge with no opinion can now say so,
   * and the answer leaves no mark either way.
   */
  it('records nothing at all when the judge cannot tell', async () => {
    const outcome = await judge(ANSWER_CANNOT_TELL)
    if (!outcome.ok) throw new Error('expected a verdict')

    expect(markJudgement(outcome.value).kind).toBe('unmarked')
  })

  it('refuses a declined verdict that still tries to deposit a diagnosis', async () => {
    const outcome = await judge(ANSWER_CANNOT_TELL_WITH_TAG)

    // Not repaired into something usable: the same contradiction twice is a failure, and a
    // failure here means the attempt is unmarked rather than marked on a guess.
    expect(outcome.ok).toBe(false)
    expect(outcome.problems.map((problem) => problem.code)).toContain(
      'misconception-on-unjudgeable-answer',
    )
  })

  it.each([
    ['refuses', REFUSED],
    ['is unreachable', UNAVAILABLE],
    ['returns an answer past the length cap', INVALID_OVERSIZED],
  ])('leaves the answer unmarked when the judge %s', async (_case, response) => {
    const outcome = await judge(response)

    expect(outcome.ok).toBe(false)
    // No fallback verdict exists, so there is nothing for a caller to mistake for one.
    expect(outcome.value).toBeNull()
  })

  it('has no field through which a verdict could carry a number', async () => {
    const outcome = await judge(ANSWER_CORRECT)
    if (!outcome.ok) throw new Error('expected a verdict')

    expect(Object.keys(outcome.value).sort()).toEqual([
      'explanation',
      'misconceptions',
      'nearMiss',
      'verdict',
    ])
  })
})

describe('an authored question, for comparison', () => {
  it('needs no provider at all, which is why it is preferred', () => {
    const decision = decideCheck({
      conceptId: 'for-loops-and-range',
      state: initialConceptState('for-loops-and-range'),
      recentMisconceptions: [],
      usedItemIds: [],
      assessed: [],
      exchanges: 2,
      checksSoFar: 0,
      lastWasCheck: false,
    })
    if (decision.kind !== 'ask') throw new Error('expected a question')

    const prepared = prepareAuthored(decision, 'turn-1')

    expect(prepared.origin).toBe('authored')
    expect(prepared.strategyId).toBeNull()
    expect(prepared.model).toBeNull()
    expect(practiceItemsFor('for-loops-and-range').map((item) => item.id)).toContain(
      prepared.itemId,
    )
  })
})
