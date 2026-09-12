import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'

import type { ConceptId, MisconceptionId } from '@/domain/curriculum/types'
import { nextOrdinal, type Turn, type TurnStatus } from '@/domain/tutoring/session'

import type { Db } from '../client'
import { llmCall, sessionObservation, sessionTurn, tutoringSession } from '../schema'
import { LEARNER_ID } from './learner-repository'

/**
 * The tutoring conversation's persistence.
 *
 * Two guarantees live here, and both are the database's rather than the application's.
 *
 * **One session per concept.** `unique(learner, concept)` plus an insert that tolerates
 * conflict, so pressing Start twice, or having the application open in two tabs, finds the
 * conversation that already exists. That is also what makes Continue mean something: there is
 * only ever one thread about a given concept to continue.
 *
 * **One tutor reply per exchange.** `unique(session, ordinal)`, with the tutor's turn created
 * *before* its text is streamed. A retry after an interrupted stream computes the same ordinal,
 * finds the same row, and rewrites it. There is no arrangement of retries, double-clicks or
 * dropped connections that can append a second copy of the tutor's reply, because there is no
 * second place for it to go.
 *
 * Nothing in this file writes to `concept_state` or `evidence`. Conversation is not
 * performance, and there is deliberately no import here that would let it become so.
 */

export interface SessionRecord {
  readonly id: string
  readonly conceptId: ConceptId
  /** Why the scheduler chose this concept when the session opened. */
  readonly openedReason: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly closedAt: number | null
  readonly turns: readonly Turn[]
}

function readTurns(db: Db, sessionId: string): readonly Turn[] {
  return db
    .select()
    .from(sessionTurn)
    .where(eq(sessionTurn.sessionId, sessionId))
    .all()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      role: row.role === 'tutor' ? 'tutor' : 'learner',
      text: row.text,
      status: row.status as TurnStatus,
    }))
}

function hydrate(
  db: Db,
  row: typeof tutoringSession.$inferSelect,
): SessionRecord {
  return {
    id: row.id,
    conceptId: row.conceptId as ConceptId,
    openedReason: row.openedReason,
    startedAt: row.startedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    closedAt: row.closedAt?.getTime() ?? null,
    turns: readTurns(db, row.id),
  }
}

/**
 * Finds the session for a concept, starting one if there is none.
 *
 * `onConflictDoNothing` rather than a read-then-write, so two requests arriving together
 * cannot both decide the session does not exist yet. Whichever loses the race reads back the
 * row the other created.
 */
export function openSession(
  db: Db,
  conceptId: ConceptId,
  reason: string,
  at: number,
): SessionRecord {
  db.insert(tutoringSession)
    .values({
      id: randomUUID(),
      learnerId: LEARNER_ID,
      conceptId,
      openedReason: reason,
      startedAt: new Date(at),
      updatedAt: new Date(at),
    })
    .onConflictDoNothing({ target: [tutoringSession.learnerId, tutoringSession.conceptId] })
    .run()

  const [row] = db
    .select()
    .from(tutoringSession)
    .where(
      and(eq(tutoringSession.learnerId, LEARNER_ID), eq(tutoringSession.conceptId, conceptId)),
    )
    .all()

  if (row === undefined) throw new Error(`The session for ${conceptId} could not be opened.`)
  return hydrate(db, row)
}

export function readSession(db: Db, sessionId: string): SessionRecord | null {
  const [row] = db.select().from(tutoringSession).where(eq(tutoringSession.id, sessionId)).all()
  return row === undefined ? null : hydrate(db, row)
}

/**
 * The open session the learner was most recently working in.
 *
 * Filters for open *before* taking the newest. Taking the newest row and then checking whether
 * it happened to be open reported nothing whenever the most recent session had been finished —
 * hiding an older conversation that was still going, and with it the only route back to a
 * session that is not the current recommendation.
 */
export function readLatestOpenSession(db: Db): SessionRecord | null {
  const [row] = db
    .select()
    .from(tutoringSession)
    .where(and(eq(tutoringSession.learnerId, LEARNER_ID), isNull(tutoringSession.closedAt)))
    .orderBy(desc(tutoringSession.updatedAt))
    .all()

  return row === undefined ? null : hydrate(db, row)
}

/**
 * The session a turn belongs to.
 *
 * A turn id arrives from the client and is opaque, so the session it belongs to is read from
 * storage rather than taken on trust from the request alongside it.
 */
export function readSessionByTurn(db: Db, turnId: string): SessionRecord | null {
  const [row] = db.select().from(sessionTurn).where(eq(sessionTurn.id, turnId)).all()
  return row === undefined ? null : readSession(db, row.sessionId)
}

export function readSessionForConcept(db: Db, conceptId: ConceptId): SessionRecord | null {
  const [row] = db
    .select()
    .from(tutoringSession)
    .where(
      and(eq(tutoringSession.learnerId, LEARNER_ID), eq(tutoringSession.conceptId, conceptId)),
    )
    .all()

  return row === undefined ? null : hydrate(db, row)
}

/** Concepts with a conversation still open, so Home can say "Continue" rather than "Start". */
export function readOpenSessionConcepts(db: Db): readonly ConceptId[] {
  return db
    .select()
    .from(tutoringSession)
    .where(eq(tutoringSession.learnerId, LEARNER_ID))
    .all()
    .filter((row) => row.closedAt === null)
    .map((row) => row.conceptId as ConceptId)
}

function touch(db: Db, sessionId: string, at: number): void {
  db.update(tutoringSession)
    .set({ updatedAt: new Date(at) })
    .where(eq(tutoringSession.id, sessionId))
    .run()
}

export interface PendingTurn {
  readonly turnId: string
  readonly ordinal: number
}

/**
 * Reserves the tutor's next turn without any text in it.
 *
 * Called before the stream starts, so that the row the text will land in exists first. If the
 * ordinal is already taken — a retry, a double-click, a second tab — the existing row is
 * reused and reset to pending rather than a new one being created.
 */
export function reserveTutorTurn(
  db: Db,
  sessionId: string,
  provenance: { readonly strategyId: string; readonly strategyVersion: string; readonly model: string },
  at: number,
): PendingTurn {
  const turns = readTurns(db, sessionId)
  const last = turns.at(-1)

  // A tutor turn that is still unfinished is the one to retry, not a reason to open another.
  if (last?.role === 'tutor' && last.status !== 'complete') {
    db.update(sessionTurn)
      .set({ status: 'pending', text: '', updatedAt: new Date(at), ...provenance })
      .where(eq(sessionTurn.id, last.id))
      .run()
    return { turnId: last.id, ordinal: last.ordinal }
  }

  const ordinal = nextOrdinal(turns)
  const id = randomUUID()

  db.insert(sessionTurn)
    .values({
      id,
      sessionId,
      ordinal,
      role: 'tutor',
      text: '',
      status: 'pending',
      strategyId: provenance.strategyId,
      strategyVersion: provenance.strategyVersion,
      model: provenance.model,
      createdAt: new Date(at),
      updatedAt: new Date(at),
    })
    .onConflictDoNothing({ target: [sessionTurn.sessionId, sessionTurn.ordinal] })
    .run()

  const [row] = db
    .select()
    .from(sessionTurn)
    .where(and(eq(sessionTurn.sessionId, sessionId), eq(sessionTurn.ordinal, ordinal)))
    .all()

  if (row === undefined) throw new Error('The tutor turn could not be reserved.')
  touch(db, sessionId, at)
  return { turnId: row.id, ordinal: row.ordinal }
}

export type AppendResult =
  | { readonly stored: true; readonly turn: Turn }
  /**
   * Another message reached this position first, so nothing was written.
   *
   * Two tabs, or a click that beat React's commit. The previous version read back whatever row
   * occupied the ordinal and returned it as though it were the one it had just written — so the
   * loser's words vanished and the caller reported a successful send. Silent failure on the one
   * thing the learner typed.
   */
  | { readonly stored: false }

/** Stores what the learner wrote. Their words are kept verbatim and never interpreted here. */
export function appendLearnerTurn(
  db: Db,
  sessionId: string,
  text: string,
  at: number,
): AppendResult {
  const turns = readTurns(db, sessionId)
  const ordinal = nextOrdinal(turns)
  const id = randomUUID()

  const inserted = db
    .insert(sessionTurn)
    .values({
      id,
      sessionId,
      ordinal,
      role: 'learner',
      text,
      status: 'complete',
      createdAt: new Date(at),
      updatedAt: new Date(at),
    })
    .onConflictDoNothing({ target: [sessionTurn.sessionId, sessionTurn.ordinal] })
    .returning({ id: sessionTurn.id })
    .all()

  // Only the row this call created counts. Reading back whatever occupies the ordinal would
  // hand the caller somebody else's message and call it stored.
  if (inserted[0]?.id !== id) return { stored: false }

  touch(db, sessionId, at)
  return { stored: true, turn: { id, ordinal, role: 'learner', text, status: 'complete' } }
}

/** Marks a tutor turn as being streamed right now, so a reload does not start a second one. */
export function markTurnStreaming(db: Db, turnId: string, at: number): void {
  db.update(sessionTurn)
    .set({ status: 'streaming', updatedAt: new Date(at) })
    .where(and(eq(sessionTurn.id, turnId), eq(sessionTurn.status, 'pending')))
    .run()
}

/**
 * Records how a tutor turn ended, and whatever text had arrived by then.
 *
 * Cancelled and failed turns keep their partial text on purpose: a learner who pressed Stop
 * half way through has read half a reply, and making it vanish would be more confusing than
 * leaving it with a note saying it was stopped.
 *
 * **A cancellation is never overwritten, by anything.** The learner pressing Stop and the
 * request finishing are two things happening at once, and the learner's view is the one that
 * counts: what they saw is what the transcript should say. The earlier version of this guard
 * allowed a *cancellation* through, which meant the in-flight request — which classifies an
 * abort as a cancellation too — overwrote the text the learner had actually read with whatever
 * it had managed to consume.
 *
 * `recordCancellation` is how the learner's own Stop gets written. Only `reserveTutorTurn` can
 * reopen a cancelled turn, and only because a retry is the learner asking for it again.
 */
export function finishTutorTurn(
  db: Db,
  turnId: string,
  status: TurnStatus,
  text: string,
  at: number,
): void {
  const [existing] = db.select().from(sessionTurn).where(eq(sessionTurn.id, turnId)).all()
  if (existing?.status === 'cancelled') return

  db.update(sessionTurn)
    .set({ status, text, updatedAt: new Date(at) })
    .where(eq(sessionTurn.id, turnId))
    .run()

  const [row] = db.select().from(sessionTurn).where(eq(sessionTurn.id, turnId)).all()
  if (row !== undefined) touch(db, row.sessionId, at)
}

/**
 * Records that the learner stopped a reply, and what they had read when they did.
 *
 * The one write that takes precedence over the request still finishing. Everything else goes
 * through `finishTutorTurn`, which refuses to touch a cancelled turn.
 */
export function recordCancellation(db: Db, turnId: string, text: string, at: number): void {
  db.update(sessionTurn)
    .set({ status: 'cancelled', text, updatedAt: new Date(at) })
    .where(eq(sessionTurn.id, turnId))
    .run()

  const [row] = db.select().from(sessionTurn).where(eq(sessionTurn.id, turnId)).all()
  if (row !== undefined) touch(db, row.sessionId, at)
}

/** Marks the session finished for now. Idempotent. */
export function closeSession(db: Db, sessionId: string, at: number): void {
  const [row] = db.select().from(tutoringSession).where(eq(tutoringSession.id, sessionId)).all()
  if (row === undefined || row.closedAt !== null) return

  db.update(tutoringSession)
    .set({ closedAt: new Date(at), updatedAt: new Date(at) })
    .where(eq(tutoringSession.id, sessionId))
    .run()
}

/** Reopens a closed session so the learner can carry on where they were. Idempotent. */
export function reopenSession(db: Db, sessionId: string, at: number): void {
  db.update(tutoringSession)
    .set({ closedAt: null, updatedAt: new Date(at) })
    .where(eq(tutoringSession.id, sessionId))
    .run()
}

export interface ObservationInput {
  readonly sessionId: string
  readonly turnId: string
  readonly conceptsDiscussed: readonly ConceptId[]
  readonly misconceptions: readonly MisconceptionId[]
  readonly note: string
  readonly at: number
}

/**
 * Records what an exchange appeared to be about.
 *
 * Note what this function does **not** do: it does not call `recordAttempt`, it does not read
 * or write `concept_state`, and it has no parameter that could carry a judgement of the
 * learner. Conversation is not performance. This row is a note for a human, and for a later
 * milestone that has real evidence to work with.
 */
export function recordObservation(db: Db, input: ObservationInput): void {
  db.insert(sessionObservation)
    .values({
      id: randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      conceptsDiscussed: [...input.conceptsDiscussed],
      misconceptions: [...input.misconceptions],
      note: input.note,
      observedAt: new Date(input.at),
    })
    .run()
}

export function readObservations(db: Db, sessionId: string) {
  return db
    .select()
    .from(sessionObservation)
    .where(eq(sessionObservation.sessionId, sessionId))
    .all()
}

/** Every call made on the learner's behalf, newest first. Metadata only; no content. */
export function readCallLog(db: Db, limit = 50) {
  return db
    .select()
    .from(llmCall)
    .where(eq(llmCall.learnerId, LEARNER_ID))
    .orderBy(desc(llmCall.at))
    .limit(limit)
    .all()
}
