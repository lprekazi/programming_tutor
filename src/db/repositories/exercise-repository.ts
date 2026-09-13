import { createHash, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'

import { isMisconceptionId } from '@/domain/curriculum/graph'
import type { ConceptId, MisconceptionId } from '@/domain/curriculum/types'
import type { PracticalMarking, PracticalOutcome } from '@/domain/exercises/mark'
import type { StoredExercise } from '@/domain/exercises/present'
import type { ExerciseKind, ExerciseTest, MisconceptionSignal } from '@/domain/exercises/types'

import type { Db, DbOrTx } from '../client'
import {
  exerciseGenerationLog,
  exerciseHint,
  exerciseSubmission,
  sessionExercise,
} from '../schema'
import { recordAttempt, type RecordedAttempt } from './learner-repository'

/**
 * Programming exercises, and the guarantees this file exists to make.
 *
 * **One exercise per position, fixed once accepted.** `turn_id` is unique; a generated candidate
 * may be replaced while it is unverified and never after.
 *
 * **One piece of evidence per exercise, however many submissions.** Submissions are unique on
 * `(exercise, code)`, so the same code arriving twice — double-click, retry, reload, replayed
 * action — finds the row it already made. They are numbered, and only the first can count. The
 * insert, the numbering and the evidence all happen inside one transaction.
 *
 * **Hint depth is the truth.** How many hints were taken is read from the hint rows at the moment
 * of submitting and stored as such. Nothing here uses one number to mean two things.
 *
 * Nothing in this file marks an attempt or runs anything. It stores what the domain decided and
 * what the browser reported.
 */

export type VerificationStatus = 'unverified' | 'verified' | 'rejected'

export interface ExerciseCandidate {
  readonly conceptId: ConceptId
  readonly kind: ExerciseKind
  readonly origin: 'authored' | 'generated'
  readonly exerciseId: string | null
  readonly bankVersion: string | null
  readonly title: string
  readonly brief: string
  readonly starterCode: string
  readonly tests: readonly ExerciseTest[]
  readonly referenceSolution: string
  readonly signals: readonly MisconceptionSignal[]
  readonly authoredHints: readonly string[] | null
  readonly difficulty: number
  readonly selectionGround: string
  readonly verification: VerificationStatus
  readonly generationAttempt: number
  readonly strategyId: string | null
  readonly strategyVersion: string | null
  readonly model: string | null
}

export interface HintRecord {
  readonly depth: number
  readonly text: string
  readonly source: 'authored' | 'model'
  readonly askedAt: number
}

export interface SubmissionRecord {
  readonly id: string
  readonly ordinal: number
  readonly code: string
  readonly state: 'passed' | 'failed' | 'crashed' | 'unmarked'
  readonly passedChecks: number | null
  readonly totalChecks: number
  readonly unmarkedReason: string | null
  readonly misconceptions: readonly MisconceptionId[]
  readonly hintsTaken: number
  readonly counted: boolean
  readonly feedbackStatus: 'pending' | 'given' | 'unavailable' | 'not-requested'
  readonly feedback: unknown
  /** What the browser reported running the code produced, as stored. */
  readonly outcome: unknown
  readonly submittedAt: number
}

export interface ExerciseRecord extends StoredExercise {
  readonly sessionId: string
  readonly turnId: string
  readonly exerciseId: string | null
  readonly signals: readonly MisconceptionSignal[]
  readonly authoredHints: readonly string[] | null
  readonly difficulty: number
  readonly verification: VerificationStatus
  readonly generationAttempt: number
  readonly strategyId: string | null
  readonly strategyVersion: string | null
  readonly model: string | null
  readonly draftCode: string | null
  readonly hints: readonly HintRecord[]
  /** Oldest first. */
  readonly submissions: readonly SubmissionRecord[]
  readonly createdAt: number
}

function isVerification(value: string): value is VerificationStatus {
  return value === 'unverified' || value === 'verified' || value === 'rejected'
}

function hydrate(db: DbOrTx, row: typeof sessionExercise.$inferSelect): ExerciseRecord {
  const hints = db
    .select()
    .from(exerciseHint)
    .where(eq(exerciseHint.exerciseId, row.id))
    .all()
    .sort((a, b) => a.depth - b.depth)
    .map((hint) => ({
      depth: hint.depth,
      text: hint.text,
      source: hint.source === 'model' ? ('model' as const) : ('authored' as const),
      askedAt: hint.askedAt.getTime(),
    }))

  const submissions = db
    .select()
    .from(exerciseSubmission)
    .where(eq(exerciseSubmission.exerciseId, row.id))
    .all()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(
      (submission): SubmissionRecord => ({
        id: submission.id,
        ordinal: submission.ordinal,
        code: submission.code,
        state:
          submission.state === 'passed' ||
          submission.state === 'failed' ||
          submission.state === 'crashed'
            ? submission.state
            : 'unmarked',
        passedChecks: submission.passedChecks,
        totalChecks: submission.totalChecks,
        unmarkedReason: submission.unmarkedReason,
        misconceptions: submission.misconceptions.filter(isMisconceptionId),
        hintsTaken: submission.hintsTaken,
        counted: submission.counted,
        feedbackStatus:
          submission.feedbackStatus === 'given' ||
          submission.feedbackStatus === 'unavailable' ||
          submission.feedbackStatus === 'pending'
            ? submission.feedbackStatus
            : 'not-requested',
        feedback: submission.feedback,
        outcome: submission.outcome,
        submittedAt: submission.submittedAt.getTime(),
      }),
    )

  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    conceptId: row.conceptId as ConceptId,
    kind: row.kind === 'fix' ? 'fix' : 'write',
    origin: row.origin === 'generated' ? 'generated' : 'authored',
    exerciseId: row.exerciseId,
    title: row.title,
    brief: row.brief,
    starterCode: row.starterCode,
    tests: row.tests,
    referenceSolution: row.referenceSolution,
    // A stored signal without code evidence is not trusted to name anything.
    signals: row.signals.flatMap((signal) =>
      isMisconceptionId(signal.misconception) && typeof signal.codeShows === 'string'
        ? [{ ...signal, misconception: signal.misconception, counterexamples: signal.counterexamples }]
        : [],
    ),
    authoredHints: row.authoredHints,
    difficulty: row.difficulty,
    selectionGround: row.selectionGround,
    verification: isVerification(row.verification) ? row.verification : 'unverified',
    generationAttempt: row.generationAttempt,
    strategyId: row.strategyId,
    strategyVersion: row.strategyVersion,
    model: row.model,
    draftCode: row.draftCode,
    hints,
    submissions,
    createdAt: row.createdAt.getTime(),
  }
}

/**
 * Sets an exercise at a position in the conversation.
 *
 * `onConflictDoNothing` on the turn, then a read of whatever is there — so two requests to set an
 * exercise at the same moment both come back with the same one.
 */
export function createExercise(
  db: Db,
  input: { readonly sessionId: string; readonly turnId: string; readonly at: number } & ExerciseCandidate,
): ExerciseRecord {
  db.insert(sessionExercise)
    .values({
      id: randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      conceptId: input.conceptId,
      kind: input.kind,
      origin: input.origin,
      exerciseId: input.exerciseId,
      bankVersion: input.bankVersion,
      title: input.title,
      brief: input.brief,
      starterCode: input.starterCode,
      tests: input.tests.map((test) => ({ name: test.name, code: test.code })),
      referenceSolution: input.referenceSolution,
      signals: input.signals.map((signal) => ({
        misconception: signal.misconception,
        pattern: [...signal.pattern],
        codeShows: signal.codeShows,
        ...(signal.codeLacks === undefined ? {} : { codeLacks: signal.codeLacks }),
        witness: signal.witness,
        counterexamples: [...signal.counterexamples],
      })),
      authoredHints: input.authoredHints === null ? null : [...input.authoredHints],
      difficulty: input.difficulty,
      selectionGround: input.selectionGround,
      verification: input.verification,
      generationAttempt: input.generationAttempt,
      strategyId: input.strategyId,
      strategyVersion: input.strategyVersion,
      model: input.model,
      createdAt: new Date(input.at),
    })
    .onConflictDoNothing({ target: [sessionExercise.turnId] })
    .run()

  const [row] = db.select().from(sessionExercise).where(eq(sessionExercise.turnId, input.turnId)).all()
  if (row === undefined) throw new Error('The exercise was written but could not be read back.')
  return hydrate(db, row)
}

export function readExercise(db: DbOrTx, id: string): ExerciseRecord | null {
  const [row] = db.select().from(sessionExercise).where(eq(sessionExercise.id, id)).all()
  return row === undefined ? null : hydrate(db, row)
}

export function readSessionExercises(db: Db, sessionId: string): readonly ExerciseRecord[] {
  return db
    .select()
    .from(sessionExercise)
    .where(eq(sessionExercise.sessionId, sessionId))
    .all()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => hydrate(db, row))
}

/** Authored exercises this learner has been set, in any session. A repeat measures only memory. */
export function readUsedExerciseIds(db: Db): readonly string[] {
  return db
    .select({ exerciseId: sessionExercise.exerciseId, verification: sessionExercise.verification })
    .from(sessionExercise)
    .all()
    .flatMap((row) => (row.exerciseId !== null && row.verification === 'verified' ? [row.exerciseId] : []))
}

/**
 * What identifies one generated candidate: its solution, its starter and its checks.
 *
 * A verdict from the browser names the candidate it checked, not just the row. Without that, two
 * verification flows on one row — a reload during a regeneration, a refresh re-arming the resume
 * — could each trigger a regeneration, and a "verified" for an older bundle could settle whatever
 * candidate happened to be stored by then, which nobody had run (M6 review finding F-04).
 */
export function candidateKey(candidate: {
  readonly referenceSolution: string
  readonly starterCode: string
  readonly tests: readonly ExerciseTest[]
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        referenceSolution: candidate.referenceSolution,
        starterCode: candidate.starterCode,
        tests: candidate.tests.map((test) => [test.name, test.code]),
      }),
      'utf8',
    )
    .digest('hex')
}

/**
 * Replaces a candidate that has not been accepted: a regeneration, or a fallback.
 *
 * Refused once the exercise is verified. By then the learner may have read it, written code for
 * it, and taken hints about it, and quietly swapping it would make all of that about something
 * else.
 */
export function replaceCandidate(
  db: Db,
  id: string,
  candidate: ExerciseCandidate,
  /**
   * The candidate this replacement is meant to supersede. The replacement happens only if that is
   * still the stored one, so of two concurrent regenerations only the first lands.
   */
  expected?: string,
): ExerciseRecord | null {
  return db.transaction((tx) => {
    const current = readExercise(tx, id)
    if (current === null || current.verification !== 'unverified') return null
    if (expected !== undefined && candidateKey(current) !== expected) return null
    return replaceWithin(tx, id, candidate)
  })
}

function replaceWithin(db: DbOrTx, id: string, candidate: ExerciseCandidate): ExerciseRecord | null {
  const updated = db
    .update(sessionExercise)
    .set({
      conceptId: candidate.conceptId,
      kind: candidate.kind,
      origin: candidate.origin,
      exerciseId: candidate.exerciseId,
      bankVersion: candidate.bankVersion,
      title: candidate.title,
      brief: candidate.brief,
      starterCode: candidate.starterCode,
      tests: candidate.tests.map((test) => ({ name: test.name, code: test.code })),
      referenceSolution: candidate.referenceSolution,
      signals: candidate.signals.map((signal) => ({
        misconception: signal.misconception,
        pattern: [...signal.pattern],
        codeShows: signal.codeShows,
        ...(signal.codeLacks === undefined ? {} : { codeLacks: signal.codeLacks }),
        witness: signal.witness,
        counterexamples: [...signal.counterexamples],
      })),
      authoredHints: candidate.authoredHints === null ? null : [...candidate.authoredHints],
      difficulty: candidate.difficulty,
      selectionGround: candidate.selectionGround,
      verification: candidate.verification,
      generationAttempt: candidate.generationAttempt,
      strategyId: candidate.strategyId,
      strategyVersion: candidate.strategyVersion,
      model: candidate.model,
    })
    .where(and(eq(sessionExercise.id, id), eq(sessionExercise.verification, 'unverified')))
    .returning({ id: sessionExercise.id })
    .all()

  return updated.length === 0 ? null : readExercise(db, id)
}

/**
 * Records how verifying a generated candidate went.
 *
 * Only an unverified candidate can be settled, so a verdict arriving twice — or arriving for an
 * exercise that was replaced in the meantime — cannot flip an accepted exercise to rejected or a
 * rejected one to accepted.
 */
export function settleVerification(
  db: Db,
  input: {
    readonly id: string
    readonly verdict: 'verified' | 'rejected'
    readonly reason: string | null
    readonly at: number
    /** The candidate the verdict is about. Refused if a different one is now stored. */
    readonly candidate?: string
  },
): boolean {
  return db.transaction((tx) => {
    const [row] = tx.select().from(sessionExercise).where(eq(sessionExercise.id, input.id)).all()
    if (row === undefined || row.verification !== 'unverified') return false
    if (input.candidate !== undefined && candidateKey(row) !== input.candidate) return false

    tx.update(sessionExercise)
      .set({ verification: input.verdict })
      .where(eq(sessionExercise.id, input.id))
      .run()

    logGeneration(tx, {
      exerciseId: input.id,
      attempt: row.generationAttempt,
      outcome: input.verdict,
      reason: input.reason,
      strategyVersion: row.strategyVersion,
      model: row.model,
      at: input.at,
    })
    return true
  })
}

export function logGeneration(
  db: DbOrTx,
  entry: {
    readonly exerciseId: string
    readonly attempt: number
    readonly outcome: 'verified' | 'rejected' | 'invalid' | 'unavailable' | 'fallback'
    readonly reason: string | null
    readonly strategyVersion: string | null
    readonly model: string | null
    readonly at: number
  },
): void {
  db.insert(exerciseGenerationLog)
    .values({
      id: randomUUID(),
      exerciseId: entry.exerciseId,
      attempt: entry.attempt,
      outcome: entry.outcome,
      reason: entry.reason,
      strategyVersion: entry.strategyVersion,
      model: entry.model,
      at: new Date(entry.at),
    })
    .run()
}

export function readGenerationLog(
  db: Db,
  exerciseId: string,
): readonly { readonly attempt: number; readonly outcome: string; readonly reason: string | null }[] {
  return db
    .select()
    .from(exerciseGenerationLog)
    .where(eq(exerciseGenerationLog.exerciseId, exerciseId))
    .all()
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.attempt - b.attempt)
    .map((entry) => ({ attempt: entry.attempt, outcome: entry.outcome, reason: entry.reason }))
}

/**
 * Keeps the learner's latest code.
 *
 * Saves arrive out of order — a debounced save can land after a later one — so each carries the
 * time it was *written* in the browser, and an older one never overwrites a newer. Refused for an
 * exercise the learner cannot see yet.
 */
export function saveDraft(
  db: Db,
  input: { readonly id: string; readonly code: string; readonly editedAt: number },
): boolean {
  return db.transaction((tx) => {
    const [row] = tx.select().from(sessionExercise).where(eq(sessionExercise.id, input.id)).all()
    if (row === undefined || row.verification !== 'verified') return false
    if (row.draftEditedAt !== null && row.draftEditedAt.getTime() > input.editedAt) return false

    tx.update(sessionExercise)
      .set({ draftCode: input.code, draftEditedAt: new Date(input.editedAt) })
      .where(eq(sessionExercise.id, input.id))
      .run()
    return true
  })
}

export type HintResult =
  | { readonly status: 'given'; readonly hint: HintRecord; readonly created: boolean }
  | { readonly status: 'refused'; readonly reason: 'out-of-order' | 'finished' | 'unknown' }

/**
 * Stores hint `depth`, or returns it if it is already stored.
 *
 * The depth is asked for explicitly rather than computed as "the next one", so that pressing the
 * button twice asks for the same hint twice instead of skipping one. Only the next rung can be
 * created; anything further is refused, as is any hint once the exercise has been passed.
 *
 * Runs inside a transaction with the check, so a submission landing between the look and the
 * write cannot leave a hint recorded that the evidence never knew about (M5 finding F-15).
 */
export function recordExerciseHint(
  db: Db,
  input: {
    readonly exerciseId: string
    readonly depth: number
    readonly text: string
    readonly source: 'authored' | 'model'
    readonly strategyId: string | null
    readonly strategyVersion: string | null
    readonly model: string | null
    readonly at: number
  },
): HintResult {
  return db.transaction((tx): HintResult => {
    const exercise = readExercise(tx, input.exerciseId)
    if (exercise === null) return { status: 'refused', reason: 'unknown' }

    const existing = exercise.hints.find((hint) => hint.depth === input.depth)
    if (existing !== undefined) return { status: 'given', hint: existing, created: false }

    if (exercise.submissions.some((submission) => submission.state === 'passed')) {
      return { status: 'refused', reason: 'finished' }
    }
    if (input.depth !== exercise.hints.length + 1) return { status: 'refused', reason: 'out-of-order' }

    tx.insert(exerciseHint)
      .values({
        id: randomUUID(),
        exerciseId: input.exerciseId,
        depth: input.depth,
        text: input.text,
        source: input.source,
        strategyId: input.strategyId,
        strategyVersion: input.strategyVersion,
        model: input.model,
        askedAt: new Date(input.at),
      })
      .run()

    return {
      status: 'given',
      hint: { depth: input.depth, text: input.text, source: input.source, askedAt: input.at },
      created: true,
    }
  })
}

export interface ExerciseSubmissionInput {
  readonly exerciseId: string
  readonly code: string
  readonly outcome: PracticalOutcome
  readonly marking: PracticalMarking
  readonly at: number
}

export type ExerciseSubmissionResult =
  | {
      readonly status: 'recorded'
      readonly submission: SubmissionRecord
      /** False when this exact code had already been submitted; nothing changed. */
      readonly created: boolean
      readonly evidence: RecordedAttempt | null
    }
  | { readonly status: 'refused'; readonly reason: 'unknown' | 'not-verified' | 'already-passed' }

/** The same code, byte for byte, is the same submission. */
export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/**
 * Records a submission and, if it is the first and it could be marked, its evidence.
 *
 * Everything in one transaction:
 *
 *   1. the same code already submitted — return that row and change nothing;
 *   2. the exercise already passed — refuse, there is nothing left to submit;
 *   3. otherwise number it, count the hints taken so far, and insert;
 *   4. if it is submission 1 and marked, derive evidence through `recordAttempt`, with the hints
 *      taken as the true support depth.
 *
 * An unmarked first submission counts for nothing and leaves room for a later one to be the first
 * that *can* count — a run that timed out has not demonstrated anything, so it should not use up
 * the one measurement the exercise provides.
 */
export function submitExerciseAttempt(db: Db, input: ExerciseSubmissionInput): ExerciseSubmissionResult {
  return db.transaction((tx): ExerciseSubmissionResult => {
    const exercise = readExercise(tx, input.exerciseId)
    if (exercise === null) return { status: 'refused', reason: 'unknown' }
    if (exercise.verification !== 'verified') return { status: 'refused', reason: 'not-verified' }

    const codeHash = hashCode(input.code)
    const previous = exercise.submissions.find((submission) => hashCode(submission.code) === codeHash)

    /*
     * The same code again is the same submission — unless that submission could not be marked.
     * A run that timed out said nothing about the code, so blocking the same code from being
     * marked would force a meaningless edit just to be heard (M6 review finding F-08). It is
     * re-marked in place instead, keeping the one row per piece of code.
     */
    if (previous !== undefined && !(previous.state === 'unmarked' && input.marking.kind === 'marked')) {
      return { status: 'recorded', submission: previous, created: false, evidence: null }
    }
    if (previous !== undefined) {
      return remarkWithin(tx, exercise, previous, input)
    }

    if (exercise.submissions.some((submission) => submission.state === 'passed')) {
      return { status: 'refused', reason: 'already-passed' }
    }

    const ordinal = exercise.submissions.length + 1
    const marked = input.marking.kind === 'marked'
    const alreadyCounted = exercise.submissions.some((submission) => submission.counted)
    const counted = marked && !alreadyCounted
    const hintsTaken = exercise.hints.length
    const id = randomUUID()

    tx.insert(exerciseSubmission)
      .values({
        id,
        exerciseId: input.exerciseId,
        ordinal,
        code: input.code,
        codeHash,
        outcome: input.outcome,
        state: marked ? input.marking.state : 'unmarked',
        passedChecks: marked ? input.marking.passedChecks : null,
        totalChecks: exercise.tests.length,
        unmarkedReason: marked ? null : input.marking.reason,
        misconceptions: marked ? [...input.marking.misconceptions] : [],
        hintsTaken,
        counted,
        feedbackStatus: 'pending',
        submittedAt: new Date(input.at),
      })
      .run()

    const evidence =
      counted
        ? recordAttempt(tx, 'exercise', {
            attemptId: id,
            conceptId: exercise.conceptId,
            itemId: exercise.exerciseId ?? exercise.id,
            itemDifficulty: exercise.difficulty,
            correct: input.marking.passed,
            // The true number of hints taken before this submission. ADR-0005: attenuated
            // positive evidence when it passes, never a penalty, never able to lower a band.
            hintDepth: hintsTaken,
            activity: 'exercise',
            misconceptions: input.marking.misconceptions,
            observedAt: input.at,
          })
        : null

    const stored = readExercise(tx, input.exerciseId)?.submissions.find((submission) => submission.id === id)
    if (stored === undefined) throw new Error('The submission was stored but could not be read back.')

    return { status: 'recorded', submission: stored, created: true, evidence }
  })
}

/** Marks, in place, a submission that previously could not be marked, and counts it if it can. */
function remarkWithin(
  db: DbOrTx,
  exercise: ExerciseRecord,
  previous: SubmissionRecord,
  input: ExerciseSubmissionInput,
): ExerciseSubmissionResult {
  if (input.marking.kind !== 'marked') {
    return { status: 'recorded', submission: previous, created: false, evidence: null }
  }
  if (exercise.submissions.some((submission) => submission.state === 'passed')) {
    return { status: 'refused', reason: 'already-passed' }
  }

  const counted = !exercise.submissions.some((submission) => submission.counted)
  const hintsTaken = exercise.hints.length

  db.update(exerciseSubmission)
    .set({
      outcome: input.outcome,
      state: input.marking.state,
      passedChecks: input.marking.passedChecks,
      unmarkedReason: null,
      misconceptions: [...input.marking.misconceptions],
      hintsTaken,
      counted,
      feedbackStatus: 'pending',
      feedback: null,
      submittedAt: new Date(input.at),
    })
    .where(eq(exerciseSubmission.id, previous.id))
    .run()

  const evidence = counted
    ? recordAttempt(db, 'exercise', {
        attemptId: previous.id,
        conceptId: exercise.conceptId,
        itemId: exercise.exerciseId ?? exercise.id,
        itemDifficulty: exercise.difficulty,
        correct: input.marking.passed,
        hintDepth: hintsTaken,
        activity: 'exercise',
        misconceptions: input.marking.misconceptions,
        observedAt: input.at,
      })
    : null

  const stored = readExercise(db, exercise.id)?.submissions.find((submission) => submission.id === previous.id)
  if (stored === undefined) throw new Error('The submission was re-marked but could not be read back.')
  // `created` in the sense that matters to the caller: something new was recorded.
  return { status: 'recorded', submission: stored, created: true, evidence }
}

/**
 * Attaches the tutor's notes to a submission, or records that there are none.
 *
 * Never touches the marking or the evidence: those were settled before any model was asked.
 */
export function recordSubmissionFeedback(
  db: Db,
  input: {
    readonly submissionId: string
    readonly status: 'given' | 'unavailable' | 'not-requested'
    readonly feedback: unknown
    readonly strategyId: string | null
    readonly strategyVersion: string | null
    readonly model: string | null
  },
): void {
  db.update(exerciseSubmission)
    .set({
      feedbackStatus: input.status,
      feedback: input.feedback ?? null,
      feedbackStrategyId: input.strategyId,
      feedbackStrategyVersion: input.strategyVersion,
      feedbackModel: input.model,
    })
    .where(and(eq(exerciseSubmission.id, input.submissionId), eq(exerciseSubmission.feedbackStatus, 'pending')))
    .run()
}
