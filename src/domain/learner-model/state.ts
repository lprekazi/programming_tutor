import { CONCEPTS_BY_ID } from '../curriculum/concepts'
import type { ConceptId } from '../curriculum/types'
import {
  EVIDENCE_MODERATE_MIN,
  EVIDENCE_STRONG_MIN,
  INITIAL_THETA,
  INITIAL_UNCERTAINTY,
  NEEDS_REVIEW_MARGIN,
  SECURE_MARGIN,
  SECURE_MAX_UNCERTAINTY,
  SECURE_MIN_EVIDENCE,
  SECURE_MIN_UNAIDED_SUCCESSES,
} from './parameters'

/**
 * What the tutor believes about one concept, and how that is presented.
 *
 * The stored state is numeric; what a learner sees is a coarse band plus a separate note
 * of how much evidence sits behind it. Those are deliberately two things: an estimate can
 * be high and barely evidenced, and saying so is more honest than a single number that
 * hides the difference.
 */
export interface ConceptState {
  readonly conceptId: ConceptId
  /** Ability estimate on the logit scale shared with item difficulty. */
  readonly theta: number
  /** 1 = nothing known, falling towards the floor as evidence accumulates. */
  readonly uncertainty: number
  /** How many attempts have contributed to this estimate. */
  readonly evidenceCount: number
  /**
   * Correct answers, with or without help.
   *
   * A concept the learner has attempted but never once got right is not "developing",
   * however the estimate happens to land — so this gates that band, and with it the
   * prerequisite check that the scheduler depends on.
   */
  readonly successes: number
  /**
   * Correct answers given with no hints taken.
   *
   * Tracked separately because this, not the estimate, is what distinguishes "can do it"
   * from "can do it with help". Only ever increases, so it cannot pull a band down.
   */
  readonly unaidedSuccesses: number
  /**
   * 0–1: how much this learner has recently needed help to succeed here.
   *
   * Kept apart from `theta` so that "got there with support" stays visible instead of
   * being absorbed into a single mastery number (ADR-0005).
   */
  readonly supportSignal: number
  /** When this concept was last attempted, epoch milliseconds. */
  readonly lastSeenAt: number | null
  /** When it should next be brought back, epoch milliseconds. */
  readonly nextReviewAt: number | null
}

/**
 * Mastery bands, coarsest to most established.
 *
 * `needs-review` means "attempted and currently weak" — a level of mastery, not a
 * scheduling state. Whether a concept is *due* is a separate question answered by
 * `isReviewDue`, so a learner can be secure in something and still be asked about it.
 */
export type Band = 'not-started' | 'needs-review' | 'developing' | 'secure'

/** Evidence behind a band, shown alongside it rather than folded into it. */
export type EvidenceStrength = 'none' | 'limited' | 'moderate' | 'strong'

const BAND_RANK: Readonly<Record<Band, number>> = {
  'not-started': 0,
  'needs-review': 1,
  developing: 2,
  secure: 3,
}

/** Orders bands so that "did this get better or worse?" is answerable. */
export function bandRank(band: Band): number {
  return BAND_RANK[band]
}

export function initialConceptState(conceptId: ConceptId): ConceptState {
  return {
    conceptId,
    theta: INITIAL_THETA,
    uncertainty: INITIAL_UNCERTAINTY,
    evidenceCount: 0,
    successes: 0,
    unaidedSuccesses: 0,
    supportSignal: 0,
    lastSeenAt: null,
    nextReviewAt: null,
  }
}

/**
 * How far the learner sits above the level this concept's items are pitched at.
 *
 * Bands are judged on this rather than on the raw estimate, so that "secure" means the
 * same thing for the first concept in the curriculum as for the last.
 */
export function masteryMargin(state: ConceptState): number {
  const concept = CONCEPTS_BY_ID.get(state.conceptId)
  const difficulty = concept?.baselineDifficulty ?? 0
  return state.theta - difficulty
}

/**
 * The band a state falls in.
 *
 * `secure` requires all of: a comfortable margin over the concept's own difficulty, low
 * uncertainty, enough attempts, and having answered unaided more than once. Requiring
 * evidence as well as estimate is what stops the interface overstating what the learner
 * has shown — in particular, a long run of hinted successes must not read as independent
 * competence, and a concept never once answered correctly must not read as progress.
 */
export function bandOf(state: ConceptState): Band {
  if (state.evidenceCount === 0) return 'not-started'

  // A corrupt estimate must not read as healthy progress. Reporting the concept as
  // untouched is the safe direction: it will be re-taught rather than assumed known, and
  // it cannot satisfy a prerequisite.
  if (!Number.isFinite(state.theta) || !Number.isFinite(state.uncertainty)) return 'not-started'

  const margin = masteryMargin(state)

  if (
    state.successes > 0 &&
    margin >= SECURE_MARGIN &&
    state.uncertainty <= SECURE_MAX_UNCERTAINTY &&
    state.evidenceCount >= SECURE_MIN_EVIDENCE &&
    state.unaidedSuccesses >= SECURE_MIN_UNAIDED_SUCCESSES
  ) {
    return 'secure'
  }

  // Never having got one right is not "developing", whatever the arithmetic says. Without
  // this, a single wrong answer on a hard item leaves the estimate just above the weak
  // threshold and silently satisfies the prerequisite gate.
  if (state.successes === 0) return 'needs-review'

  if (margin <= NEEDS_REVIEW_MARGIN) return 'needs-review'
  return 'developing'
}

export function evidenceStrengthOf(state: ConceptState): EvidenceStrength {
  if (state.evidenceCount === 0) return 'none'
  if (state.evidenceCount >= EVIDENCE_STRONG_MIN) return 'strong'
  if (state.evidenceCount >= EVIDENCE_MODERATE_MIN) return 'moderate'
  return 'limited'
}

/**
 * Whether this concept is due to be brought back, given the current time.
 *
 * The single definition of dueness: the scheduler uses this too, so the interface and the
 * scheduler can never disagree about whether something is due.
 */
export function isReviewDue(state: ConceptState, now: number): boolean {
  if (state.nextReviewAt === null) return false
  if (!Number.isFinite(state.nextReviewAt) || !Number.isFinite(now)) return false
  return state.nextReviewAt <= now
}

/**
 * Probability that this learner answers an item of the given difficulty correctly.
 *
 * The standard logistic model: ability minus difficulty, squashed to 0–1. Used to decide
 * how surprising an outcome was, which is what drives the size of the update.
 */
export function expectedSuccess(theta: number, itemDifficulty: number): number {
  return 1 / (1 + Math.exp(-(theta - itemDifficulty)))
}
