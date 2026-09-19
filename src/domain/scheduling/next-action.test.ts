import { describe, expect, it } from 'vitest'

import { CONCEPTS } from '../curriculum/concepts'
import { getConcept, transitivePrerequisites } from '../curriculum/graph'
import type { ConceptId } from '../curriculum/types'
import { MILLISECONDS_PER_DAY } from '../learner-model/parameters'
import { initialConceptState, type ConceptState } from '../learner-model/state'
import { DORMANT_AFTER_DAYS, MID_LESSON_MS } from '../tutoring/lifecycle'
import {
  activityKindOf,
  describeRecommendation,
  dueForReview,
  groundsForRecommendation,
  otherOpenSessions,
  recommendNext,
  type SessionSummary,
} from './next-action'
import { stateLookupFrom } from './select'

/**
 * One recommendation, from the scheduler and the learner's open conversations together.
 *
 * The rule under test throughout is the priority order: a session in progress, then whatever
 * the scheduler chose, then nothing — and that what the learner is told corresponds to which
 * of those actually happened.
 */

const NOW = Date.parse('2026-09-19T12:00:00.000Z')
const DAY = MILLISECONDS_PER_DAY

function secure(conceptId: ConceptId, overrides: Partial<ConceptState> = {}): ConceptState {
  return {
    ...initialConceptState(conceptId),
    theta: getConcept(conceptId).baselineDifficulty + 1.2,
    uncertainty: 0.3,
    evidenceCount: 6,
    successes: 5,
    unaidedSuccesses: 4,
    nextReviewAt: NOW + 10 * DAY,
    ...overrides,
  }
}

function unlock(conceptId: ConceptId): ConceptState[] {
  return [...transitivePrerequisites(conceptId)].map((id) => secure(id))
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    conceptId: 'program-execution',
    updatedAt: NOW - 10 * 60 * 1000,
    closedAt: null,
    ...overrides,
  }
}

describe('what to do next', () => {
  it('has nothing to say when nothing is open and nothing is reachable', () => {
    // Every concept secure and none due: the scheduler is out of work.
    const states = CONCEPTS.map((concept) => secure(concept.id))
    const recommendation = recommendNext({ lookup: stateLookupFrom(states), sessions: [], now: NOW })

    expect(recommendation.kind).toBe('nothing')
    expect(activityKindOf(recommendation)).toBeNull()
  })

  it('starts the concept the scheduler chose when nothing is open', () => {
    const recommendation = recommendNext({ lookup: stateLookupFrom([]), sessions: [], now: NOW })

    expect(recommendation.kind).toBe('study')
    expect(recommendation.kind === 'study' && recommendation.sessionId).toBeNull()
    expect(activityKindOf(recommendation)).toBe('learn')
  })

  /*
   * Found by looking at the page. A concept answered in the diagnostic, with no conversation
   * about it yet, was labelled "New / Start learning" above the scheduler's own sentence,
   * "Continuing with … You have made a start". The label and the sentence have to come from
   * the same decision, which is the whole reason this module exists.
   */
  it('does not call a concept new when the learner has already attempted it', () => {
    const attempted: ConceptState = {
      ...initialConceptState('program-execution'),
      theta: getConcept('program-execution').baselineDifficulty + 0.3,
      uncertainty: 0.7,
      evidenceCount: 2,
      successes: 2,
      unaidedSuccesses: 1,
      nextReviewAt: NOW + 5 * DAY,
    }

    const recommendation = recommendNext({ lookup: stateLookupFrom([attempted]), sessions: [], now: NOW })

    expect(recommendation).toMatchObject({ kind: 'study', conceptId: 'program-execution' })
    expect(recommendation.kind === 'study' && recommendation.selection.reason.kind).toBe('in-progress')
    expect(activityKindOf(recommendation)).toBe('practise')
    expect(describeRecommendation(recommendation)).toContain('Continuing with')
  })

  it('continues a session the learner is in the middle of, even though something else is due', () => {
    // Due for review on a different concept. The learner stepped away ten minutes ago.
    const due = secure('output-with-print', { nextReviewAt: NOW - 3 * DAY })
    const lookup = stateLookupFrom([...unlock('output-with-print'), due])

    const recommendation = recommendNext({
      lookup,
      sessions: [session({ conceptId: 'program-execution', updatedAt: NOW - 10 * 60 * 1000 })],
      now: NOW,
    })

    expect(recommendation).toMatchObject({ kind: 'continue', sessionId: 'session-1', because: 'mid-lesson' })
    // The review it stood down for is still the scheduler's choice, and is carried with it.
    expect(recommendation.kind === 'continue' && recommendation.selection?.conceptId).toBe('output-with-print')
    expect(activityKindOf(recommendation)).toBe('continue')
  })

  it('puts the due review first once the learner is no longer mid-lesson', () => {
    const due = secure('output-with-print', { nextReviewAt: NOW - 3 * DAY })
    const lookup = stateLookupFrom([...unlock('output-with-print'), due])

    const recommendation = recommendNext({
      lookup,
      sessions: [session({ conceptId: 'program-execution', updatedAt: NOW - MID_LESSON_MS - 1000 })],
      now: NOW,
    })

    expect(recommendation).toMatchObject({ kind: 'study', conceptId: 'output-with-print' })
    expect(activityKindOf(recommendation)).toBe('review')
  })

  it('continues rather than starts when the chosen concept already has a conversation', () => {
    const due = secure('output-with-print', { nextReviewAt: NOW - 3 * DAY })
    const lookup = stateLookupFrom([...unlock('output-with-print'), due])

    const recommendation = recommendNext({
      lookup,
      sessions: [session({ id: 's-print', conceptId: 'output-with-print', updatedAt: NOW - 2 * DAY })],
      now: NOW,
    })

    expect(recommendation).toMatchObject({ kind: 'continue', sessionId: 's-print', because: 'scheduled' })
    // It is a review that happens to have a conversation already, and says so.
    expect(activityKindOf(recommendation)).toBe('review')
  })

  it('offers a conversation from weeks ago as one to go back to, not as something new', () => {
    const stale = session({ conceptId: 'program-execution', updatedAt: NOW - (DORMANT_AFTER_DAYS + 5) * DAY })
    const recommendation = recommendNext({ lookup: stateLookupFrom([]), sessions: [stale], now: NOW })

    /*
     * Pressing the button opens a conversation with history in it, so it cannot say "Start
     * learning" — but it is not a continuation either, and the words say which (M7 review
     * finding M2).
     */
    expect(recommendation).toMatchObject({ kind: 'continue', sessionId: 'session-1', because: 'returning' })
    // Its own word: "still going" would be untrue of a conversation nobody has touched in weeks.
    expect(activityKindOf(recommendation)).toBe('resume')
    // The scheduler's reason leads; the conversation is one clause, and the concept is named once.
    const sentence = describeRecommendation(recommendation)
    expect(sentence).toContain('left a conversation about it open')
    expect(sentence.match(/how a program runs/gi) ?? []).toHaveLength(1)
    expect(groundsForRecommendation(recommendation, stateLookupFrom([]))[0]).toContain('not been back')
    // Named by the recommendation itself, so it is not also listed as something else waiting.
    expect(otherOpenSessions([stale], recommendation, NOW)).toEqual([])
  })

  it('says a mid-lesson continuation in its own words, even when the scheduler agrees', () => {
    // The concept they are part-way through is also what the scheduler would pick. "Continue"
    // over the sentence "Starting how a program runs" is the mismatch this prevents.
    const recommendation = recommendNext({
      lookup: stateLookupFrom([]),
      sessions: [session({ conceptId: 'program-execution', updatedAt: NOW - 5 * 60 * 1000 })],
      now: NOW,
    })

    expect(recommendation).toMatchObject({ kind: 'continue', because: 'mid-lesson' })
    expect(describeRecommendation(recommendation)).toContain('where you left off')
    expect(describeRecommendation(recommendation)).not.toContain('Starting')
  })

  /*
   * M7 fresh review finding H-3. A conversation the learner had finished was invisible here, so
   * the concept was offered as "study" — "New / Start learning", `sessionId: null` — and pressing
   * it silently reopened the finished conversation with all its history.
   */
  it('offers a finished conversation the scheduler brings back as going back to it', () => {
    const finished = session({ closedAt: NOW - 4 * DAY, updatedAt: NOW - 4 * DAY })
    const recommendation = recommendNext({ lookup: stateLookupFrom([]), sessions: [finished], now: NOW })

    expect(recommendation).toMatchObject({ kind: 'continue', sessionId: 'session-1', because: 'finished' })
    expect(activityKindOf(recommendation)).toBe('reopen')
    // Not "Starting …": there is a conversation, and the sentence says so once.
    const sentence = describeRecommendation(recommendation)
    expect(sentence).not.toContain('Starting')
    expect(sentence).toContain('finished a conversation about it earlier')
    // Never listed as still open: the learner closed it.
    expect(otherOpenSessions([finished], recommendation, NOW)).toEqual([])
  })

  it('is never mid-lesson in a conversation the learner has just finished', () => {
    const finished = session({ closedAt: NOW - 1000, updatedAt: NOW - 1000 })
    const recommendation = recommendNext({ lookup: stateLookupFrom([]), sessions: [finished], now: NOW })

    expect(recommendation.kind === 'continue' && recommendation.because).not.toBe('mid-lesson')
  })

  it('picks the most recent when two conversations are open', () => {
    const older = session({ id: 'older', conceptId: 'program-execution', updatedAt: NOW - 30 * 60 * 1000 })
    const newer = session({ id: 'newer', conceptId: 'output-with-print', updatedAt: NOW - 60 * 1000 })

    const recommendation = recommendNext({
      lookup: stateLookupFrom(unlock('output-with-print')),
      sessions: [older, newer],
      now: NOW,
    })

    expect(recommendation).toMatchObject({ kind: 'continue', sessionId: 'newer' })
    expect(otherOpenSessions([older, newer], recommendation, NOW).map((each) => each.id)).toEqual(['older'])
  })
})

/*
 * M7 fresh review finding M-4. A review is cleared only by an answer, and one cannot always be
 * asked. With reviews always first and nothing startable that the scheduler had not chosen, an
 * unanswerable review blocked every other concept for ever.
 */
describe('a review that cannot be answered', () => {
  it('comes with a second choice, the scheduler’s own with reviews set aside', () => {
    const due = secure('output-with-print', { nextReviewAt: NOW - 3 * DAY })
    const lookup = stateLookupFrom([...unlock('output-with-print'), due])

    const recommendation = recommendNext({ lookup, sessions: [], now: NOW })

    expect(activityKindOf(recommendation)).toBe('review')
    const alternative = recommendation.kind === 'nothing' ? null : recommendation.alternative
    expect(alternative).not.toBeNull()
    expect(alternative?.conceptId).not.toBe('output-with-print')
    expect(alternative?.reason.kind).not.toBe('review-due')
  })

  it('offers something else even when the due concept is also the least settled one', () => {
    // The only concept underway is the one that is due; with it set aside, something new remains.
    const due: ConceptState = {
      ...initialConceptState('program-execution'),
      theta: getConcept('program-execution').baselineDifficulty + 0.3,
      uncertainty: 0.7,
      evidenceCount: 2,
      successes: 2,
      unaidedSuccesses: 1,
      nextReviewAt: NOW - DAY,
    }

    const recommendation = recommendNext({ lookup: stateLookupFrom([due]), sessions: [], now: NOW })

    expect(activityKindOf(recommendation)).toBe('review')
    const alternative = recommendation.kind === 'nothing' ? null : recommendation.alternative
    expect(alternative).not.toBeNull()
    expect(alternative?.conceptId).not.toBe('program-execution')
  })

  it('offers no second choice when the recommendation is not a review', () => {
    const recommendation = recommendNext({ lookup: stateLookupFrom([]), sessions: [], now: NOW })

    expect(recommendation.kind === 'study' && recommendation.alternative).toBeNull()
  })
})

describe('what is due', () => {
  it('lists due concepts, most overdue first, and nothing that is not due', () => {
    const states = [
      secure('program-execution', { nextReviewAt: NOW - DAY }),
      secure('output-with-print', { nextReviewAt: NOW - 5 * DAY }),
      secure('errors-and-tracebacks', { nextReviewAt: NOW + DAY }),
    ]
    const ids: ConceptId[] = ['program-execution', 'output-with-print', 'errors-and-tracebacks']

    expect(dueForReview(stateLookupFrom(states), ids, NOW).map((each) => each.conceptId)).toEqual([
      'output-with-print',
      'program-execution',
    ])
  })

  it('counts a concept with no evidence as not due, whatever its stored date', () => {
    const untouched = { ...initialConceptState('program-execution'), nextReviewAt: NOW - DAY }
    expect(dueForReview(stateLookupFrom([untouched]), ['program-execution'], NOW)).toEqual([])
  })
})
