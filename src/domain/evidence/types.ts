import type { ConceptId, MisconceptionId } from '../curriculum/types'
import type { Band } from '../learner-model/state'

/**
 * The record of why the learner model changed.
 *
 * Every movement in an estimate is traceable to one attempt, with the numbers before and
 * after and a sentence a learner could read. This is what makes the Concepts view able to
 * answer "why did this change?", and what stops the model being an opaque score.
 */

/**
 * One judged attempt: the input to the model.
 *
 * A language model may have decided whether the answer was right and which misconceptions
 * it showed, but it produces *this* — a judgement about one attempt from a closed
 * vocabulary. It never proposes a mastery value. Converting a judgement into a change in
 * learner state is arithmetic that happens here, in code, where it can be tested.
 */
export interface JudgedAttempt {
  readonly attemptId: string
  readonly conceptId: ConceptId
  /** Identifies the item, so calibration observations can be grouped later. */
  readonly itemId: string
  /** Declared difficulty of the item. A prior, never revised (ADR-0004). */
  readonly itemDifficulty: number
  readonly correct: boolean
  /** 0 when unaided; 1 upwards for each hint taken before answering. */
  readonly hintDepth: number
  /** Misconceptions observed, drawn from the closed catalogue. */
  readonly misconceptions: readonly MisconceptionId[]
  readonly observedAt: number
}

export interface EvidenceRecord {
  readonly attemptId: string
  readonly conceptId: ConceptId
  readonly correct: boolean
  readonly hintDepth: number
  readonly priorTheta: number
  readonly posteriorTheta: number
  readonly delta: number
  readonly priorUncertainty: number
  readonly posteriorUncertainty: number
  readonly priorBand: Band
  readonly posteriorBand: Band
  /** Probability of success the model gave before seeing the outcome. */
  readonly expected: number
  /** Weight the outcome carried after hint attenuation. */
  readonly weight: number
  /** A sentence a learner could read, explaining this change. */
  readonly reason: string
  readonly observedAt: number
}

export interface MisconceptionObservation {
  readonly attemptId: string
  readonly conceptId: ConceptId
  readonly misconceptionId: MisconceptionId
  readonly observedAt: number
}

/**
 * A recorded mismatch between an item's declared difficulty and what happened.
 *
 * Written for later analysis, never acted on. With one learner, an unexpected outcome
 * cannot be attributed to the item rather than the learner — so the observation is kept as
 * evidence and the item's difficulty is left alone (ADR-0004).
 */
export interface ItemCalibrationObservation {
  readonly attemptId: string
  readonly itemId: string
  readonly conceptId: ConceptId
  readonly declaredDifficulty: number
  /** Ability estimate at the time of the attempt. */
  readonly thetaAtAttempt: number
  readonly expected: number
  readonly correct: boolean
  readonly hintDepth: number
  /** Observed minus expected: negative for a surprising failure. */
  readonly residual: number
  readonly observedAt: number
}
