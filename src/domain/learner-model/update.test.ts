import { describe, expect, it } from 'vitest'

import {
  K_MAX,
  K_MIN,
  POSITIVE_WEIGHT_BY_HINT_DEPTH,
  THETA_MAX,
  THETA_MIN,
  UNCERTAINTY_FLOOR,
} from './parameters'
import { bandOf, bandRank, initialConceptState, type ConceptState } from './state'
import { applyOutcome, positiveWeight, stepSize, type Outcome } from './update'

/**
 * The named invariants of the learner model.
 *
 * These are the promises made in ADR-0004 (item difficulty is a prior, never estimated)
 * and ADR-0005 (a hinted success is weaker positive evidence, never a penalty). They are
 * asserted directly rather than inferred from coverage: what matters is that the stated
 * behaviour holds, not how many lines were executed while checking.
 */

function stateWith(overrides: Partial<ConceptState> = {}): ConceptState {
  return { ...initialConceptState('for-loops-and-range'), ...overrides }
}

function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return { correct: true, hintDepth: 0, itemDifficulty: 0, ...overrides }
}

/** Applies a sequence of outcomes, returning the final state. */
function runAll(state: ConceptState, outcomes: readonly Outcome[]): ConceptState {
  return outcomes.reduce((current, next) => applyOutcome(current, next).nextState, state)
}

describe('step size', () => {
  it('shrinks as the model becomes more certain', () => {
    expect(stepSize(1)).toBeCloseTo(K_MAX)
    expect(stepSize(0)).toBeCloseTo(K_MIN)
    expect(stepSize(0.5)).toBeGreaterThan(stepSize(0.2))
  })

  it('is bounded even for out-of-range uncertainty', () => {
    expect(stepSize(5)).toBeCloseTo(K_MAX)
    expect(stepSize(-5)).toBeCloseTo(K_MIN)
  })
})

describe('positive weight by hint depth', () => {
  it('is strictly decreasing in hint depth', () => {
    const weights = POSITIVE_WEIGHT_BY_HINT_DEPTH.map((_, depth) => positiveWeight(depth))
    for (let depth = 1; depth < weights.length; depth += 1) {
      expect(weights[depth]!, `depth ${String(depth)}`).toBeLessThan(weights[depth - 1]!)
    }
  })

  it('is always positive, so help is never a penalty', () => {
    for (let depth = 0; depth <= 20; depth += 1) {
      expect(positiveWeight(depth)).toBeGreaterThan(0)
    }
  })

  it('is full weight when unaided', () => {
    expect(positiveWeight(0)).toBe(1)
  })

  it('holds at the deepest tabulated value beyond the table', () => {
    const last = positiveWeight(POSITIVE_WEIGHT_BY_HINT_DEPTH.length - 1)
    expect(positiveWeight(99)).toBe(last)
  })
})

describe('invariant: a correct answer never lowers the estimate', () => {
  it('holds when unaided', () => {
    for (const difficulty of [-3, -2, -1, 0, 1, 2, 3]) {
      for (const theta of [-2, -1, 0, 1, 2]) {
        const result = applyOutcome(stateWith({ theta }), outcome({ itemDifficulty: difficulty }))
        expect(result.delta, `theta ${String(theta)}, b ${String(difficulty)}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('holds at every hint depth, including on an item the learner was expected to pass', () => {
    // This is the case that would otherwise go negative: an attenuated weight against a
    // high expectation produces a negative raw step, which the clamp removes.
    for (let hintDepth = 0; hintDepth <= 6; hintDepth += 1) {
      for (const theta of [-2, 0, 2]) {
        const result = applyOutcome(
          stateWith({ theta }),
          outcome({ hintDepth, itemDifficulty: -2 }),
        )
        expect(result.delta, `hintDepth ${String(hintDepth)}, theta ${String(theta)}`).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('invariant: unaided success dominates hinted success', () => {
  it('moves the estimate at least as far, at equal difficulty', () => {
    for (const difficulty of [-1, 0, 1]) {
      const unaided = applyOutcome(stateWith(), outcome({ hintDepth: 0, itemDifficulty: difficulty }))
      for (let hintDepth = 1; hintDepth <= 4; hintDepth += 1) {
        const hinted = applyOutcome(stateWith(), outcome({ hintDepth, itemDifficulty: difficulty }))
        expect(hinted.delta).toBeLessThanOrEqual(unaided.delta)
      }
    }
  })

  it('settles the estimate less, leaving more uncertainty', () => {
    const unaided = applyOutcome(stateWith(), outcome({ hintDepth: 0 }))
    const hinted = applyOutcome(stateWith(), outcome({ hintDepth: 2 }))

    expect(hinted.nextState.uncertainty).toBeGreaterThan(unaided.nextState.uncertainty)
  })
})

describe('invariant: an incorrect answer counts fully whether or not hints were taken', () => {
  it('applies the same weight at every hint depth', () => {
    const withoutHints = applyOutcome(stateWith(), outcome({ correct: false, hintDepth: 0 }))
    const withHints = applyOutcome(stateWith(), outcome({ correct: false, hintDepth: 3 }))

    expect(withHints.weight).toBe(withoutHints.weight)
    expect(withHints.delta).toBeCloseTo(withoutHints.delta)
  })

  it('lowers the estimate', () => {
    const result = applyOutcome(stateWith({ theta: 1 }), outcome({ correct: false }))
    expect(result.delta).toBeLessThan(0)
  })
})

describe('invariant: the estimate stays within bounds', () => {
  it('cannot be driven above the maximum by a run of successes', () => {
    const state = runAll(stateWith(), Array.from({ length: 200 }, () => outcome()))
    expect(state.theta).toBeLessThanOrEqual(THETA_MAX)
  })

  it('cannot be driven below the minimum by a run of failures', () => {
    const state = runAll(
      stateWith(),
      Array.from({ length: 200 }, () => outcome({ correct: false })),
    )
    expect(state.theta).toBeGreaterThanOrEqual(THETA_MIN)
  })
})

describe('invariant: uncertainty never rises, and never reaches zero', () => {
  it('is non-increasing across any sequence of outcomes', () => {
    const sequence: Outcome[] = [
      outcome(),
      outcome({ correct: false }),
      outcome({ hintDepth: 2 }),
      outcome({ correct: false, hintDepth: 1 }),
      outcome(),
    ]

    let state = stateWith()
    for (const next of sequence) {
      const after = applyOutcome(state, next).nextState
      expect(after.uncertainty).toBeLessThanOrEqual(state.uncertainty)
      state = after
    }
  })

  it('settles at the floor rather than collapsing to zero', () => {
    const state = runAll(stateWith(), Array.from({ length: 100 }, () => outcome()))
    expect(state.uncertainty).toBe(UNCERTAINTY_FLOOR)
  })
})

describe('invariant: item difficulty is never modified', () => {
  it('leaves the outcome it was given untouched', () => {
    // The model has no channel through which to write an item difficulty: `applyOutcome`
    // returns only learner state. This asserts the shape of that guarantee.
    const given = outcome({ itemDifficulty: 1.25 })
    const result = applyOutcome(stateWith(), given)

    expect(given.itemDifficulty).toBe(1.25)
    expect(Object.keys(result.nextState)).not.toContain('itemDifficulty')
  })
})

describe('invariant: a correct answer never lowers the band', () => {
  it('holds across a long mixed history', () => {
    const difficulties = [-1, 0, 0.5, 1]
    let state = stateWith()

    for (let index = 0; index < 60; index += 1) {
      const next = outcome({
        correct: index % 3 !== 0,
        hintDepth: index % 4,
        itemDifficulty: difficulties[index % difficulties.length]!,
      })
      const before = bandOf(state)
      const after = applyOutcome(state, next).nextState

      if (next.correct) {
        expect(bandRank(bandOf(after)), `step ${String(index)}`).toBeGreaterThanOrEqual(
          bandRank(before),
        )
      }
      state = after
    }
  })
})

describe('support signal', () => {
  it('rises when success needed help', () => {
    const result = applyOutcome(stateWith(), outcome({ hintDepth: 1 }))
    expect(result.nextState.supportSignal).toBeGreaterThan(0)
  })

  it('fades when the learner succeeds unaided', () => {
    const supported = applyOutcome(stateWith(), outcome({ hintDepth: 2 })).nextState
    const afterUnaided = applyOutcome(supported, outcome({ hintDepth: 0 })).nextState

    expect(afterUnaided.supportSignal).toBeLessThan(supported.supportSignal)
  })

  it('is unchanged by an incorrect answer, which says nothing about support', () => {
    const supported = applyOutcome(stateWith(), outcome({ hintDepth: 1 })).nextState
    const afterFailure = applyOutcome(supported, outcome({ correct: false })).nextState

    expect(afterFailure.supportSignal).toBe(supported.supportSignal)
  })

  it('stays within 0 and 1 however much help is taken', () => {
    const state = runAll(stateWith(), Array.from({ length: 50 }, () => outcome({ hintDepth: 3 })))
    expect(state.supportSignal).toBeGreaterThanOrEqual(0)
    expect(state.supportSignal).toBeLessThanOrEqual(1)
  })
})

describe('bookkeeping', () => {
  it('counts every attempt exactly once', () => {
    const state = runAll(stateWith(), [
      outcome(),
      outcome({ correct: false }),
      outcome({ hintDepth: 1 }),
    ])
    expect(state.evidenceCount).toBe(3)
  })

  it('does not mutate the state it was given', () => {
    const before = stateWith()
    const snapshot = { ...before }
    applyOutcome(before, outcome())

    expect(before).toEqual(snapshot)
  })

  it('reports the expectation it used', () => {
    const result = applyOutcome(stateWith({ theta: 0 }), outcome({ itemDifficulty: 0 }))
    expect(result.expected).toBeCloseTo(0.5)
  })

  it('is deterministic', () => {
    const first = applyOutcome(stateWith(), outcome({ hintDepth: 2, itemDifficulty: 0.3 }))
    const second = applyOutcome(stateWith(), outcome({ hintDepth: 2, itemDifficulty: 0.3 }))
    expect(first).toEqual(second)
  })
})

describe('behaviour over a plausible session', () => {
  it('reaches secure after a run of unaided successes on appropriate items', () => {
    const state = runAll(
      stateWith(),
      Array.from({ length: 6 }, () => outcome({ itemDifficulty: 0.2 })),
    )
    expect(bandOf(state)).toBe('secure')
  })

  it('does not reach secure on hinted successes alone', () => {
    // Getting there with help every time is not the same as being able to do it.
    const state = runAll(
      stateWith(),
      Array.from({ length: 8 }, () => outcome({ hintDepth: 2, itemDifficulty: 0.2 })),
    )
    // Asserted exactly, not merely 'not secure': the weaker form would also pass if the
    // state had collapsed to not-started, which would be a different bug entirely.
    expect(bandOf(state)).toBe('developing')
    expect(state.unaidedSuccesses).toBe(0)
  })

  it('falls to needs-review after repeated unaided failure', () => {
    const state = runAll(
      stateWith(),
      Array.from({ length: 4 }, () => outcome({ correct: false, itemDifficulty: 0 })),
    )
    expect(bandOf(state)).toBe('needs-review')
  })
})
