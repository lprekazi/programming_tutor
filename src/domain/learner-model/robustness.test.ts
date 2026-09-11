import { describe, expect, it } from 'vitest'

import { CONCEPTS } from '../curriculum/concepts'
import { MISCONCEPTIONS } from '../curriculum/misconceptions'
import { UNCERTAINTY_FLOOR } from './parameters'
import { bandOf, initialConceptState, type ConceptState } from './state'
import { applyOutcome, type Outcome } from './update'

/**
 * Regression tests for defects found by independent review.
 *
 * `applyOutcome` is part of the domain's public surface, so it cannot assume a caller has
 * already validated anything — these cover the inputs that a stored, deserialised or simply
 * mistaken caller can produce, all of which previously corrupted learner state silently.
 */

function stateWith(overrides: Partial<ConceptState> = {}): ConceptState {
  return { ...initialConceptState('for-loops-and-range'), ...overrides }
}

function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return { correct: true, hintDepth: 0, itemDifficulty: 0, ...overrides }
}

describe('non-finite inputs cannot corrupt learner state', () => {
  it('recovers from a non-finite stored estimate instead of propagating it', () => {
    // Previously: theta stayed NaN, and because every comparison against NaN is false,
    // `bandOf` fell through to 'developing' — a corrupt concept read as healthy progress
    // and silently satisfied prerequisites.
    const result = applyOutcome(stateWith({ theta: Number.NaN }), outcome())

    expect(Number.isFinite(result.nextState.theta)).toBe(true)
    expect(Number.isFinite(result.delta)).toBe(true)
  })

  it('never reports a non-finite estimate as a healthy band', () => {
    const corrupt = stateWith({ theta: Number.NaN, evidenceCount: 4, successes: 3 })
    expect(bandOf(corrupt)).toBe('not-started')
  })

  it('recovers from a non-finite stored uncertainty', () => {
    const result = applyOutcome(stateWith({ uncertainty: Number.NaN }), outcome())
    expect(Number.isFinite(result.nextState.uncertainty)).toBe(true)
  })

  it('recovers from a non-finite item difficulty', () => {
    const result = applyOutcome(stateWith(), outcome({ itemDifficulty: Number.NaN }))
    expect(Number.isFinite(result.nextState.theta)).toBe(true)
  })

  it('degrades gracefully at infinite item difficulty', () => {
    for (const itemDifficulty of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = applyOutcome(stateWith(), outcome({ itemDifficulty }))
      expect(Number.isFinite(result.nextState.theta), String(itemDifficulty)).toBe(true)
    }
  })
})

describe('an out-of-range stored estimate cannot make a correct answer look like a setback', () => {
  it('clamps the estimate on the way in, not only on the way out', () => {
    // Previously: theta 5 with a correct answer produced delta −2, and the learner was
    // shown "you got this right" beside an estimate that had gone down.
    const result = applyOutcome(
      stateWith({ theta: 5, uncertainty: 0.5, evidenceCount: 4, successes: 3, unaidedSuccesses: 3 }),
      outcome(),
    )

    expect(result.delta).toBeGreaterThanOrEqual(0)
  })

  it('holds for correct answers across estimates far outside the scale', () => {
    for (const theta of [-50, -4, 4, 50]) {
      for (const hintDepth of [0, 1, 3]) {
        const result = applyOutcome(stateWith({ theta }), outcome({ hintDepth }))
        expect(result.delta, `theta ${String(theta)}, hints ${String(hintDepth)}`).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('uncertainty never rises', () => {
  it('holds even from a stored value below the floor', () => {
    // Previously: an uncertainty of 0.1 became 0.25 after one answer, because the floor was
    // applied to the result without the input ever being clamped.
    for (const uncertainty of [0, 0.05, 0.1, UNCERTAINTY_FLOOR, 0.6, 1]) {
      const result = applyOutcome(stateWith({ uncertainty }), outcome())
      expect(result.nextState.uncertainty, String(uncertainty)).toBeLessThanOrEqual(
        Math.max(uncertainty, UNCERTAINTY_FLOOR),
      )
      expect(result.nextState.uncertainty).toBeLessThanOrEqual(1)
    }
  })
})

describe('malformed hint depth is normalised rather than half-honoured', () => {
  it('treats a fractional depth as hinted throughout', () => {
    // Previously: 0.5 earned the full unaided weight while being decayed as a hinted answer,
    // and did not count towards unaided successes — three different readings of one value.
    const fractional = applyOutcome(stateWith(), outcome({ hintDepth: 0.5 }))
    const unaided = applyOutcome(stateWith(), outcome({ hintDepth: 0 }))

    expect(fractional.weight).toBe(unaided.weight)
    expect(fractional.nextState.unaidedSuccesses).toBe(1)
  })

  it('treats a negative depth as unaided', () => {
    const result = applyOutcome(stateWith(), outcome({ hintDepth: -3 }))
    expect(result.weight).toBe(1)
    expect(result.nextState.unaidedSuccesses).toBe(1)
  })

  it('treats a non-finite depth as unaided rather than maximally hinted', () => {
    for (const hintDepth of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = applyOutcome(stateWith(), outcome({ hintDepth }))
      expect(result.weight, String(hintDepth)).toBe(1)
      expect(Number.isFinite(result.nextState.theta)).toBe(true)
    }
  })

  it('counts a genuine hinted success as hinted', () => {
    const result = applyOutcome(stateWith(), outcome({ hintDepth: 2 }))
    expect(result.weight).toBeLessThan(1)
    expect(result.nextState.unaidedSuccesses).toBe(0)
    expect(result.nextState.successes).toBe(1)
  })
})

describe('the curriculum cannot be rewritten at runtime', () => {
  it('refuses to change a declared difficulty prior', () => {
    // `readonly` is erased at build time, so without freezing, any consumer could revise a
    // declared prior — the one thing ADR-0004 exists to prevent.
    const concept = CONCEPTS[0]!
    expect(Object.isFrozen(concept)).toBe(true)
    expect(() => {
      ;(concept as { baselineDifficulty: number }).baselineDifficulty = 99
    }).toThrow(TypeError)
    expect(CONCEPTS[0]!.baselineDifficulty).not.toBe(99)
  })

  it('refuses to add or remove concepts', () => {
    expect(Object.isFrozen(CONCEPTS)).toBe(true)
    expect(() => (CONCEPTS as Concept[]).push({} as Concept)).toThrow(TypeError)
  })

  it('refuses to change a misconception, which would alter what the tutor teaches', () => {
    const misconception = MISCONCEPTIONS[0]!
    expect(Object.isFrozen(misconception)).toBe(true)
    expect(() => {
      ;(misconception as { reality: string }).reality = 'something untrue'
    }).toThrow(TypeError)
  })
})

// Imported for the cast above only.
type Concept = (typeof CONCEPTS)[number]
