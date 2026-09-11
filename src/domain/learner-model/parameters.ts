/**
 * Every tunable number in the learner model, in one place, with its reasoning.
 *
 * These are design choices, not measurements. They were chosen so that the model behaves
 * sensibly over the handful of attempts a real session produces — not fitted to data,
 * because this application has one learner and no population to fit against (ADR-0004).
 * Keeping them together makes the model's behaviour auditable and means a change is a
 * visible, reviewable diff rather than a number buried in an expression.
 */

/**
 * Ability and difficulty share a logit scale. A learner whose ability equals an item's
 * difficulty has an even chance of answering it.
 *
 * Bounds exist so that a run of correct or incorrect answers cannot drive the estimate to
 * a value from which it can never realistically return.
 */
export const THETA_MIN = -3
export const THETA_MAX = 3

/** Where a learner starts before any evidence: even odds on an average item. */
export const INITIAL_THETA = 0

/**
 * Uncertainty runs from 1 (know nothing) down to `UNCERTAINTY_FLOOR`.
 *
 * It scales the step size, so early evidence moves the estimate a long way and later
 * evidence refines it. The floor stops the model becoming so confident that it ignores a
 * genuine change in the learner.
 */
export const INITIAL_UNCERTAINTY = 1
export const UNCERTAINTY_FLOOR = 0.25

/**
 * Step size at maximum and minimum uncertainty.
 *
 * `K_MAX` is large enough that two or three early answers produce a visible estimate;
 * `K_MIN` is small enough that one unlucky slip does not undo a well-established one.
 */
export const K_MAX = 1.1
export const K_MIN = 0.25

/**
 * How much each kind of outcome reduces uncertainty.
 *
 * Multiplicative, so uncertainty decays geometrically and never reaches zero. Unaided
 * outcomes are the most informative; a success that needed help says less about what the
 * learner can do alone, so it settles the estimate less (ADR-0005).
 */
export const UNCERTAINTY_DECAY_UNAIDED = 0.72
export const UNCERTAINTY_DECAY_HINTED = 0.9

/**
 * Weight applied to positive evidence at each hint depth.
 *
 * Index 0 is an unaided correct answer. Deeper hints give progressively weaker positive
 * evidence, but never negative: reaching the right answer with help is still evidence of
 * something, and penalising help teaches learners to stop asking for it (ADR-0005).
 *
 * Depths beyond the table use the final value.
 */
export const POSITIVE_WEIGHT_BY_HINT_DEPTH: readonly number[] = [1, 0.6, 0.4, 0.25]

/**
 * Weight applied to negative evidence.
 *
 * An incorrect answer counts fully whether or not hints were taken. Failing after help is
 * not weaker evidence than failing without it.
 */
export const NEGATIVE_WEIGHT = 1

/**
 * How strongly a single supported success moves the running support signal, and how fast
 * that signal fades when the learner succeeds unaided.
 *
 * The signal is what lets the interface say "reached with support" rather than hiding the
 * distinction inside the ability estimate.
 */
export const SUPPORT_SIGNAL_RISE = 0.5
export const SUPPORT_SIGNAL_DECAY = 0.5

/**
 * Band thresholds, measured **relative to the concept's own difficulty**.
 *
 * The margin is `theta - concept.baselineDifficulty`: how far the learner sits above the
 * level a typical item on that concept is pitched at.
 *
 * An absolute threshold was tried first and was wrong in an instructive way. Because the
 * step size collapses once ability passes item difficulty, a fixed floor of 0.8 meant the
 * *easiest* concepts needed the most evidence to call secure — 15 perfect answers for
 * `program-execution` (difficulty −1.8) against 3 for `methods-and-attributes` (+1.7). The
 * learner would have been drilled hardest on what they found easiest, and "secure" would
 * have meant wildly different amounts of work depending on the concept.
 *
 * A relative margin makes the band mean the same thing everywhere: comfortably above,
 * around, or clearly below the level this concept is taught at.
 */
export const SECURE_MARGIN = 0.8
export const NEEDS_REVIEW_MARGIN = -1

/** A concept cannot be called secure on a hunch, however high the estimate climbs. */
export const SECURE_MAX_UNCERTAINTY = 0.55
export const SECURE_MIN_EVIDENCE = 3

/**
 * Secure additionally requires having done it alone.
 *
 * Without this, a long run of hinted successes reaches `secure` — the estimate climbs and
 * uncertainty falls, so the arithmetic is satisfied even though the learner has never once
 * answered without help. "Secure" has to mean unaided competence or the band overstates
 * what was shown.
 *
 * Counted rather than inferred from the support signal, because a count only ever rises:
 * gating on the support signal would let a hinted success push a concept *out* of secure,
 * which would mean asking for help had cost the learner something (ADR-0005).
 */
export const SECURE_MIN_UNAIDED_SUCCESSES = 2

/** Evidence-strength bands shown alongside mastery. */
export const EVIDENCE_MODERATE_MIN = 3
export const EVIDENCE_STRONG_MIN = 6

/**
 * When a large gap between expectation and outcome is worth recording as a possible
 * problem with the item rather than with the learner.
 *
 * These produce calibration observations for later analysis. They never change the item's
 * difficulty and never feed back into the ability estimate (ADR-0004).
 */
export const SURPRISING_FAILURE_PROBABILITY = 0.85
export const SURPRISING_SUCCESS_PROBABILITY = 0.15

/**
 * Base spacing before a concept is due again, in days, by band.
 *
 * Retrieval practice rather than re-explanation: the tutor brings a concept back as a
 * question. Intervals grow with mastery so that secure material is not re-tested pointlessly
 * (Roediger & Karpicke, 2006).
 */
export const REVIEW_INTERVAL_DAYS = {
  'needs-review': 1,
  developing: 3,
  secure: 10,
} as const

/**
 * How the gap grows each time the learner succeeds unaided on a concept.
 *
 * Fixed intervals do not work. With a fixed ceiling of ten days, a learner who has settled
 * nine concepts generates roughly one review per day, which is an entire session's work —
 * so new material is never reached, however well they are doing. Measured over a simulated
 * 120 sessions, a fixed schedule taught 9 of 33 concepts.
 *
 * Expanding the interval with each unaided success is the standard answer, and it is what
 * spaced retrieval practice actually prescribes: the better established something is, the
 * longer it can be left before recall is worth testing again.
 */
export const REVIEW_INTERVAL_GROWTH = 1.9
export const REVIEW_MAX_DAYS = 120

/**
 * Uncertainty below which another attempt right now tells us little.
 *
 * The scheduler stops treating a concept as "in progress" at this point and lets new
 * material through, bringing it back later as a review instead.
 *
 * Deliberately above `UNCERTAINTY_FLOOR`. Using the floor meant a learner who leans on
 * hints — whose uncertainty falls slowly by design — was held on a single concept for
 * dozens of sessions before anything else was offered.
 */
export const SETTLED_UNCERTAINTY = 0.5

/**
 * How much a supported success pulls the next review forward.
 *
 * At full support the interval is halved: the learner got there, but not alone, so it is
 * worth checking sooner.
 */
export const SUPPORT_INTERVAL_SHORTENING = 0.5

export const MILLISECONDS_PER_DAY = 86_400_000
