import { describe, expect, it } from 'vitest'

import { getConcept } from '../curriculum/graph'
import type { ConceptId } from '../curriculum/types'
import {
  MILLISECONDS_PER_DAY,
  REVIEW_INTERVAL_DAYS,
  REVIEW_MAX_DAYS,
} from '../learner-model/parameters'
import { deriveEvidence } from '../evidence/derive'
import { bandOf, initialConceptState, isReviewDue, type ConceptState } from '../learner-model/state'
import { overdueBy, scheduleNextReview } from './review'

const NOW = Date.parse('2026-09-10T12:00:00.000Z')

/**
 * Fixtures use a concept whose declared difficulty is zero, so the ability estimate and the
 * margin the bands are judged on are the same number and the tests stay readable.
 */
const CONCEPT = 'for-loops-and-range'
const DIFFICULTY = getConcept(CONCEPT).baselineDifficulty

function stateWith(overrides: Partial<ConceptState> = {}): ConceptState {
  return { ...initialConceptState(CONCEPT), ...overrides }
}

/** Interval in days between `now` and the scheduled review. */
function intervalDays(state: ConceptState): number {
  const at = scheduleNextReview(state, NOW)
  if (at === null) throw new Error('expected a scheduled review')
  return (at - NOW) / MILLISECONDS_PER_DAY
}

describe('scheduling a review', () => {
  it('schedules nothing for a concept with no evidence', () => {
    expect(scheduleNextReview(stateWith(), NOW)).toBeNull()
  })

  it('always schedules into the future', () => {
    const state = stateWith({ theta: 0.2, evidenceCount: 2, successes: 2, unaidedSuccesses: 1 })
    expect(scheduleNextReview(state, NOW)!).toBeGreaterThan(NOW)
  })

  it('leaves a longer gap the more established the concept', () => {
    // Held at one unaided success so this compares bands, not interval growth.
    const common = { uncertainty: 0.5, evidenceCount: 3, unaidedSuccesses: 1 }
    const weak = stateWith({ ...common, theta: DIFFICULTY - 1.4, successes: 1 })
    const developing = stateWith({ ...common, theta: DIFFICULTY + 0.2, successes: 2 })
    // Secure needs two unaided successes by definition, so it also picks up one step of
    // interval growth. The ordering assertion holds either way.
    const secure = stateWith({
      theta: DIFFICULTY + 1.5,
      uncertainty: 0.3,
      evidenceCount: 6,
      successes: 5,
      unaidedSuccesses: 2,
    })

    expect(bandOf(weak)).toBe('needs-review')
    expect(bandOf(developing)).toBe('developing')
    expect(bandOf(secure)).toBe('secure')

    expect(intervalDays(weak)).toBeLessThan(intervalDays(developing))
    expect(intervalDays(developing)).toBeLessThan(intervalDays(secure))
  })

  it('expands the gap with each success', () => {
    // Fixed intervals starve new material: a handful of settled concepts generate about one
    // review per session. The gap has to grow as recall becomes established.
    // Growth is keyed on successes of any kind: keying it on unaided ones alone traps a
    // learner who relies on hints, because their count never rises.
    const base = { theta: DIFFICULTY + 1.5, uncertainty: 0.3, evidenceCount: 8, unaidedSuccesses: 2 }
    const intervals = [1, 2, 3, 4].map((successes) =>
      intervalDays(stateWith({ ...base, successes })),
    )

    for (let index = 1; index < intervals.length; index += 1) {
      expect(intervals[index]!, `step ${String(index)}`).toBeGreaterThan(intervals[index - 1]!)
    }
    expect(intervals[3]!).toBeGreaterThan(intervals[0]! * 4)
  })

  it('caps the gap so nothing is parked for ever', () => {
    const state = stateWith({
      theta: DIFFICULTY + 1.5,
      uncertainty: 0,
      evidenceCount: 50,
      successes: 50,
      unaidedSuccesses: 50,
      supportSignal: 0,
    })
    expect(intervalDays(state)).toBeLessThanOrEqual(REVIEW_MAX_DAYS)
  })

  it('never exceeds the band base before any expansion has happened', () => {
    const state = stateWith({
      theta: DIFFICULTY + 1.5,
      uncertainty: 0,
      evidenceCount: 6,
      successes: 1,
      unaidedSuccesses: 2,
      supportSignal: 0,
    })
    expect(intervalDays(state)).toBeLessThanOrEqual(REVIEW_INTERVAL_DAYS.secure)
  })

  it('comes back sooner while the estimate is unsettled', () => {
    const base = { theta: DIFFICULTY + 0.4, evidenceCount: 3, successes: 3, unaidedSuccesses: 2 }
    const unsure = stateWith({ ...base, uncertainty: 1 })
    const settled = stateWith({ ...base, uncertainty: 0.25 })

    expect(intervalDays(unsure)).toBeLessThan(intervalDays(settled))
  })

  it('comes back sooner when the learner has needed support', () => {
    // ADR-0005: a success reached with help has not yet shown independent competence, so it
    // is re-tested sooner rather than treated as settled.
    const base = {
      theta: DIFFICULTY + 0.4,
      evidenceCount: 3,
      uncertainty: 0.5,
      successes: 3,
      unaidedSuccesses: 1,
    }
    const unsupported = stateWith({ ...base, supportSignal: 0 })
    const supported = stateWith({ ...base, supportSignal: 1 })

    expect(intervalDays(supported)).toBeLessThan(intervalDays(unsupported))
  })

  it('never schedules a concept to be due again immediately', () => {
    for (const uncertainty of [0, 0.5, 1]) {
      for (const supportSignal of [0, 0.5, 1]) {
        const state = stateWith({
          theta: DIFFICULTY - 1.5,
          evidenceCount: 1,
          successes: 1,
          uncertainty,
          supportSignal,
        })
        expect(intervalDays(state)).toBeGreaterThan(0)
      }
    }
  })

  it('refuses to schedule from a non-finite clock rather than creating a dead concept', () => {
    // A non-finite `nextReviewAt` compares false against everything, so the concept would
    // silently never come due again.
    const state = stateWith({ theta: 0.4, evidenceCount: 3, successes: 3, unaidedSuccesses: 2 })
    expect(scheduleNextReview(state, Number.NaN)).toBeNull()
  })

  it('is deterministic', () => {
    const state = stateWith({ theta: 0.4, evidenceCount: 3, successes: 3, unaidedSuccesses: 2 })
    expect(scheduleNextReview(state, NOW)).toBe(scheduleNextReview(state, NOW))
  })
})

describe('overdue', () => {
  it('is zero when nothing is scheduled', () => {
    expect(overdueBy(stateWith({ nextReviewAt: null }), NOW)).toBe(0)
  })

  it('is zero before the scheduled time', () => {
    expect(overdueBy(stateWith({ nextReviewAt: NOW + 1_000 }), NOW)).toBe(0)
  })

  it('grows with time past the scheduled point', () => {
    // Evidence as well as a date: a concept nobody has attempted is not overdue (`isReviewDue`).
    const state = stateWith({ nextReviewAt: NOW - 2 * MILLISECONDS_PER_DAY, evidenceCount: 2, successes: 1 })
    expect(overdueBy(state, NOW)).toBe(2 * MILLISECONDS_PER_DAY)
  })

  it('is zero for a concept with a date but no evidence behind it', () => {
    expect(overdueBy(stateWith({ nextReviewAt: NOW - MILLISECONDS_PER_DAY }), NOW)).toBe(0)
  })

  it('treats a concept due at exactly this instant as due', () => {
    // The scheduler and the interface must agree at the boundary: previously the interface
    // showed "due now" while the scheduler skipped it and started new material instead.
    expect(overdueBy(stateWith({ nextReviewAt: NOW }), NOW)).toBe(0)
    expect(scheduleNextReview(stateWith({ nextReviewAt: NOW }), NOW)).toBeNull()
  })
})

/*
 * What a review is for, in scheduling terms: it is completed by an answer, and completing it
 * pushes the concept further out than it was. Both halves matter — without the first, opening a
 * session would silently count as revision; without the second, a settled concept would come
 * back at the same interval for ever.
 */
describe('completing a review', () => {
  const due: ConceptState = {
    ...initialConceptState(CONCEPT),
    theta: DIFFICULTY + 1.2,
    uncertainty: 0.35,
    evidenceCount: 5,
    successes: 4,
    unaidedSuccesses: 3,
    nextReviewAt: NOW - 3 * MILLISECONDS_PER_DAY,
  }

  it('is an answer, not an opening: nothing changes until something is attempted', () => {
    expect(isReviewDue(due, NOW)).toBe(true)
    // No attempt, no derivation: the state is the same object it was.
    expect(due.nextReviewAt).toBe(NOW - 3 * MILLISECONDS_PER_DAY)
  })

  it('schedules the next one further out than the gap that has just elapsed', () => {
    const derived = deriveEvidence(due, {
      attemptId: 'review-1',
      conceptId: CONCEPT,
      itemId: 'p-while-accumulate',
      itemDifficulty: DIFFICULTY,
      correct: true,
      hintDepth: 0,
      misconceptions: [],
      observedAt: NOW,
    })

    const next = derived.nextState.nextReviewAt
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(NOW)
    // Further out than it was last time round, which is what spaced retrieval prescribes.
    expect(next! - NOW).toBeGreaterThan(3 * MILLISECONDS_PER_DAY)
    expect(isReviewDue(derived.nextState, NOW)).toBe(false)
  })

  it('brings a concept answered wrongly back sooner than one answered correctly', () => {
    const attempt = {
      attemptId: 'review-2',
      conceptId: CONCEPT as ConceptId,
      itemId: 'p-while-accumulate',
      itemDifficulty: DIFFICULTY,
      hintDepth: 0,
      misconceptions: [],
      observedAt: NOW,
    }

    const right = deriveEvidence(due, { ...attempt, correct: true }).nextState.nextReviewAt
    const wrong = deriveEvidence(due, { ...attempt, correct: false }).nextState.nextReviewAt

    expect(wrong).not.toBeNull()
    expect(right).not.toBeNull()
    expect(wrong!).toBeLessThan(right!)
  })
})
