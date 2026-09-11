import {
  MILLISECONDS_PER_DAY,
  REVIEW_INTERVAL_DAYS,
  REVIEW_INTERVAL_GROWTH,
  REVIEW_MAX_DAYS,
  SUPPORT_INTERVAL_SHORTENING,
} from '../learner-model/parameters'
import { bandOf, isReviewDue, type ConceptState } from '../learner-model/state'

/**
 * When a concept should be brought back.
 *
 * The tutor revisits by asking, not by re-explaining: testing produces better long-term
 * retention than restudying, even though restudying feels more productive at the time
 * (Roediger & Karpicke, 2006).
 *
 * The gap **expands** with each unaided success. That is what spaced retrieval prescribes,
 * and it is also a practical necessity: with a fixed ceiling, a learner who has settled a
 * handful of concepts generates about one review per session, and never reaches anything
 * new however well they are doing.
 *
 * Two things pull the gap back in. Uncertainty, because a shaky estimate is worth
 * resolving sooner. And support, because an answer the learner needed help to reach has
 * not yet shown they can do it alone (ADR-0005).
 */

/**
 * Returns the epoch time at which `state` should next be revisited, or `null` if it has no
 * evidence yet and so nothing to review.
 */
export function scheduleNextReview(state: ConceptState, now: number): number | null {
  const band = bandOf(state)
  if (band === 'not-started') return null
  if (!Number.isFinite(now)) return null

  // Each success roughly doubles the gap, capped so nothing is parked for ever.
  //
  // Keyed on successes of any kind, not unaided ones. Keying it on unaided successes traps
  // a learner who relies on hints: their count never rises, so their intervals never expand
  // and reviews crowd out everything else. The support factor below is what keeps a
  // supported success coming back sooner than an independent one (ADR-0005) — that
  // distinction belongs there, not in the growth term.
  const growth = Math.pow(REVIEW_INTERVAL_GROWTH, Math.max(0, state.successes - 1))
  const baseDays = Math.min(REVIEW_INTERVAL_DAYS[band] * growth, REVIEW_MAX_DAYS)

  const certaintyFactor = 1 - 0.5 * clamp01(state.uncertainty)
  const supportFactor = 1 - SUPPORT_INTERVAL_SHORTENING * clamp01(state.supportSignal)

  const days = baseDays * certaintyFactor * supportFactor

  // Never same-instant: a concept just answered should not immediately be due again.
  const atLeastAnHour = Math.max(days * MILLISECONDS_PER_DAY, MILLISECONDS_PER_DAY / 24)
  return now + Math.round(atLeastAnHour)
}

/**
 * How overdue a concept is, in milliseconds. Zero when it is not due.
 *
 * Ordering only. Whether a concept *is* due is decided by `isReviewDue`, so that a concept
 * due at exactly this instant cannot be shown as due by the interface while being skipped
 * by the scheduler.
 */
export function overdueBy(state: ConceptState, now: number): number {
  if (!isReviewDue(state, now)) return 0
  return Math.max(0, now - (state.nextReviewAt ?? now))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
