import { getConcept } from '../curriculum/graph'
import type { ConceptId } from '../curriculum/types'
import { isReviewDue } from '../learner-model/state'
import { isMidLesson, lifecycleOf, type SessionLifecycle, type SessionTiming } from '../tutoring/lifecycle'
import { overdueBy } from './review'
import { describeSelection, groundsFor, selectNextConcept, type Selection, type StateLookup } from './select'

/**
 * The one thing Home asks the learner to do.
 *
 * Two questions were being answered separately and could disagree: the scheduler said which
 * *concept* to work on, and the page separately noticed whether some conversation happened to
 * be open. This resolves both into a single recommendation, with the reason it was reached, so
 * that the sentence shown to the learner and the button they press cannot come from different
 * decisions.
 *
 * The priority rule, in full, and the reason for each step:
 *
 *  1. **A session the learner is in the middle of.** Interrupting somebody who stepped away for
 *     ten minutes to tell them something else is due is not scheduling, it is nagging. Bounded
 *     by `MID_LESSON_MS` so it cannot become "whatever they last touched, for ever".
 *  2. **Whatever the scheduler picks** — review first, then weak, then unsettled, then new; the
 *     ordering lives in `selectNextConcept` and is not duplicated here. If a conversation about
 *     that concept is already open, the recommendation is to continue it rather than to start
 *     something that already exists.
 *  3. **Nothing**, when everything reachable is settled and nothing is due. Said plainly rather
 *     than dressed up as a task.
 *
 * Dormant sessions (`lifecycleOf`) never win step 1 and are never the button: they are listed
 * separately, so a conversation from last month is something the learner chooses to go back to
 * rather than something the tutor pretends they are in the middle of.
 */

/** An open or closed conversation, as much of it as the recommendation needs. */
export interface SessionSummary extends SessionTiming {
  readonly id: string
  readonly conceptId: ConceptId
}

export type Recommendation =
  /** Carry on a conversation that is already going. */
  | {
      readonly kind: 'continue'
      readonly sessionId: string
      readonly conceptId: ConceptId
      /**
       * Why this one:
       *  - `mid-lesson`  — they were in it a short while ago and are carrying on;
       *  - `scheduled`   — the scheduler chose this concept and a live conversation exists;
       *  - `returning`   — the scheduler chose it and the conversation has gone dormant;
       *  - `finished`    — the scheduler chose it and the learner had finished the conversation.
       */
      readonly because: 'mid-lesson' | 'scheduled' | 'returning' | 'finished'
      /** When the conversation was last touched. What "you left this open N days ago" reads. */
      readonly leftAt?: number | undefined
      /** The scheduler's decision, where it had one. Null when it had nothing to say. */
      readonly selection: Selection | null
      /** What else the learner may start instead, when this is a review. See `alternativeTo`. */
      readonly alternative: Selection | null
    }
  /** Start the concept the scheduler chose. There is no conversation about it, open or finished. */
  | {
      readonly kind: 'study'
      readonly conceptId: ConceptId
      readonly selection: Selection
      /** Always null: a concept with any conversation at all, even a finished one, is a `continue`. */
      readonly sessionId: null
      /** What else the learner may start instead, when this is a review. See `alternativeTo`. */
      readonly alternative: Selection | null
    }
  /** Nothing is due and nothing is open. */
  | { readonly kind: 'nothing' }

/** What the learner is being asked to do, in the words the interface uses. */
/**
 * One kind per branch, because the label and the sentence come from the same decision.
 *
 * Three was not enough. A concept the learner had answered questions on in the diagnostic, with
 * no conversation about it yet, is neither new nor something to continue — but it was labelled
 * "New / Start learning" above the scheduler's own sentence, "Continuing with repeating while
 * something is true. You have made a start…". Likewise a conversation left open a month ago is
 * not "Still going". Each of those is the same defect the module exists to prevent, so each
 * branch now has a word of its own.
 */
export type ActivityKind =
  /** The scheduler brought it back. */
  | 'review'
  /** A conversation that is live: they were in it recently, or it is today's choice. */
  | 'continue'
  /** A conversation they left open long enough ago that going back is a decision. */
  | 'resume'
  /** A conversation they had finished with, which the scheduler has brought back. */
  | 'reopen'
  /** No conversation yet, but they have attempted the concept before. */
  | 'practise'
  /** No conversation, and nothing demonstrated here yet. */
  | 'learn'

export function activityKindOf(recommendation: Recommendation): ActivityKind | null {
  switch (recommendation.kind) {
    case 'continue':
      // A continuation that is also the scheduler's review is still a review: the mode the
      // session runs in is decided by the same fact, so calling it anything else here would
      // disagree with the session the learner then opens. A mid-lesson continuation is not,
      // whatever else is due — that review is what comes next, and the grounds say so.
      if (recommendation.selection?.reason.kind === 'review-due' && recommendation.because !== 'mid-lesson') {
        return 'review'
      }
      if (recommendation.because === 'returning') return 'resume'
      if (recommendation.because === 'finished') return 'reopen'
      return 'continue'
    case 'study':
      switch (recommendation.selection.reason.kind) {
        case 'review-due':
          return 'review'
        case 'new':
          return 'learn'
        // All three are concepts the learner has already met, so none of them is "new".
        case 'weak':
        case 'in-progress':
        case 'consolidating':
          return 'practise'
      }
    case 'nothing':
      return null
  }
}

export interface RecommendationInput {
  readonly lookup: StateLookup
  /** Every session the learner has, open or closed. */
  readonly sessions: readonly SessionSummary[]
  readonly now: number
}

export function recommendNext({ lookup, sessions, now }: RecommendationInput): Recommendation {
  // Most recently touched first, so "the one they are in the middle of" is unambiguous when
  // more than one is open. Finished conversations are included: a concept the scheduler brings
  // back may be one the learner closed, and that conversation is what pressing the button opens.
  const byRecency = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  // `isMidLesson` is false for a finished conversation, so only open ones can be "current".
  const current = byRecency.find((session) => isMidLesson(session, now))
  const selection = selectNextConcept(lookup, now)
  const alternative = alternativeTo(selection, lookup, now)

  if (current !== undefined) {
    /*
     * Always "mid-lesson", even when the scheduler would have chosen the same concept.
     *
     * The two are different situations and the sentence the learner reads comes from this
     * field. Collapsing them meant a learner who had been reading about a concept for ten
     * minutes — and so had demonstrated nothing about it yet — was shown "Continue" above the
     * sentence "Starting how a program runs", which is the exact mismatch this module exists to
     * prevent (M7 review finding M3).
     */
    return {
      kind: 'continue',
      sessionId: current.id,
      conceptId: current.conceptId,
      because: 'mid-lesson',
      selection,
      // Nothing is withheld mid-lesson: the review it stood down for is named in the grounds.
      alternative: null,
    }
  }

  if (selection === null) return { kind: 'nothing' }

  const existing = byRecency.find((session) => session.conceptId === selection.conceptId)
  if (existing !== undefined) {
    /*
     * A conversation about this concept already exists, so the learner is going back to it
     * rather than starting something. Active, dormant or finished changes the words — "you
     * left this open a fortnight ago" is not "continue" — but not the fact: pressing the button
     * opens a conversation with history in it, and saying "Start learning" over the top of that
     * was a plain untruth (M7 review findings M2 and, for finished conversations, H-3).
     */
    const standing = lifecycleOf(existing, now)
    return {
      kind: 'continue',
      sessionId: existing.id,
      conceptId: existing.conceptId,
      because: standing === 'completed' ? 'finished' : standing === 'dormant' ? 'returning' : 'scheduled',
      leftAt: existing.updatedAt,
      selection,
      alternative,
    }
  }

  return { kind: 'study', conceptId: selection.conceptId, selection, sessionId: null, alternative }
}

/**
 * What the learner may start instead of a review.
 *
 * A review is cleared only by a marked answer, and one cannot always be asked: a concept whose
 * authored questions have all been used, with no provider reachable to write another, has
 * nothing to ask. Without a second choice that review would lead Home for ever, and since
 * nothing may be started that the scheduler has not chosen, every other concept would be
 * refused with it — new material starved permanently (M7 review finding M-4).
 *
 * The second choice is the scheduler's own, with reviews set aside. It is offered, not
 * substituted: the review stays first, and nothing about it is stored or moved.
 */
function alternativeTo(selection: Selection | null, lookup: StateLookup, now: number): Selection | null {
  if (selection?.reason.kind !== 'review-due') return null

  const instead = selectNextConcept(lookup, now, { includeReviews: false })
  return instead === null || instead.conceptId === selection.conceptId ? null : instead
}

/** Open conversations that are not the recommendation, newest first. For "still open". */
export function otherOpenSessions(
  sessions: readonly SessionSummary[],
  recommendation: Recommendation,
  now: number,
): readonly (SessionSummary & { readonly lifecycle: SessionLifecycle })[] {
  // Whatever the recommendation already names, including a dormant conversation it is about to
  // reopen: listing it again under "still open" would offer the same thing twice.
  const chosen =
    recommendation.kind === 'continue'
      ? recommendation.sessionId
      : recommendation.kind === 'study'
        ? recommendation.sessionId
        : null

  return sessions
    .filter((session) => session.id !== chosen)
    .map((session) => ({ ...session, lifecycle: lifecycleOf(session, now) }))
    .filter((session) => session.lifecycle !== 'completed')
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Concepts that are due for revisiting, most overdue first. What the review list shows. */
export function dueForReview(
  lookup: StateLookup,
  conceptIds: readonly ConceptId[],
  now: number,
): readonly { readonly conceptId: ConceptId; readonly overdueMs: number }[] {
  return conceptIds
    .filter((conceptId) => isReviewDue(lookup(conceptId), now))
    .map((conceptId) => ({ conceptId, overdueMs: overdueBy(lookup(conceptId), now) }))
    .sort((a, b) => b.overdueMs - a.overdueMs)
}

/**
 * The sentence Home leads with.
 *
 * Derived from the recommendation that was actually reached, never written alongside it, for
 * the same reason `describeSelection` is: an explanation that does not come from the decision
 * will eventually describe a different one.
 */
export function describeRecommendation(recommendation: Recommendation): string {
  switch (recommendation.kind) {
    case 'continue': {
      const title = getConcept(recommendation.conceptId).title.toLowerCase()

      if (recommendation.because === 'mid-lesson') {
        return `Picking up ${title} where you left off.`
      }
      if (recommendation.because === 'finished') {
        return recommendation.selection === null
          ? `Going back to ${title}, which you finished with earlier.`
          : `${describeSelection(recommendation.selection, { resuming: true })} You finished a conversation about it earlier; it carries on from there.`
      }
      if (recommendation.because === 'returning') {
        /*
         * The scheduler's reason leads, and the conversation is a short second clause.
         *
         * Written the other way round it said the same thing twice — "Going back to the
         * conversation you left open on repeating while something is true. Coming back to
         * repeating while something is true, which was due for review…" — naming the concept
         * twice in two sentences that both mean "again".
         */
        return recommendation.selection === null
          ? `Going back to the conversation you left open on ${title}.`
          : `${describeSelection(recommendation.selection, { resuming: true })} You left a conversation about it open, and it is still there.`
      }
      return recommendation.selection === null
        ? `Carrying on with ${title}.`
        : describeSelection(recommendation.selection, { resuming: true })
    }
    case 'study':
      return describeSelection(recommendation.selection)
    case 'nothing':
      return 'Nothing is due, and everything open to you is settled. Come back when a review falls due.'
  }
}

/**
 * The lines behind "Why this?".
 *
 * A continuation the scheduler did not choose says so, and names what it stood down for, so
 * the learner is never quietly kept from something that is due.
 */
export function groundsForRecommendation(
  recommendation: Recommendation,
  lookup: StateLookup,
): readonly string[] {
  switch (recommendation.kind) {
    case 'continue': {
      if (recommendation.because !== 'mid-lesson') {
        const opening =
          recommendation.because === 'finished'
            ? 'You finished with this conversation earlier, and the tutor has brought it back.'
            : recommendation.because === 'returning'
              ? 'You left this conversation open, and have not been back to it for a while.'
              : 'This conversation is still open.'

        return recommendation.selection === null
          ? [opening]
          : [opening, ...groundsFor(recommendation.selection, lookup, { resuming: true })]
      }

      const waiting = recommendation.selection
      const lines = ['You were in the middle of this a short while ago.']
      if (waiting !== null && waiting.conceptId !== recommendation.conceptId) {
        const next = getConcept(waiting.conceptId).title.toLowerCase()
        lines.push(
          waiting.reason.kind === 'review-due'
            ? `${capitalise(next)} is due for review. It is what comes next, once you are done here.`
            : `${capitalise(next)} is what the tutor would choose next, once you are done here.`,
        )
      }
      return lines
    }
    case 'study':
      return groundsFor(recommendation.selection, lookup)
    case 'nothing':
      return ['Nothing you have worked on is due to be revisited yet.']
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
