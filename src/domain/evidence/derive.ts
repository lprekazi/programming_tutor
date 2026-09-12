import { getConcept } from '../curriculum/graph'
import {
  SURPRISING_FAILURE_PROBABILITY,
  SURPRISING_SUCCESS_PROBABILITY,
} from '../learner-model/parameters'
import { bandOf, type ConceptState } from '../learner-model/state'
import { applyOutcome } from '../learner-model/update'
import { scheduleNextReview } from '../scheduling/review'
import type {
  EvidenceRecord,
  ItemCalibrationObservation,
  JudgedAttempt,
  MisconceptionObservation,
} from './types'

/**
 * Turns a judged attempt into a change in learner state plus the record explaining it.
 *
 * This is the only path by which learner state changes. Keeping it in one pure function
 * means the guarantee "every movement is attributable to exactly one attempt" is
 * structural rather than a convention someone has to remember.
 */

export interface DerivedEvidence {
  readonly nextState: ConceptState
  readonly record: EvidenceRecord
  readonly misconceptions: readonly MisconceptionObservation[]
  /** Present only when the outcome was hard to reconcile with the item's declared difficulty. */
  readonly calibration: ItemCalibrationObservation | null
}

export function deriveEvidence(state: ConceptState, attempt: JudgedAttempt): DerivedEvidence {
  if (attempt.conceptId !== state.conceptId) {
    throw new Error(
      `Attempt for ${attempt.conceptId} cannot update state for ${state.conceptId}.`,
    )
  }
  if (!Number.isFinite(attempt.itemDifficulty)) {
    throw new Error(`Item ${attempt.itemId} has a non-finite difficulty.`)
  }
  if (!Number.isInteger(attempt.hintDepth) || attempt.hintDepth < 0) {
    throw new Error(`Hint depth must be a non-negative integer, received ${attempt.hintDepth}.`)
  }
  // A non-finite timestamp would produce a non-finite `nextReviewAt`, and every later
  // comparison against it is false — so the concept would silently never come due again.
  // That is an invisible hole in the schedule, so it is refused at the boundary.
  if (!Number.isFinite(attempt.observedAt)) {
    throw new Error(`Attempt ${attempt.attemptId} has a non-finite timestamp.`)
  }

  const priorBand = bandOf(state)
  const update = applyOutcome(state, {
    correct: attempt.correct,
    /*
     * One step of attenuation for an answer that was right with something unsaid, on top of
     * whatever help was taken. The learner model has one dial for "reached it with less than
     * full demonstration", and this is it — but the *record* keeps the two apart, because the
     * record is read by a person who knows whether they took a hint.
     */
    hintDepth: attempt.hintDepth + (attempt.partial === true ? 1 : 0),
    itemDifficulty: attempt.itemDifficulty,
  })

  const seen = { ...update.nextState, lastSeenAt: attempt.observedAt }
  const nextState = { ...seen, nextReviewAt: scheduleNextReview(seen, attempt.observedAt) }
  const posteriorBand = bandOf(nextState)

  const record: EvidenceRecord = {
    attemptId: attempt.attemptId,
    conceptId: attempt.conceptId,
    correct: attempt.correct,
    hintDepth: attempt.hintDepth,
    priorTheta: state.theta,
    posteriorTheta: nextState.theta,
    delta: update.delta,
    priorUncertainty: state.uncertainty,
    posteriorUncertainty: nextState.uncertainty,
    priorBand,
    posteriorBand,
    expected: update.expected,
    weight: update.weight,
    reason: describeChange(attempt, priorBand, posteriorBand),
    observedAt: attempt.observedAt,
  }

  // Duplicate tags would otherwise inflate how often a misconception appears to recur.
  const misconceptions = [...new Set(attempt.misconceptions)].map((misconceptionId) => ({
    attemptId: attempt.attemptId,
    conceptId: attempt.conceptId,
    misconceptionId,
    observedAt: attempt.observedAt,
  }))

  return {
    nextState,
    record,
    misconceptions,
    calibration: calibrationObservation(state, attempt, update.expected),
  }
}

/**
 * Writes a plain sentence explaining the change.
 *
 * Read by the learner in the Concepts view, so it says what they did and what followed
 * from it — never a bare number, and never anything the record does not actually support.
 */
function describeChange(
  attempt: JudgedAttempt,
  priorBand: string,
  posteriorBand: string,
): string {
  const title = getConcept(attempt.conceptId).title.toLowerCase()

  const partial = attempt.partial === true
  const help =
    attempt.hintDepth === 0 ? '' : ` after ${describeHints(attempt.hintDepth)}`
  const missing = partial ? ', with part of the reasoning left unsaid' : ''

  const what = attempt.correct
    ? attempt.hintDepth === 0 && !partial
      ? `Answered a question on ${title} correctly, unaided`
      : `Answered a question on ${title} correctly${help}${missing}`
    : `Did not answer a question on ${title} correctly${help}`

  if (priorBand !== posteriorBand) {
    return `${what}. This moved ${title} from ${readableBand(priorBand)} to ${readableBand(posteriorBand)}.`
  }
  if (attempt.correct && (attempt.hintDepth > 0 || partial)) {
    return `${what}. Counted as progress, though less than a complete unaided answer, and scheduled to come back sooner.`
  }
  return `${what}.`
}

function describeHints(hintDepth: number): string {
  return hintDepth === 1 ? 'one hint' : `${String(hintDepth)} hints`
}

function readableBand(band: string): string {
  return band === 'not-started' ? 'not started' : band === 'needs-review' ? 'needs review' : band
}

/**
 * Records an outcome that sits badly with the item's declared difficulty.
 *
 * Only for cases the estimate genuinely cannot explain: failing something the learner was
 * almost certain to pass, or passing unaided something they were almost certain to fail. A
 * hinted success is excluded, because the help already explains it.
 *
 * Nothing acts on these. They exist so that a later analysis can ask whether generated
 * items are declared at sensible difficulties — a question about the item bank, not about
 * the learner.
 */
function calibrationObservation(
  state: ConceptState,
  attempt: JudgedAttempt,
  expected: number,
): ItemCalibrationObservation | null {
  const surprisingFailure = !attempt.correct && expected >= SURPRISING_FAILURE_PROBABILITY
  const surprisingSuccess =
    attempt.correct && attempt.hintDepth === 0 && expected <= SURPRISING_SUCCESS_PROBABILITY

  if (!surprisingFailure && !surprisingSuccess) return null

  return {
    attemptId: attempt.attemptId,
    itemId: attempt.itemId,
    conceptId: attempt.conceptId,
    declaredDifficulty: attempt.itemDifficulty,
    thetaAtAttempt: state.theta,
    expected,
    correct: attempt.correct,
    hintDepth: attempt.hintDepth,
    residual: (attempt.correct ? 1 : 0) - expected,
    observedAt: attempt.observedAt,
  }
}
