import {
  K_MAX,
  K_MIN,
  NEGATIVE_WEIGHT,
  POSITIVE_WEIGHT_BY_HINT_DEPTH,
  SUPPORT_SIGNAL_DECAY,
  SUPPORT_SIGNAL_RISE,
  THETA_MAX,
  THETA_MIN,
  UNCERTAINTY_DECAY_HINTED,
  UNCERTAINTY_DECAY_UNAIDED,
  UNCERTAINTY_FLOOR,
} from './parameters'
import { expectedSuccess, type ConceptState } from './state'

/**
 * The learner-model arithmetic.
 *
 * An Elo-style online update: compare what the learner did against what the model
 * expected, and move the estimate by the surprise. Only ability is estimated — item
 * difficulty is a declared prior and is never revised, because with a single learner the
 * two are not separable (ADR-0004).
 *
 * Everything here is pure. No clocks, no storage, no model calls. Given the same state and
 * the same outcome it always produces the same result, which is what makes the behaviour
 * in `parameters.ts` testable as stated rather than as hoped.
 */

/** What a learner did on one item. */
export interface Outcome {
  readonly correct: boolean
  /** 0 when unaided; 1 upwards for each hint taken before answering. */
  readonly hintDepth: number
  /** Declared difficulty of the item, on the ability scale. */
  readonly itemDifficulty: number
}

export interface Update {
  readonly nextState: ConceptState
  /** Change applied to the ability estimate. */
  readonly delta: number
  /** Probability the model gave this learner of succeeding, before seeing the outcome. */
  readonly expected: number
  /** Weight the outcome carried, after hint attenuation. */
  readonly weight: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Step size for the current uncertainty.
 *
 * Large while the model knows little, shrinking as evidence accumulates, so that a
 * well-established estimate is not thrown by one answer.
 */
export function stepSize(uncertainty: number): number {
  return K_MIN + (K_MAX - K_MIN) * clamp(uncertainty, 0, 1)
}

/**
 * Weight for a correct answer at the given hint depth.
 *
 * Strictly decreasing in depth and always positive: help makes a success less informative,
 * never worthless, and never a penalty (ADR-0005).
 */
export function positiveWeight(hintDepth: number): number {
  const table = POSITIVE_WEIGHT_BY_HINT_DEPTH
  const index = clamp(Math.trunc(hintDepth), 0, table.length - 1)
  const weight = table[index]
  // The table is a non-empty constant, so this is unreachable; it exists so the function
  // has no implicit undefined path under noUncheckedIndexedAccess.
  return weight ?? table[table.length - 1] ?? 1
}

/**
 * Applies one outcome to one concept's state.
 *
 * The rules, all of which are asserted as named invariants in the tests:
 *
 * - A correct answer never lowers the estimate, even when heavily hinted. The step is
 *   clamped at zero rather than being allowed to go negative, which can otherwise happen
 *   when an attenuated weight meets a high expectation.
 * - An incorrect answer counts at full weight regardless of hints taken.
 * - Uncertainty only ever falls, and falls less for a supported success.
 * - Support is tracked separately from ability, rising on hinted success and fading on
 *   unaided success.
 * - Unaided successes are counted, because that is what `secure` requires.
 */
export function applyOutcome(state: ConceptState, outcome: Outcome): Update {
  // This function is part of the domain's public surface, so it cannot assume its caller
  // has already validated anything. Inputs are normalised once, here, and every later line
  // uses the normalised values.
  //
  // Without this, three things go wrong: a non-finite estimate propagates silently and
  // reads to the interface as a healthy concept; an out-of-range stored estimate makes a
  // *correct* answer produce a negative delta, because the result was clamped but the
  // input never was; and a fractional hint depth is scored as unaided for the weight while
  // being treated as hinted for the uncertainty decay.
  const priorTheta = clamp(finiteOr(state.theta, 0), THETA_MIN, THETA_MAX)
  const priorUncertainty = clamp(finiteOr(state.uncertainty, 1), UNCERTAINTY_FLOOR, 1)
  const itemDifficulty = finiteOr(outcome.itemDifficulty, 0)
  const hintDepth = Number.isFinite(outcome.hintDepth) ? Math.max(0, Math.trunc(outcome.hintDepth)) : 0

  const expected = expectedSuccess(priorTheta, itemDifficulty)
  const hinted = hintDepth > 0

  const target = outcome.correct ? 1 : 0
  const weight = outcome.correct ? positiveWeight(hintDepth) : NEGATIVE_WEIGHT

  const rawDelta = stepSize(priorUncertainty) * weight * (target - expected)
  // A correct answer is positive evidence by definition. Without this clamp, a heavily
  // hinted success on an item the learner was already expected to pass would reduce the
  // estimate — which would mean asking for help had cost them.
  const delta = outcome.correct ? Math.max(0, rawDelta) : rawDelta

  const theta = clamp(priorTheta + delta, THETA_MIN, THETA_MAX)

  const decay = hinted && outcome.correct ? UNCERTAINTY_DECAY_HINTED : UNCERTAINTY_DECAY_UNAIDED
  const uncertainty = Math.max(UNCERTAINTY_FLOOR, priorUncertainty * decay)

  const supportSignal = nextSupportSignal(
    clamp(finiteOr(state.supportSignal, 0), 0, 1),
    outcome.correct,
    hintDepth,
  )

  return {
    nextState: {
      ...state,
      theta,
      uncertainty,
      evidenceCount: state.evidenceCount + 1,
      successes: state.successes + (outcome.correct ? 1 : 0),
      unaidedSuccesses: state.unaidedSuccesses + (outcome.correct && hintDepth === 0 ? 1 : 0),
      supportSignal,
    },
    // Reported against the normalised prior, so a correct answer can never be shown to the
    // learner as having reduced their estimate.
    delta: theta - priorTheta,
    expected,
    weight,
  }
}

/** Falls back to `fallback` for NaN and Infinity, which no arithmetic here can recover from. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Tracks how much help this learner has recently needed on a concept.
 *
 * Rises towards 1 on a hinted success and fades towards 0 on an unaided one. An incorrect
 * answer leaves it alone: failing says nothing about whether support would have helped.
 */
function nextSupportSignal(current: number, correct: boolean, hintDepth: number): number {
  if (!correct) return current
  if (hintDepth > 0) {
    return clamp(current + (1 - current) * SUPPORT_SIGNAL_RISE, 0, 1)
  }
  return clamp(current * (1 - SUPPORT_SIGNAL_DECAY), 0, 1)
}
