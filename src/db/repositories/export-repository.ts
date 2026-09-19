import { eq } from 'drizzle-orm'

import { isConceptId } from '@/domain/curriculum/graph'
import type {
  ExportActivity,
  ExportDiagnostic,
  ExportExercise,
  ExportInput,
  ExportSession,
} from '@/domain/export/document'

import type { Db } from '../client'
import { diagnosticResponse, diagnosticSession, learner } from '../schema'
import { readSessionActivities } from './activity-repository'
import { readSessionExercises } from './exercise-repository'
import {
  readAllEvidence,
  readConceptStates,
  readMisconceptionObservations,
  readProfile,
  readSelfReport,
  LEARNER_ID,
} from './learner-repository'
import { readAllSessions } from './session-repository'

/**
 * Everything the export is allowed to contain, read in one place.
 *
 * Every field is named. Nothing here spreads a stored row into the result, because that is how
 * a column added next year ends up in a learner's file without anybody deciding it should be —
 * and some of the columns nearby are answer keys and reference solutions, which must never
 * leave the server (`src/domain/export/document.ts`).
 *
 * Reads only. Exporting must not create a diagnostic session, a learner row, or anything else:
 * looking at your own data should not change it.
 */

export function readExportInput(db: Db, exportedAt: number): ExportInput {
  const profile = readProfile(db)
  const moments = readLearnerMoments(db)

  return {
    exportedAt,
    learner:
      profile === null
        ? null
        : {
            goal: profile.goal,
            experience: profile.experience,
            interests: profile.interests,
            onboardingCompletedAt: moments.onboardingCompletedAt,
            diagnosticCompletedAt: moments.diagnosticCompletedAt,
          },
    selfReport: Object.entries(readSelfReport(db)).map(([area, confidence]) => ({
      area,
      confidence,
    })),
    conceptStates: readConceptStates(db),
    evidence: readAllEvidence(db).map((entry) => ({
      conceptId: entry.conceptId,
      source: entry.source,
      correct: entry.correct,
      hintDepth: entry.hintDepth,
      priorBand: entry.priorBand,
      posteriorBand: entry.posteriorBand,
      reason: entry.reason,
      observedAt: entry.observedAt.getTime(),
    })),
    misconceptions: readMisconceptionObservations(db).map((entry) => ({
      conceptId: entry.conceptId,
      misconceptionId: entry.misconceptionId,
      observedAt: entry.observedAt.getTime(),
    })),
    diagnostic: readDiagnostic(db),
    sessions: readAllSessions(db).map((session): ExportSession => {
      return {
        id: session.id,
        conceptId: session.conceptId,
        openedReason: session.openedReason,
        mode: session.mode,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        closedAt: session.closedAt,
        /*
         * An activity turn's text is the record kept for the model — what was asked and which
         * misconceptions it showed, in internal vocabulary. The question itself is exported
         * below, under `activities`, so emptying this loses the learner nothing.
         */
        turns: session.turns.map((turn) => ({
          ordinal: turn.ordinal,
          role: turn.role,
          text: turn.role === 'activity' ? '' : turn.text,
          status: turn.status,
        })),
        activities: readSessionActivities(db, session.id).map(
          (activity): ExportActivity => ({
            kind: activity.kind,
            origin: activity.origin,
            conceptId: activity.conceptId,
            prompt: activity.prompt,
            code: activity.code,
            options: activity.options,
            selectionGround: activity.selectionGround,
            askedAt: activity.createdAt,
            hints: activity.hints.map((hint) => ({ depth: hint.depth, text: hint.text })),
            attempt:
              activity.attempt === null
                ? null
                : {
                    response: activity.attempt.response,
                    marked: activity.attempt.marked,
                    correct: activity.attempt.correct,
                    partial: activity.attempt.partial,
                    markedBy: activity.attempt.markingSource,
                    hintDepth: activity.attempt.hintDepth,
                    feedback: activity.attempt.feedback,
                    misconceptions: activity.attempt.misconceptions,
                    attemptedAt: activity.attempt.attemptedAt,
                  },
          }),
        ),
        exercises: readSessionExercises(db, session.id)
          // An exercise still being checked was never shown to anybody.
          .filter((exercise) => exercise.verification === 'verified')
          .map(
            (exercise): ExportExercise => ({
              title: exercise.title,
              brief: exercise.brief,
              kind: exercise.kind,
              origin: exercise.origin,
              conceptId: exercise.conceptId,
              askedAt: exercise.createdAt,
              yourCode: exercise.draftCode,
              hints: exercise.hints.map((hint) => ({ depth: hint.depth, text: hint.text })),
              submissions: exercise.submissions.map((submission) => ({
                ordinal: submission.ordinal,
                code: submission.code,
                state: submission.state,
                passedChecks: submission.passedChecks,
                totalChecks: submission.totalChecks,
                counted: submission.counted,
                hintsTaken: submission.hintsTaken,
                submittedAt: submission.submittedAt,
              })),
            }),
          ),
      }
    }),
  }
}

/** The two completion times, which the profile reports as booleans rather than moments. */
function readLearnerMoments(db: Db): {
  readonly onboardingCompletedAt: number | null
  readonly diagnosticCompletedAt: number | null
} {
  const [row] = db.select().from(learner).where(eq(learner.id, LEARNER_ID)).all()

  return {
    onboardingCompletedAt: row?.onboardingCompletedAt?.getTime() ?? null,
    diagnosticCompletedAt: row?.diagnosticCompletedAt?.getTime() ?? null,
  }
}

/**
 * The diagnostic run, read without starting one.
 *
 * `openDiagnostic` creates a session where there is none, which is right for the diagnostic
 * page and wrong here: exporting an empty profile would leave a diagnostic session behind it.
 */
function readDiagnostic(db: Db): ExportDiagnostic | null {
  const [session] = db
    .select()
    .from(diagnosticSession)
    .where(eq(diagnosticSession.learnerId, LEARNER_ID))
    .all()

  if (session === undefined) return null

  return {
    startedAt: session.startedAt.getTime(),
    completedAt: session.completedAt?.getTime() ?? null,
    completionReason: session.completionReason,
    skippedItemIds: session.skippedItems,
    responses: db
      .select()
      .from(diagnosticResponse)
      .where(eq(diagnosticResponse.sessionId, session.id))
      .all()
      .sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime())
      .filter((row) => isConceptId(row.conceptId))
      .map((row) => ({
        itemId: row.itemId,
        conceptId: row.conceptId,
        response: row.answer,
        correct: row.correct,
        answeredAt: row.answeredAt.getTime(),
      })),
  }
}
