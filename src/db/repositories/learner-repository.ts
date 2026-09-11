import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'

import { CONCEPTS } from '@/domain/curriculum/concepts'
import { isConceptId } from '@/domain/curriculum/graph'
import type { Area, ConceptId } from '@/domain/curriculum/types'
import { deriveEvidence } from '@/domain/evidence/derive'
import type { JudgedAttempt } from '@/domain/evidence/types'
import { initialConceptState, type ConceptState } from '@/domain/learner-model/state'
import {
  initialStatesFromSelfReport,
  type Confidence,
  type OnboardingAnswers,
} from '@/domain/onboarding/self-report'

import type { Db, DbOrTx } from '../client'
import {
  conceptState,
  evidence as evidenceTable,
  itemCalibrationObservation,
  learner,
  misconceptionObservation,
  selfReport,
} from '../schema'

/**
 * Reading and writing the learner.
 *
 * This is the only place in the application that writes concept state, and it does so only by
 * handing an attempt to `deriveEvidence` and storing what comes back. No route handler, no
 * component and no model strategy can reach these columns any other way.
 *
 * That is not a convention. `recordAttempt` takes a judged attempt and returns what was
 * recorded; there is no function here that accepts an ability estimate, so there is nowhere
 * for one to be supplied.
 */

/** The single learner row's id. There is exactly one. */
export const LEARNER_ID = 1

export type OnboardingStep = 'goal' | 'experience' | 'confidence' | 'done'

export interface LearnerProfile {
  readonly goal: string | null
  readonly experience: string | null
  readonly interests: readonly Area[]
  readonly onboardingStep: OnboardingStep
  readonly onboardingComplete: boolean
  readonly diagnosticComplete: boolean
}

function toStep(value: string): OnboardingStep {
  return value === 'experience' || value === 'confidence' || value === 'done' ? value : 'goal'
}

/** Creates the learner row on first run. Safe to call repeatedly. */
export function ensureLearner(db: Db, at: number): void {
  const existing = db.select().from(learner).where(eq(learner.id, LEARNER_ID)).all()
  if (existing.length > 0) return

  db.insert(learner)
    .values({ id: LEARNER_ID, createdAt: new Date(at), updatedAt: new Date(at) })
    .run()
}

export function readProfile(db: Db): LearnerProfile | null {
  const [row] = db.select().from(learner).where(eq(learner.id, LEARNER_ID)).all()
  if (row === undefined) return null

  return {
    goal: row.goal,
    experience: row.experience,
    interests: (row.interests ?? []).filter((value): value is Area => typeof value === 'string'),
    onboardingStep: toStep(row.onboardingStep),
    onboardingComplete: row.onboardingCompletedAt !== null,
    diagnosticComplete: row.diagnosticCompletedAt !== null,
  }
}

export interface GoalStep {
  readonly goal: string
  readonly interests: readonly Area[]
}

/**
 * Whether an onboarding write was accepted.
 *
 * Onboarding runs once. Saying so in a return value rather than a comment matters because the
 * confidence step **rebuilds every concept state from self-report**: accepting it a second
 * time, after the learner had answered anything, would replace evidence they earned with
 * claims they made. A stale form left open in another tab is enough to do it.
 */
export type OnboardingWrite =
  | 'saved'
  /** Onboarding is already finished. Nothing was written. */
  | 'refused-already-complete'
  /** The learner has answered something. Their evidence is not overwritten. */
  | 'refused-evidence-exists'

/** True once onboarding has been completed, whatever step a stale form thinks it is on. */
function onboardingIsComplete(db: Db): boolean {
  return readProfile(db)?.onboardingComplete === true
}

/**
 * Saves one onboarding step and advances to the next.
 *
 * Each step is written as it is answered, rather than everything at the end. A learner who
 * closes the application half way through comes back to the step they were on; losing two
 * answers because they did not reach the third would be an obvious way to lose a learner.
 */
export function saveGoal(db: Db, at: number, step: GoalStep): OnboardingWrite {
  ensureLearner(db, at)
  if (onboardingIsComplete(db)) return 'refused-already-complete'

  db.update(learner)
    .set({
      goal: step.goal.trim(),
      interests: [...step.interests],
      onboardingStep: 'experience',
      updatedAt: new Date(at),
    })
    .where(eq(learner.id, LEARNER_ID))
    .run()
  return 'saved'
}

export function saveExperience(db: Db, at: number, experience: string): OnboardingWrite {
  ensureLearner(db, at)
  if (onboardingIsComplete(db)) return 'refused-already-complete'

  db.update(learner)
    .set({ experience, onboardingStep: 'confidence', updatedAt: new Date(at) })
    .where(eq(learner.id, LEARNER_ID))
    .run()
  return 'saved'
}

/**
 * Steps onboarding back to an earlier question.
 *
 * Refused once onboarding is finished, so this is a way to correct an answer while still
 * giving them — not a way back into onboarding afterwards, which would let the confidence step
 * run a second time. What the learner already said is left in place: the forms read it back,
 * so going back shows their answer rather than an empty box.
 */
export function reopenOnboardingAt(
  db: Db,
  at: number,
  step: 'goal' | 'experience',
): OnboardingWrite {
  ensureLearner(db, at)
  if (onboardingIsComplete(db)) return 'refused-already-complete'

  db.update(learner)
    .set({ onboardingStep: step, updatedAt: new Date(at) })
    .where(eq(learner.id, LEARNER_ID))
    .run()
  return 'saved'
}

/**
 * Saves the self-assessment and creates the starting concept states.
 *
 * The states come back from `initialStatesFromSelfReport` with **no evidence**, so every band
 * is `not-started`. A learner who says they are advanced has moved the starting estimate and
 * nothing else; the interface will not claim they are secure in anything until they have
 * answered something.
 */
export function saveConfidence(
  db: Db,
  at: number,
  confidence: Partial<Record<Area, Confidence>>,
): OnboardingWrite {
  ensureLearner(db, at)

  // Two guards, and the second is the one that matters. Onboarding being complete is the
  // normal case; evidence existing is the one that would do damage, and it is checked
  // independently so that a learner state where the two disagree still cannot be overwritten.
  if (onboardingIsComplete(db)) return 'refused-already-complete'
  if (countEvidence(db) > 0) return 'refused-evidence-exists'

  db.delete(selfReport).where(eq(selfReport.learnerId, LEARNER_ID)).run()
  // Written out rather than taken from Object.entries so that an area present with an
  // undefined value — which the Partial type permits — is dropped rather than stored.
  const entries: [Area, Confidence][] = []
  for (const area of Object.keys(confidence) as Area[]) {
    const value = confidence[area]
    if (value !== undefined) entries.push([area, value])
  }
  if (entries.length > 0) {
    db.insert(selfReport)
      .values(
        entries.map(([area, value]) => ({
          learnerId: LEARNER_ID,
          area,
          confidence: value,
          recordedAt: new Date(at),
        })),
      )
      .run()
  }

  const profile = readProfile(db)
  const answers: OnboardingAnswers = {
    goal: profile?.goal ?? '',
    experience: asExperience(profile?.experience),
    interests: profile?.interests ?? [],
    confidence,
  }

  // Replaced wholesale rather than merged, which is safe only because of the guards above:
  // nothing has been answered yet, so there is no evidence here to lose.
  db.delete(conceptState).where(eq(conceptState.learnerId, LEARNER_ID)).run()
  writeStates(db, initialStatesFromSelfReport(answers))

  db.update(learner)
    .set({ onboardingStep: 'done', onboardingCompletedAt: new Date(at), updatedAt: new Date(at) })
    .where(eq(learner.id, LEARNER_ID))
    .run()
  return 'saved'
}

function asExperience(value: string | null | undefined): OnboardingAnswers['experience'] {
  return value === 'other-language' || value === 'some-python' || value === 'regular-python'
    ? value
    : 'new-to-programming'
}

export function readSelfReport(db: Db): Partial<Record<Area, Confidence>> {
  const rows = db.select().from(selfReport).where(eq(selfReport.learnerId, LEARNER_ID)).all()
  const report: Partial<Record<Area, Confidence>> = {}

  for (const row of rows) {
    report[row.area as Area] = row.confidence as Confidence
  }
  return report
}

export function readOnboardingAnswers(db: Db): OnboardingAnswers | null {
  const profile = readProfile(db)
  if (profile === null || profile.goal === null) return null

  return {
    goal: profile.goal,
    experience: asExperience(profile.experience),
    interests: profile.interests,
    confidence: readSelfReport(db),
  }
}

function writeStates(db: DbOrTx, states: readonly ConceptState[]): void {
  if (states.length === 0) return

  for (const state of states) {
    db.insert(conceptState)
      .values({
        learnerId: LEARNER_ID,
        conceptId: state.conceptId,
        theta: state.theta,
        uncertainty: state.uncertainty,
        evidenceCount: state.evidenceCount,
        successes: state.successes,
        unaidedSuccesses: state.unaidedSuccesses,
        supportSignal: state.supportSignal,
        lastSeenAt: state.lastSeenAt === null ? null : new Date(state.lastSeenAt),
        nextReviewAt: state.nextReviewAt === null ? null : new Date(state.nextReviewAt),
      })
      .onConflictDoUpdate({
        target: [conceptState.learnerId, conceptState.conceptId],
        set: {
          theta: state.theta,
          uncertainty: state.uncertainty,
          evidenceCount: state.evidenceCount,
          successes: state.successes,
          unaidedSuccesses: state.unaidedSuccesses,
          supportSignal: state.supportSignal,
          lastSeenAt: state.lastSeenAt === null ? null : new Date(state.lastSeenAt),
          nextReviewAt: state.nextReviewAt === null ? null : new Date(state.nextReviewAt),
        },
      })
      .run()
  }
}

/** Every concept's state, defaulting to untouched for anything not yet stored. */
export function readConceptStates(db: DbOrTx): readonly ConceptState[] {
  const rows = db.select().from(conceptState).where(eq(conceptState.learnerId, LEARNER_ID)).all()
  const stored = new Map<ConceptId, ConceptState>()

  for (const row of rows) {
    if (!isConceptId(row.conceptId)) continue
    stored.set(row.conceptId, {
      conceptId: row.conceptId,
      theta: row.theta,
      uncertainty: row.uncertainty,
      evidenceCount: row.evidenceCount,
      successes: row.successes,
      unaidedSuccesses: row.unaidedSuccesses,
      supportSignal: row.supportSignal,
      lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.getTime(),
      nextReviewAt: row.nextReviewAt === null ? null : row.nextReviewAt.getTime(),
    })
  }

  return CONCEPTS.map((concept) => stored.get(concept.id) ?? initialConceptState(concept.id))
}

export function readConceptState(db: DbOrTx, conceptId: ConceptId): ConceptState {
  return (
    readConceptStates(db).find((state) => state.conceptId === conceptId) ??
    initialConceptState(conceptId)
  )
}

export interface RecordedAttempt {
  readonly conceptId: ConceptId
  readonly priorBand: string
  readonly posteriorBand: string
  readonly reason: string
}

/**
 * Records one attempt: the only way concept state ever changes.
 *
 * The attempt is handed to `deriveEvidence`, which decides what it means, and the result is
 * stored together with the record explaining it. There is no parameter here for an estimate,
 * a band or a delta, so a caller cannot supply one — the arithmetic is the domain's and only
 * the domain's.
 */
export function recordAttempt(db: DbOrTx, source: string, attempt: JudgedAttempt): RecordedAttempt {
  const before = readConceptState(db, attempt.conceptId)
  const derived = deriveEvidence(before, attempt)

  writeStates(db, [derived.nextState])

  db.insert(evidenceTable)
    .values({
      id: randomUUID(),
      learnerId: LEARNER_ID,
      conceptId: derived.record.conceptId,
      source,
      attemptId: derived.record.attemptId,
      correct: derived.record.correct,
      hintDepth: derived.record.hintDepth,
      priorTheta: derived.record.priorTheta,
      posteriorTheta: derived.record.posteriorTheta,
      priorBand: derived.record.priorBand,
      posteriorBand: derived.record.posteriorBand,
      reason: derived.record.reason,
      observedAt: new Date(derived.record.observedAt),
    })
    .run()

  for (const observation of derived.misconceptions) {
    db.insert(misconceptionObservation)
      .values({
        id: randomUUID(),
        learnerId: LEARNER_ID,
        attemptId: observation.attemptId,
        conceptId: observation.conceptId,
        misconceptionId: observation.misconceptionId,
        observedAt: new Date(observation.observedAt),
      })
      .run()
  }

  if (derived.calibration !== null) {
    db.insert(itemCalibrationObservation)
      .values({
        id: randomUUID(),
        learnerId: LEARNER_ID,
        attemptId: derived.calibration.attemptId,
        itemId: derived.calibration.itemId,
        conceptId: derived.calibration.conceptId,
        declaredDifficulty: derived.calibration.declaredDifficulty,
        thetaAtAttempt: derived.calibration.thetaAtAttempt,
        expected: derived.calibration.expected,
        correct: derived.calibration.correct,
        residual: derived.calibration.residual,
        observedAt: new Date(derived.calibration.observedAt),
      })
      .run()
  }

  return {
    conceptId: derived.record.conceptId,
    priorBand: derived.record.priorBand,
    posteriorBand: derived.record.posteriorBand,
    reason: derived.record.reason,
  }
}

/** Evidence for one concept, newest first. What the Concepts view reads. */
export function readEvidenceFor(db: Db, conceptId: ConceptId) {
  return db
    .select()
    .from(evidenceTable)
    .where(and(eq(evidenceTable.learnerId, LEARNER_ID), eq(evidenceTable.conceptId, conceptId)))
    .all()
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
}

export function countEvidence(db: Db): number {
  return db.select().from(evidenceTable).where(eq(evidenceTable.learnerId, LEARNER_ID)).all().length
}

/** Wipes everything and returns to first run. */
export function resetLearner(db: Db): void {
  db.delete(learner).where(eq(learner.id, LEARNER_ID)).run()
}
