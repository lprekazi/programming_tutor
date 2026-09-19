import type { Db } from '@/db/client'
import { readConceptState, readConceptStates } from '@/db/repositories/learner-repository'
import {
  reopenSession,
  reserveTutorTurn,
  setSittingPurpose,
  type SessionMode,
  type SessionRecord,
} from '@/db/repositories/session-repository'
import type { ConceptId } from '@/domain/curriculum/types'
import { isReviewDue } from '@/domain/learner-model/state'
import { describeSelection, selectNextConcept, stateLookupFrom } from '@/domain/scheduling/select'
import { MID_LESSON_MS } from '@/domain/tutoring/lifecycle'

/**
 * A sitting: one visit to a conversation that lives for the life of the profile.
 *
 * A session is unique per concept, so the same conversation is taught in March and revisited in
 * April. Everything that means "today" rather than "ever" hangs off the sitting: what it is
 * for, why the learner is here, how many questions have been asked, and whether a question was
 * the last thing that happened.
 *
 * Kept out of the action files because a session is reachable by more than one route — Home,
 * a bookmark, the browser's Back button, the "still open" list — and every one of them has to
 * leave the sitting in the same state (M7 review findings M4, M5 and H-2).
 *
 * The rules, in full:
 *
 *  - A **new sitting** begins when the learner comes back rather than carries on: they had
 *    finished with the conversation, or it has been idle longer than `MID_LESSON_MS`. It gets a
 *    fresh purpose from the scheduler and a tutor turn of its own.
 *  - **Within a sitting the purpose is fixed.** It is not recomputed by every action, because the
 *    scheduler's opinion changes the moment the learner answers: recomputing it turned a review
 *    into a lesson mid-sitting, showed "Starting …" over a five-turn conversation, and exported a
 *    completed review as ordinary teaching (finding M-2). The one exception is an upgrade: Home
 *    saying "Start the review" makes the sitting a review, whatever it began as.
 *  - Nothing here ever overwrites a turn the learner has seen (finding M-1).
 */

export interface Sitting {
  readonly mode: SessionMode
  /** Why the learner is here now. Empty when the scheduler has no opinion about this concept. */
  readonly reason: string
}

/** True when coming to this conversation now would be a return rather than carrying on. */
export function sittingHasLapsed(session: SessionRecord, now: number): boolean {
  return session.closedAt !== null || now - session.updatedAt > MID_LESSON_MS
}

/**
 * What a sitting on this concept would be for, from the scheduler's current decision.
 *
 * The scheduler's first choice, or its second — the concept it would choose with reviews set
 * aside, which Home offers under a review (finding M-4). Anything else has no scheduled reason.
 * `resuming` words the `new` tier for a conversation that already has history in it.
 */
export function sittingFor(db: Db, conceptId: ConceptId, now: number, resuming: boolean): Sitting {
  const lookup = stateLookupFrom(readConceptStates(db))
  const first = selectNextConcept(lookup, now)
  const second = selectNextConcept(lookup, now, { includeReviews: false })

  const chosen = first?.conceptId === conceptId ? first : second?.conceptId === conceptId ? second : null

  return {
    mode: chosen?.reason.kind === 'review-due' ? 'review' : 'teach',
    reason: chosen === null ? '' : describeSelection(chosen, { resuming }),
  }
}

/** Whether the scheduler would currently let the learner start this concept, first or second choice. */
export function isSchedulable(db: Db, conceptId: ConceptId, now: number): boolean {
  const lookup = stateLookupFrom(readConceptStates(db))
  return (
    selectNextConcept(lookup, now)?.conceptId === conceptId ||
    selectNextConcept(lookup, now, { includeReviews: false })?.conceptId === conceptId
  )
}

/**
 * Starts a new sitting if the learner is returning, and says whether one began.
 *
 * Called by everything the learner can do in a session — writing, asking for a question or an
 * exercise — and by the page when it is reached without going through Home. Within a sitting it
 * changes nothing at all.
 */
export function refreshSitting(db: Db, session: SessionRecord, now: number): boolean {
  if (!sittingHasLapsed(session, now)) return false

  reopenSession(db, session.id, now, sittingFor(db, session.conceptId, now, session.turns.length > 0))
  return true
}

/**
 * Starts a sitting from a deliberate choice — Home's button, or arriving at a lapsed
 * conversation — and gives it a tutor turn to open it.
 *
 * The opening turn is what carries a review's instruction to the model, so a sitting without one
 * is a review in name only (findings H1, H-2). It is reserved in two cases and no others: a new
 * sitting has just begun, or the conversation has never been opened at all. The second used to
 * read "ordinal 0 is not complete", which stays true for ever once an opening is stopped, and
 * appended a fresh tutor turn — and a fresh provider call re-answering the same message — on
 * every press of Continue (finding H-1).
 *
 * `upgrade` is Home's case: the learner pressed "Start the review", so a sitting that began as
 * a lesson becomes a review. Nothing ever turns a review back into a lesson mid-sitting.
 */
export function beginSitting(
  db: Db,
  session: SessionRecord,
  now: number,
  provenance: { readonly strategyId: string; readonly strategyVersion: string; readonly model: string },
  options: { readonly upgrade: boolean },
): boolean {
  const neverOpened = session.turns.length === 0 || (session.turns.length === 1 && session.turns[0]?.status !== 'complete')
  const fresh = refreshSitting(db, session, now)

  if (!fresh && options.upgrade) {
    const sitting = sittingFor(db, session.conceptId, now, session.turns.length > 0)
    if (sitting.mode === 'review' && session.mode !== 'review') setSittingPurpose(db, session.id, sitting)
  }

  if (!fresh && !neverOpened) return false

  // A new sitting appends; it never rewrites a stopped or failed reply the learner has read. Only
  // a conversation's own unopened opening turn is retried in place.
  reserveTutorTurn(db, session.id, provenance, now, { reuse: fresh ? 'untouched' : 'retry' })
  return true
}

/**
 * Whether this sitting is a review, right now.
 *
 * Both halves are required. The row says what the sitting was opened as; `isReviewDue` says
 * whether that is still true. A review that has since been answered must stop lifting the check
 * selector's holds — it is still the sitting it was, and the page still says so, but a second
 * recall question is no longer what the scheduler asked for.
 */
export function isReviewingNow(db: Db, session: SessionRecord, now: number): boolean {
  return session.mode === 'review' && isReviewDue(readConceptState(db, session.conceptId), now)
}
