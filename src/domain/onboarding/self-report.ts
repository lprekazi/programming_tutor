import type { Area, ConceptId } from '../curriculum/types'
import { CONCEPTS } from '../curriculum/concepts'
import { INITIAL_UNCERTAINTY, THETA_MAX, THETA_MIN } from '../learner-model/parameters'
import { initialConceptState, type ConceptState } from '../learner-model/state'

/**
 * What the learner says about themselves, and the very limited use it is put to.
 *
 * Self-report is information, and ignoring it would be wasteful — someone who has written
 * Python for a year should not be asked what a variable is. But it is not evidence, and the
 * distinction is load-bearing: a learner who says "advanced" has demonstrated nothing, and the
 * interface must not tell them they are secure in anything on their own word.
 *
 * So it does exactly two things:
 *
 *   1. It shifts the starting ability estimate, by a small capped amount.
 *   2. It decides where the diagnostic starts asking.
 *
 * What it does **not** do is contribute evidence. `evidenceCount` stays at zero, and because
 * `bandOf` reports `not-started` for any state with no evidence, no band can be earned from a
 * claim. Every band a learner ends up with was paid for with an answer.
 */

/** How confident the learner says they are in an area. */
export type Confidence = 'none' | 'some' | 'comfortable' | 'confident'

/** Broad self-assessment, one answer per competence area. */
export type SelfReport = Partial<Record<Area, Confidence>>

export type ExperienceLevel =
  /** Never written code. */
  | 'new-to-programming'
  /** Has programmed, but not in Python. */
  | 'other-language'
  /** Has written some Python. */
  | 'some-python'
  /** Writes Python regularly. */
  | 'regular-python'

export interface OnboardingAnswers {
  /** What the learner wants out of this, in their own words. */
  readonly goal: string
  readonly experience: ExperienceLevel
  /** Areas they said they care about. Used for ordering, never for scoring. */
  readonly interests: readonly Area[]
  readonly confidence: SelfReport
}

/**
 * How far each claim moves the starting estimate, in logits.
 *
 * Capped deliberately low, and the cap is the number that matters. A per-area claim reaches
 * ±0.6 and the blanket experience term another ±0.5, so the *sum* is what has to be held
 * down: `MAX_SELF_REPORT_PRIOR` does that.
 *
 * It is set below `SECURE_MARGIN` on purpose. An earlier version capped at 1.0, which is more
 * than the 0.8 margin `secure` requires — so a learner who called themselves confident arrived
 * at the same band on measurably less demonstrated work than a learner who called themselves a
 * beginner and answered identically. No band could be *claimed* without evidence either way,
 * because `bandOf` reports `not-started` at zero evidence, so the stated architectural rule
 * held; but the prior was doing more work than the comment beside it admitted, and two learners
 * giving the same answers should not end up in different places because of what they said
 * about themselves beforehand.
 */
const CONFIDENCE_PRIOR: Readonly<Record<Confidence, number>> = {
  none: -0.6,
  some: -0.2,
  comfortable: 0.2,
  confident: 0.6,
}

/** A blanket adjustment from overall experience, applied on top of the per-area claim. */
const EXPERIENCE_PRIOR: Readonly<Record<ExperienceLevel, number>> = {
  'new-to-programming': -0.5,
  'other-language': -0.1,
  'some-python': 0.1,
  'regular-python': 0.4,
}

/**
 * The largest total shift any combination of claims can produce.
 *
 * Strictly less than `SECURE_MARGIN`, so self-report can never supply the whole distance to a
 * band even before the separate requirements for evidence count and unaided successes are
 * considered. Asserted in `self-report.test.ts` against the parameter itself, so lowering the
 * margin later cannot silently re-open the gap.
 */
export const MAX_SELF_REPORT_PRIOR = 0.6

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * The starting estimate for one concept, given what the learner said.
 *
 * Expressed relative to the concept's own difficulty, so "comfortable with loops" means
 * comfortable *for loops* rather than a position on an absolute scale.
 */
export function priorFor(conceptId: ConceptId, answers: OnboardingAnswers): number {
  const concept = CONCEPTS.find((candidate) => candidate.id === conceptId)
  if (concept === undefined) return 0

  const claimed = answers.confidence[concept.area]
  const areaPrior = claimed === undefined ? 0 : CONFIDENCE_PRIOR[claimed]
  const shift = clamp(
    areaPrior + EXPERIENCE_PRIOR[answers.experience],
    -MAX_SELF_REPORT_PRIOR,
    MAX_SELF_REPORT_PRIOR,
  )

  return clamp(concept.baselineDifficulty + shift, THETA_MIN, THETA_MAX)
}

/**
 * Builds the starting state for every concept from the learner's own account.
 *
 * Every state comes back with `evidenceCount: 0`, so every band is `not-started`. That is the
 * point: the estimate has a starting position, and the learner has demonstrated nothing yet.
 */
export function initialStatesFromSelfReport(answers: OnboardingAnswers): readonly ConceptState[] {
  return CONCEPTS.map((concept) => ({
    ...initialConceptState(concept.id),
    theta: priorFor(concept.id, answers),
    // Left untouched, and this is the whole guarantee: no evidence, therefore no band, no
    // matter what the learner claimed.
    uncertainty: INITIAL_UNCERTAINTY,
    evidenceCount: 0,
    successes: 0,
    unaidedSuccesses: 0,
  }))
}

/**
 * Where the diagnostic should start asking.
 *
 * A separate table from the ability prior above, deliberately. They answer different
 * questions — one is "where do we think they are", the other is "what is worth asking first" —
 * and deriving the second from the first produced a poor answer: an absolute beginner was
 * pitched a question about variables rather than the easiest item in the bank.
 *
 * The beginner's value sits below the easiest item on purpose, so the nearest item genuinely
 * is the easiest. The experienced end sits high so that someone who writes Python regularly is
 * not asked what a variable is — not because they are assumed to know it, but because it
 * wastes an item and their patience. Get it wrong and the diagnostic drops back immediately;
 * nothing whatever is inferred from where it started.
 */
const STARTING_DIFFICULTY: Readonly<Record<ExperienceLevel, number>> = {
  'new-to-programming': -2,
  'other-language': -0.8,
  'some-python': 0.2,
  'regular-python': 1.2,
}

export function startingDifficulty(answers: OnboardingAnswers): number {
  return STARTING_DIFFICULTY[answers.experience]
}
