import { describe, expect, it } from 'vitest'

import { CONCEPTS } from '../curriculum/concepts'
import { SECURE_MARGIN, THETA_MAX, THETA_MIN } from '../learner-model/parameters'
import { bandOf } from '../learner-model/state'
import {
  MAX_SELF_REPORT_PRIOR,
  initialStatesFromSelfReport,
  priorFor,
  startingDifficulty,
  type Confidence,
  type ExperienceLevel,
  type OnboardingAnswers,
} from './self-report'

/**
 * What a learner says about themselves, and the very limited use it is put to.
 *
 * The rule this file exists to hold down is the one the brief states outright: saying "I am
 * advanced" must not produce a Secure concept without objective evidence. That rule is
 * enforced structurally — no evidence, no band — but the *size* of the prior matters too, and
 * an earlier version let it reach further than the comment beside it claimed.
 */

const EXPERIENCES: readonly ExperienceLevel[] = [
  'new-to-programming',
  'other-language',
  'some-python',
  'regular-python',
]

const CONFIDENCES: readonly Confidence[] = ['none', 'some', 'comfortable', 'confident']

function answers(overrides: Partial<OnboardingAnswers> = {}): OnboardingAnswers {
  return {
    goal: 'Understand the code I read at work',
    experience: 'some-python',
    interests: [],
    confidence: {},
    ...overrides,
  }
}

/** Every combination a learner could give, which is small enough to enumerate exhaustively. */
function everyClaim(): readonly OnboardingAnswers[] {
  const all: OnboardingAnswers[] = []
  for (const experience of EXPERIENCES) {
    for (const confidence of CONFIDENCES) {
      const claimed = Object.fromEntries(
        CONCEPTS.map((concept) => [concept.area, confidence]),
      ) as OnboardingAnswers['confidence']
      all.push(answers({ experience, confidence: claimed }))
    }
  }
  return all
}

describe('the size of the prior', () => {
  it('never moves a concept further than the cap, whatever the learner claims', () => {
    for (const claim of everyClaim()) {
      for (const concept of CONCEPTS) {
        const shift = priorFor(concept.id, claim) - concept.baselineDifficulty
        expect(Math.abs(shift), `${concept.id} / ${claim.experience}`).toBeLessThanOrEqual(
          MAX_SELF_REPORT_PRIOR + Number.EPSILON,
        )
      }
    }
  })

  /*
   * The invariant, rather than the number. Written against `SECURE_MARGIN` itself so that
   * lowering the margin later cannot silently re-open the gap this closed: self-report must
   * never be able to supply the whole distance to a band, even before the separate
   * requirements for evidence count and unaided successes are considered.
   */
  it('cannot supply the whole margin that secure requires', () => {
    expect(MAX_SELF_REPORT_PRIOR).toBeLessThan(SECURE_MARGIN)
  })

  it('keeps the estimate inside the representable range', () => {
    for (const claim of everyClaim()) {
      for (const concept of CONCEPTS) {
        const theta = priorFor(concept.id, claim)
        expect(theta).toBeGreaterThanOrEqual(THETA_MIN)
        expect(theta).toBeLessThanOrEqual(THETA_MAX)
      }
    }
  })

  it('moves confident claims up and uncertain ones down, relative to the same concept', () => {
    const concept = CONCEPTS[0]
    if (concept === undefined) throw new Error('the curriculum is empty')

    const shy = priorFor(concept.id, answers({ confidence: { [concept.area]: 'none' } }))
    const bold = priorFor(concept.id, answers({ confidence: { [concept.area]: 'confident' } }))

    expect(bold).toBeGreaterThan(shy)
  })

  it('says nothing at all when the learner says nothing', () => {
    // No confidence given for this area and a neutral-ish experience: the estimate should sit
    // at the concept's own difficulty, not somewhere invented.
    const concept = CONCEPTS[0]
    if (concept === undefined) throw new Error('the curriculum is empty')

    const shift = priorFor(concept.id, answers({ experience: 'some-python' })) -
      concept.baselineDifficulty
    expect(Math.abs(shift)).toBeLessThanOrEqual(0.5)
  })
})

describe('what a claim cannot do', () => {
  it('leaves every concept not started, however confident the learner says they are', () => {
    for (const claim of everyClaim()) {
      for (const state of initialStatesFromSelfReport(claim)) {
        expect(bandOf(state), `${state.conceptId} / ${claim.experience}`).toBe('not-started')
      }
    }
  })

  it('contributes no evidence of any kind', () => {
    for (const claim of everyClaim()) {
      for (const state of initialStatesFromSelfReport(claim)) {
        expect(state.evidenceCount).toBe(0)
        expect(state.successes).toBe(0)
        expect(state.unaidedSuccesses).toBe(0)
      }
    }
  })

  it('covers every concept, so nothing is left without a starting position', () => {
    const states = initialStatesFromSelfReport(answers())
    expect(states).toHaveLength(CONCEPTS.length)
    expect(new Set(states.map((state) => state.conceptId)).size).toBe(CONCEPTS.length)
  })
})

describe('where the diagnostic starts asking', () => {
  /*
   * A separate table from the ability prior, and this is why. Deriving one from the other
   * produced an absolute beginner opened on a question about variables rather than on the
   * easiest item in the bank, because "where do we think they are" and "what is worth asking
   * first" are different questions with different answers.
   */
  it('rises with claimed experience', () => {
    const levels = EXPERIENCES.map((experience) => startingDifficulty(answers({ experience })))

    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index], EXPERIENCES[index]).toBeGreaterThan(levels[index - 1] ?? 0)
    }
  })

  it('ignores per-area confidence, which is not what it is for', () => {
    const bold = startingDifficulty(answers({ confidence: { loops: 'confident' } }))
    const shy = startingDifficulty(answers({ confidence: { loops: 'none' } }))

    expect(bold).toBe(shy)
  })
})
