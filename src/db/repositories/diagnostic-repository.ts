import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'

import { isConceptId } from '@/domain/curriculum/graph'
import type { ConceptId, MisconceptionId } from '@/domain/curriculum/types'
import { getDiagnosticItem } from '@/domain/diagnostic/items'
import {
  nextDecision,
  type AnsweredItem,
  type PlanDecision,
  type PlanState,
} from '@/domain/diagnostic/plan'
import type { VerdictSource } from '@/domain/diagnostic/score'

import type { Db, DbOrTx } from '../client'
import { diagnosticResponse, diagnosticSession, learner } from '../schema'
import { LEARNER_ID, readOnboardingAnswers, recordAttempt } from './learner-repository'

/**
 * The diagnostic's persistence, and the guarantee that matters most in it.
 *
 * A learner can double-click Submit, refresh mid-request, retry after a dropped connection, or
 * have a component re-render and fire the same submission twice. Any of those recording a
 * second piece of evidence would move the learner's estimate twice for one answer — a
 * corruption that would be invisible afterwards, because the evidence log would look
 * perfectly consistent.
 *
 * So the answer, not the evidence, is what is guarded. `(session, item)` is unique in the
 * database, and evidence is only derived when that insert actually creates a row. The check is
 * the database's, not the application's, so there is no window between looking and writing.
 */

export interface DiagnosticProgress {
  readonly sessionId: string
  readonly answers: readonly AnsweredItem[]
  /** Items set aside unmarked. Never counted as right, never counted as wrong. */
  readonly skippedItemIds: readonly string[]
  readonly completed: boolean
  readonly completionReason: string | null
}

/**
 * Finds the learner's diagnostic, starting one if they have none.
 *
 * Returning the existing session is what makes resume work: reopening the application finds
 * the run in progress and its answers, rather than beginning again.
 */
export function openDiagnostic(db: Db, at: number): DiagnosticProgress {
  const [existing] = db
    .select()
    .from(diagnosticSession)
    .where(eq(diagnosticSession.learnerId, LEARNER_ID))
    .all()

  if (existing !== undefined) {
    return {
      sessionId: existing.id,
      answers: readAnswers(db, existing.id),
      skippedItemIds: existing.skippedItems,
      completed: existing.completedAt !== null,
      completionReason: existing.completionReason,
    }
  }

  const sessionId = randomUUID()
  db.insert(diagnosticSession)
    .values({ id: sessionId, learnerId: LEARNER_ID, startedAt: new Date(at) })
    .run()

  return { sessionId, answers: [], skippedItemIds: [], completed: false, completionReason: null }
}

function readAnswers(db: Db, sessionId: string): readonly AnsweredItem[] {
  return db
    .select()
    .from(diagnosticResponse)
    .where(eq(diagnosticResponse.sessionId, sessionId))
    .all()
    .sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime())
    .flatMap((row) =>
      isConceptId(row.conceptId)
        ? [{ itemId: row.itemId, conceptId: row.conceptId, correct: row.correct }]
        : [],
    )
}

/** What to do next: ask an item, or report that the diagnostic is finished. */
export function decideNext(
  db: Db,
  progress: DiagnosticProgress,
  alsoUnavailable: readonly string[] = [],
): PlanDecision {
  return nextDecision(planStateFor(db, progress, alsoUnavailable))
}

function planStateFor(
  db: Db,
  progress: DiagnosticProgress,
  alsoUnavailable: readonly string[],
): PlanState {
  const onboarding = readOnboardingAnswers(db)
  if (onboarding === null) {
    throw new Error('The diagnostic cannot be planned before onboarding is answered.')
  }
  return {
    answers: progress.answers,
    onboarding,
    unavailableItemIds: [...progress.skippedItemIds, ...alsoUnavailable],
  }
}

/**
 * Sets an item aside without judging it.
 *
 * Reached only when marking genuinely could not happen — a written answer with no tutor to
 * read it, or the practical question in a browser where Python will not start. No response row
 * is written and no evidence is derived, so the concept ends the diagnostic `not-started`
 * rather than wrongly `developing`. The record exists purely so the planner stops offering an
 * item it already knows it cannot mark, and so the summary can say out loud that something was
 * left unasked.
 */
export function skipItem(db: Db, sessionId: string, itemId: string): void {
  // Throws on an unknown id, so a malformed request cannot park arbitrary strings here.
  getDiagnosticItem(itemId)

  const [session] = db.select().from(diagnosticSession).where(eq(diagnosticSession.id, sessionId)).all()
  if (session === undefined || session.completedAt !== null) return
  if (session.skippedItems.includes(itemId)) return

  db.update(diagnosticSession)
    .set({ skippedItems: [...session.skippedItems, itemId] })
    .where(eq(diagnosticSession.id, sessionId))
    .run()
}

export interface SubmissionInput {
  readonly sessionId: string
  readonly itemId: string
  readonly answer: string
  readonly correct: boolean
  readonly verdictSource: VerdictSource
  readonly misconceptions: readonly MisconceptionId[]
  readonly executionOutput?: string | undefined
  readonly failedTests?: readonly string[] | undefined
  readonly at: number
}

export interface SubmissionResult {
  /** False when this item had already been answered and nothing was recorded again. */
  readonly recorded: boolean
  readonly conceptId: ConceptId
  readonly correct: boolean
}

/** Thrown when a submission arrives for a diagnostic that has already been completed. */
export class DiagnosticClosedError extends Error {
  constructor() {
    super('The diagnostic is already complete and cannot take another answer.')
    this.name = 'DiagnosticClosedError'
  }
}

/**
 * Records one answer, exactly once.
 *
 * The insert uses `onConflictDoNothing`, and evidence is derived only if a row was actually
 * created. A repeated submission therefore returns the original outcome and changes nothing —
 * the second attempt is a no-op rather than an error, because from the learner's point of view
 * nothing went wrong and their answer is safely stored.
 *
 * The whole thing runs in one transaction, which closes the other half of the same guarantee.
 * The unique constraint stops one answer becoming two pieces of evidence; the transaction stops
 * one answer becoming *none*. Without it, a failure part-way through `recordAttempt` would
 * leave the response row committed, and the constraint would then make every retry a silent
 * no-op — that answer could never produce evidence again, and nothing would say so.
 */
export function submitAnswer(db: Db, input: SubmissionInput): SubmissionResult {
  return db.transaction((tx) => submitAnswerWithin(tx, input))
}

function submitAnswerWithin(db: DbOrTx, input: SubmissionInput): SubmissionResult {
  const item = getDiagnosticItem(input.itemId)
  const conceptId = item.conceptId

  // A completed diagnostic is closed. Without this, a request arriving after the completion
  // timestamp was stamped would add evidence to a profile the learner has already been shown.
  const [session] = db
    .select()
    .from(diagnosticSession)
    .where(eq(diagnosticSession.id, input.sessionId))
    .all()
  if (session === undefined || session.completedAt !== null) throw new DiagnosticClosedError()

  const inserted = db
    .insert(diagnosticResponse)
    .values({
      id: randomUUID(),
      sessionId: input.sessionId,
      itemId: input.itemId,
      conceptId,
      answer: input.answer,
      correct: input.correct,
      verdictSource: input.verdictSource,
      executionOutput: input.executionOutput ?? null,
      failedTests: input.failedTests === undefined ? null : [...input.failedTests],
      answeredAt: new Date(input.at),
    })
    .onConflictDoNothing({ target: [diagnosticResponse.sessionId, diagnosticResponse.itemId] })
    .returning({ id: diagnosticResponse.id })
    .all()

  if (inserted.length === 0) {
    // Already answered. Report the stored verdict rather than the incoming one, so a stale
    // resubmission cannot appear to change what was recorded.
    const [stored] = db
      .select()
      .from(diagnosticResponse)
      .where(
        and(
          eq(diagnosticResponse.sessionId, input.sessionId),
          eq(diagnosticResponse.itemId, input.itemId),
        ),
      )
      .all()

    return { recorded: false, conceptId, correct: stored?.correct ?? input.correct }
  }

  // Only now, having established this answer is new, does it become evidence. The attempt id
  // is the response row's id, so every movement in the learner's estimate points back at the
  // exact answer that caused it.
  recordAttempt(db, 'diagnostic', {
    attemptId: inserted[0]?.id ?? randomUUID(),
    conceptId,
    itemId: input.itemId,
    itemDifficulty: item.difficulty,
    correct: input.correct,
    // The diagnostic offers no hints: it is measuring, not teaching.
    hintDepth: 0,
    misconceptions: input.misconceptions,
    observedAt: input.at,
  })

  return { recorded: true, conceptId, correct: input.correct }
}

/**
 * Marks the diagnostic finished.
 *
 * Idempotent: completing an already-complete diagnostic changes nothing, so a refresh on the
 * final screen cannot re-stamp the completion time or re-run anything that depends on it.
 */
export function completeDiagnostic(db: Db, sessionId: string, reason: string, at: number): void {
  const [session] = db
    .select()
    .from(diagnosticSession)
    .where(eq(diagnosticSession.id, sessionId))
    .all()

  if (session === undefined || session.completedAt !== null) return

  db.update(diagnosticSession)
    .set({ completedAt: new Date(at), completionReason: reason })
    .where(eq(diagnosticSession.id, sessionId))
    .run()

  db.update(learner)
    .set({ diagnosticCompletedAt: new Date(at), updatedAt: new Date(at) })
    .where(eq(learner.id, LEARNER_ID))
    .run()
}

/** Every stored response, for the summary shown at the end. */
export function readResponses(db: Db, sessionId: string) {
  return db
    .select()
    .from(diagnosticResponse)
    .where(eq(diagnosticResponse.sessionId, sessionId))
    .all()
    .sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime())
}
