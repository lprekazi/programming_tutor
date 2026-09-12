import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { getConcept, isMisconceptionId } from '@/domain/curriculum/graph'
import type { ConceptId, MisconceptionId } from '@/domain/curriculum/types'
import type { Marking } from '@/domain/assessment/score'
import type { PracticeItemKind } from '@/domain/assessment/items'
import type { StoredActivity } from '@/domain/assessment/present'

import type { Db, DbOrTx } from '../client'
import { activityAttempt, activityHint, sessionActivity } from '../schema'
import { recordAttempt, type RecordedAttempt } from './learner-repository'

/**
 * Evaluated activities, and the one guarantee this file exists to make.
 *
 * **One answer produces at most one change in the learner model.** `activity_attempt` is unique
 * on `activity_id`, the insert tolerates a conflict, and evidence is derived *only* when the
 * insert actually creates a row. So a double-click, a refresh mid-request, a replayed server
 * action, a React re-render firing twice, or a retry after the marking failed all arrive at the
 * same row and the second one changes nothing. The check is the database's, with no window
 * between looking and writing.
 *
 * The other half is what does *not* happen here. Nothing in this file marks an answer or
 * decides what a verdict means; it is handed a `Marking` the domain produced and stores it.
 * And an unmarked attempt is stored without calling `recordAttempt` at all — the attempt
 * happened, the learner can see it, and the learner model is untouched.
 */

export interface ActivityDraft {
  readonly sessionId: string
  readonly turnId: string
  readonly conceptId: ConceptId
  readonly kind: PracticeItemKind
  /** The authored item, or null when generated. */
  readonly itemId: string | null
  readonly origin: 'authored' | 'generated'
  readonly prompt: string
  readonly code: string | null
  readonly options: readonly string[] | null
  readonly correctIndex: number | null
  readonly optionMisconceptions: readonly (string | null)[] | null
  readonly expectedOutput: string | null
  readonly knownWrongAnswers:
    | readonly { readonly answer: string; readonly misconception: string }[]
    | null
  readonly expectedPoints: string | null
  readonly explanation: string
  readonly selectionGround: string
  readonly probesMisconception: MisconceptionId | null
  readonly strategyId: string | null
  readonly strategyVersion: string | null
  readonly model: string | null
  readonly at: number
}

export interface ActivityRecord extends StoredActivity {
  readonly sessionId: string
  readonly turnId: string
  readonly origin: 'authored' | 'generated'
  readonly itemId: string | null
  readonly probesMisconception: MisconceptionId | null
  readonly attempt: AttemptRecord | null
  readonly hints: readonly { readonly depth: number; readonly text: string }[]
  /** When the question was asked. Used to count what belongs to this sitting. */
  readonly createdAt: number
}

export interface AttemptRecord {
  readonly id: string
  readonly response: string
  readonly marked: boolean
  readonly correct: boolean | null
  readonly partial: boolean
  readonly markingSource: 'deterministic' | 'model' | null
  readonly unmarkedReason: string | null
  readonly misconceptions: readonly MisconceptionId[]
  readonly hintDepth: number
  readonly feedback: string
  readonly attemptedAt: number
}

function hydrate(db: DbOrTx, row: typeof sessionActivity.$inferSelect): ActivityRecord {
  const [attemptRow] = db
    .select()
    .from(activityAttempt)
    .where(eq(activityAttempt.activityId, row.id))
    .all()

  const hints = db
    .select()
    .from(activityHint)
    .where(eq(activityHint.activityId, row.id))
    .all()
    .sort((a, b) => a.depth - b.depth)
    .map((hint) => ({ depth: hint.depth, text: hint.text }))

  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    conceptId: row.conceptId as ConceptId,
    kind: row.kind as PracticeItemKind,
    origin: row.origin === 'generated' ? 'generated' : 'authored',
    itemId: row.itemId,
    prompt: row.prompt,
    code: row.code,
    options: row.options,
    correctIndex: row.correctIndex,
    optionMisconceptions: row.optionMisconceptions,
    expectedOutput: row.expectedOutput,
    knownWrongAnswers: row.knownWrongAnswers,
    expectedPoints: row.expectedPoints,
    explanation: row.explanation,
    selectionGround: row.selectionGround,
    createdAt: row.createdAt.getTime(),
    probesMisconception: isMisconceptionId(row.probesMisconception ?? '')
      ? (row.probesMisconception as MisconceptionId)
      : null,
    hints,
    attempt:
      attemptRow === undefined
        ? null
        : {
            id: attemptRow.id,
            response: attemptRow.response,
            marked: attemptRow.outcome === 'marked',
            correct: attemptRow.correct,
            partial: attemptRow.partial,
            markingSource:
              attemptRow.markingSource === 'model'
                ? 'model'
                : attemptRow.markingSource === 'deterministic'
                  ? 'deterministic'
                  : null,
            unmarkedReason: attemptRow.unmarkedReason,
            // Filtered rather than cast: a stored id the catalogue no longer knows is
            // dropped rather than driving anything downstream.
            misconceptions: attemptRow.misconceptions.filter(isMisconceptionId),
            hintDepth: attemptRow.hintDepth,
            feedback: attemptRow.feedback,
            attemptedAt: attemptRow.attemptedAt.getTime(),
          },
  }
}

/**
 * Stores a question the tutor has decided to ask.
 *
 * Unique on the turn, so the activity occupies exactly one position in the conversation. A
 * second attempt to attach one to the same turn finds the one already there — which is what
 * makes asking idempotent under a double-click, the same way reserving a tutor turn is.
 */
export function createActivity(db: DbOrTx, draft: ActivityDraft): ActivityRecord {
  db.insert(sessionActivity)
    .values({
      id: randomUUID(),
      sessionId: draft.sessionId,
      turnId: draft.turnId,
      conceptId: draft.conceptId,
      kind: draft.kind,
      itemId: draft.itemId,
      origin: draft.origin,
      prompt: draft.prompt,
      code: draft.code,
      options: draft.options === null ? null : [...draft.options],
      correctIndex: draft.correctIndex,
      optionMisconceptions:
        draft.optionMisconceptions === null ? null : [...draft.optionMisconceptions],
      expectedOutput: draft.expectedOutput,
      knownWrongAnswers:
        draft.knownWrongAnswers === null
          ? null
          : draft.knownWrongAnswers.map((wrong) => ({ ...wrong })),
      expectedPoints: draft.expectedPoints,
      explanation: draft.explanation,
      selectionGround: draft.selectionGround,
      probesMisconception: draft.probesMisconception,
      strategyId: draft.strategyId,
      strategyVersion: draft.strategyVersion,
      model: draft.model,
      createdAt: new Date(draft.at),
    })
    .onConflictDoNothing({ target: [sessionActivity.turnId] })
    .run()

  const record = readActivityByTurn(db, draft.turnId)
  if (record === null) throw new Error('The activity could not be created.')
  return record
}

export function readActivity(db: DbOrTx, activityId: string): ActivityRecord | null {
  const [row] = db.select().from(sessionActivity).where(eq(sessionActivity.id, activityId)).all()
  return row === undefined ? null : hydrate(db, row)
}

export function readActivityByTurn(db: DbOrTx, turnId: string): ActivityRecord | null {
  const [row] = db.select().from(sessionActivity).where(eq(sessionActivity.turnId, turnId)).all()
  return row === undefined ? null : hydrate(db, row)
}

/** Every activity in a session, oldest first. */
export function readSessionActivities(db: Db, sessionId: string): readonly ActivityRecord[] {
  return db
    .select()
    .from(sessionActivity)
    .where(eq(sessionActivity.sessionId, sessionId))
    .all()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => hydrate(db, row))
}

/**
 * Authored items this learner has already been asked, ever.
 *
 * Across sessions, not only within one: meeting the same question again teaches a learner that
 * they have seen it before, which is not what any of this is for.
 */
export function readUsedItemIds(db: Db): readonly string[] {
  return db
    .select({ itemId: sessionActivity.itemId })
    .from(sessionActivity)
    .all()
    .flatMap((row) => (row.itemId === null ? [] : [row.itemId]))
}

export interface SubmissionResult {
  /** False when this activity had already been answered and nothing was recorded again. */
  readonly recorded: boolean
  readonly attempt: AttemptRecord
  /** What the evidence pathway did, where anything did. Null for an unmarked attempt. */
  readonly evidence: RecordedAttempt | null
}

export interface SubmissionInput {
  readonly activityId: string
  readonly response: string
  readonly marking: Marking
  readonly feedback: string
  readonly hintDepth: number
  readonly at: number
}

/**
 * Records one answer, exactly once, and derives evidence from it only if it is new.
 *
 * The whole thing runs in one transaction. The unique constraint stops one answer becoming two
 * pieces of evidence; the transaction stops it becoming none — without it, a failure part-way
 * through `recordAttempt` would leave the attempt row committed and the constraint would then
 * make every retry a silent no-op, so that answer could never produce evidence again.
 */
export function submitAttempt(db: Db, input: SubmissionInput): SubmissionResult {
  return db.transaction((tx) => submitWithin(tx, input))
}

function submitWithin(db: DbOrTx, input: SubmissionInput): SubmissionResult {
  const activity = readActivity(db, input.activityId)
  if (activity === null) throw new Error(`Unknown activity: ${input.activityId}`)

  const marked = input.marking.kind === 'marked'
  const id = randomUUID()

  const inserted = db
    .insert(activityAttempt)
    .values({
      id,
      activityId: input.activityId,
      response: input.response,
      outcome: marked ? 'marked' : 'unmarked',
      correct: marked ? input.marking.correct : null,
      partial: marked ? input.marking.partial : false,
      markingSource: marked ? input.marking.source : null,
      unmarkedReason: marked ? null : input.marking.reason,
      misconceptions: marked ? [...input.marking.misconceptions] : [],
      hintDepth: input.hintDepth,
      feedback: input.feedback,
      attemptedAt: new Date(input.at),
    })
    .onConflictDoNothing({ target: [activityAttempt.activityId] })
    .returning({ id: activityAttempt.id })
    .all()

  if (inserted[0]?.id !== id) {
    // Already answered. Report the stored attempt rather than the incoming one, so a stale
    // resubmission cannot appear to change what was recorded.
    const stored = readActivity(db, input.activityId)?.attempt
    if (stored === null || stored === undefined) {
      throw new Error('The attempt conflicted but could not be read back.')
    }
    return { recorded: false, attempt: stored, evidence: null }
  }

  /*
   * Evidence, and only now.
   *
   * Gated three ways: the row had to be new, the answer had to be markable, and the numbers
   * come from `recordAttempt` — which takes an *attempt* and has no parameter through which an
   * estimate could be supplied. An unmarked attempt skips this entirely, so a provider failure
   * cannot leave a learner's standing changed.
   */
  const evidence =
    input.marking.kind === 'marked'
      ? recordAttempt(db, sourceOf(activity.kind), {
          attemptId: id,
          conceptId: activity.conceptId,
          itemId: activity.itemId ?? activity.id,
          itemDifficulty: difficultyOf(activity),
          correct: input.marking.correct,
          // The true depth, and the partial flag separately. A partially correct answer is
          // attenuated exactly as a hinted success is (ADR-0005: never a penalty, never able to
          // lower a band), but adding one to the depth to achieve that made the learner's own
          // evidence log claim they had taken a hint they never took.
          hintDepth: input.hintDepth,
          partial: input.marking.partial,
          misconceptions: input.marking.misconceptions,
          observedAt: input.at,
        })
      : null

  const attempt = readActivity(db, input.activityId)?.attempt
  if (attempt === null || attempt === undefined) {
    throw new Error('The attempt was stored but could not be read back.')
  }

  return { recorded: true, attempt, evidence }
}

/** Where this evidence came from, for the evidence log. */
function sourceOf(kind: PracticeItemKind): string {
  switch (kind) {
    case 'choice':
      return 'quiz'
    case 'predict-output':
      return 'code-reading'
    case 'short-response':
      return 'short-response'
  }
}

/**
 * The difficulty the evidence update is judged against.
 *
 * The concept's own baseline, not the item's. An authored item's difficulty is a declared prior
 * (ADR-0004) and is never revised, and a generated item has no trustworthy one at all — a
 * generator that called its question hard would be inflating what answering it demonstrates.
 * The concept's baseline is the one number here that nothing being assessed can influence.
 */
function difficultyOf(activity: ActivityRecord): number {
  return getConcept(activity.conceptId).baselineDifficulty
}

export interface HintDraft {
  readonly activityId: string
  readonly depth: number
  readonly text: string
  readonly strategyId: string | null
  readonly strategyVersion: string | null
  readonly model: string | null
  readonly at: number
}

/**
 * Stores a hint the learner asked for. Idempotent per depth, and refused once answered.
 *
 * Asking twice for the same step returns the same words rather than generating new ones, so
 * `hintDepth` counts steps taken rather than buttons pressed.
 *
 * The answered check is inside the transaction, not before it. The caller does check, but it
 * checks *before* waiting on a model for the hint text, and an answer submitted during that
 * wait would leave a hint recorded against an attempt whose evidence was already derived
 * unattenuated — the record would show help the learner took after the fact, and the numbers
 * would disagree with it. Returns whether anything was stored.
 */
export function recordHint(db: Db, draft: HintDraft): boolean {
  return db.transaction((tx) => {
    const [answered] = tx
      .select()
      .from(activityAttempt)
      .where(eq(activityAttempt.activityId, draft.activityId))
      .all()

    if (answered !== undefined) return false

    const inserted = tx
      .insert(activityHint)
      .values({
        id: randomUUID(),
        activityId: draft.activityId,
        depth: draft.depth,
        text: draft.text,
        strategyId: draft.strategyId,
        strategyVersion: draft.strategyVersion,
        model: draft.model,
        askedAt: new Date(draft.at),
      })
      .onConflictDoNothing({ target: [activityHint.activityId, activityHint.depth] })
      .returning()
      .all()

    return inserted.length > 0
  })
}
