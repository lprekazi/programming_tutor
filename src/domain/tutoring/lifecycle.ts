import { MILLISECONDS_PER_DAY } from '../learner-model/parameters'

/**
 * Whether a conversation is still going.
 *
 * A session is unique per concept and is reopened rather than replaced, so without a rule
 * every session the learner ever opened stays "open" for the life of the profile, and Home
 * would offer to continue a conversation from six weeks ago as though they had just stepped
 * away from it.
 *
 * The rule is deliberately a **derivation, not a background job**. Nothing sweeps the database
 * marking sessions stale: a session's standing is computed from two timestamps it already has,
 * so the same row reads the same way whether the application has been running all week or was
 * started a moment ago, and no write happens behind the learner's back while they are reading
 * a page (ADR-0032).
 */

/** Untouched for this long, and a conversation is no longer something to "carry on". */
export const DORMANT_AFTER_DAYS = 10

/**
 * How recently a session has to have been touched to count as the one in progress.
 *
 * Long enough to cover a tea break and a distracted hour, short enough that yesterday's
 * session does not outrank a review that came due overnight.
 */
export const MID_LESSON_MS = 2 * 60 * 60 * 1000

export type SessionLifecycle =
  /** Open, and recently enough that continuing it makes sense. */
  | 'active'
  /** Open, but left alone long enough that it is a resumption rather than a continuation. */
  | 'dormant'
  /** The learner said they were done with it. */
  | 'completed'

/** What the lifecycle is decided from. Two timestamps and nothing else. */
export interface SessionTiming {
  /** Last time anything happened in the session. */
  readonly updatedAt: number
  /** Set when the learner finished with the concept for now. */
  readonly closedAt: number | null
}

export function lifecycleOf(session: SessionTiming, now: number): SessionLifecycle {
  if (session.closedAt !== null) return 'completed'
  if (!Number.isFinite(now) || !Number.isFinite(session.updatedAt)) return 'active'

  const idle = now - session.updatedAt
  // A session touched "in the future" is a clock that moved, not a stale conversation.
  return idle > DORMANT_AFTER_DAYS * MILLISECONDS_PER_DAY ? 'dormant' : 'active'
}

/** True while the learner is plausibly still in the middle of this session. */
export function isMidLesson(session: SessionTiming, now: number): boolean {
  if (session.closedAt !== null) return false
  if (!Number.isFinite(now) || !Number.isFinite(session.updatedAt)) return false

  const idle = now - session.updatedAt
  return idle >= 0 && idle <= MID_LESSON_MS
}
