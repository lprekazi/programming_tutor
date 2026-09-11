import { describe, expect, it } from 'vitest'

import { initialConceptState, type ConceptState } from '../learner-model/state'
import { applyOutcome } from '../learner-model/update'
import { deriveEvidence } from './derive'
import type { JudgedAttempt } from './types'

/**
 * Evidence derivation is the only path by which learner state changes.
 *
 * The point of these tests is the guarantee that matters most in the whole system: a
 * language model can judge an attempt, but it cannot write learner state. It supplies a
 * verdict from a closed vocabulary; the numbers are computed here, and every movement
 * carries a record of what caused it.
 */

const NOW = Date.parse('2026-09-10T12:00:00.000Z')

function attemptWith(overrides: Partial<JudgedAttempt> = {}): JudgedAttempt {
  return {
    attemptId: 'attempt-1',
    conceptId: 'for-loops-and-range',
    itemId: 'item-1',
    itemDifficulty: 0,
    correct: true,
    hintDepth: 0,
    misconceptions: [],
    observedAt: NOW,
    ...overrides,
  }
}

function stateWith(overrides: Partial<ConceptState> = {}): ConceptState {
  return { ...initialConceptState('for-loops-and-range'), ...overrides }
}

describe('attribution', () => {
  it('links every change to the attempt that caused it', () => {
    const { record } = deriveEvidence(stateWith(), attemptWith({ attemptId: 'attempt-42' }))

    expect(record.attemptId).toBe('attempt-42')
    expect(record.conceptId).toBe('for-loops-and-range')
    expect(record.observedAt).toBe(NOW)
  })

  it('records the estimate before and after, and the change between them', () => {
    const before = stateWith({ theta: 0.25 })
    const { record, nextState } = deriveEvidence(before, attemptWith())

    expect(record.priorTheta).toBe(before.theta)
    expect(record.posteriorTheta).toBe(nextState.theta)
    expect(record.posteriorTheta - record.priorTheta).toBeCloseTo(record.delta)
  })

  it('records the bands either side, so a change of band is visible', () => {
    const { record } = deriveEvidence(stateWith(), attemptWith())
    expect(record.priorBand).toBe('not-started')
    expect(record.posteriorBand).toBe('developing')
  })

  it('records the expectation and the weight the outcome carried', () => {
    const { record } = deriveEvidence(stateWith(), attemptWith({ hintDepth: 2 }))
    expect(record.expected).toBeCloseTo(0.5)
    expect(record.weight).toBeLessThan(1)
  })

  it('refuses an attempt for a different concept rather than silently mis-attributing it', () => {
    expect(() =>
      deriveEvidence(stateWith(), attemptWith({ conceptId: 'lists' })),
    ).toThrow(/cannot update state for/)
  })

  it('rejects a malformed hint depth', () => {
    expect(() => deriveEvidence(stateWith(), attemptWith({ hintDepth: -1 }))).toThrow(
      /non-negative integer/,
    )
    expect(() => deriveEvidence(stateWith(), attemptWith({ hintDepth: 1.5 }))).toThrow(
      /non-negative integer/,
    )
  })

  it('rejects a non-finite item difficulty', () => {
    expect(() =>
      deriveEvidence(stateWith(), attemptWith({ itemDifficulty: Number.NaN })),
    ).toThrow(/non-finite difficulty/)
  })

  it('does not mutate the state it was given', () => {
    const before = stateWith()
    const snapshot = { ...before }
    deriveEvidence(before, attemptWith())
    expect(before).toEqual(snapshot)
  })
})

describe('the reason shown to the learner', () => {
  it('says what happened, in plain language, for an unaided success', () => {
    const { record } = deriveEvidence(stateWith(), attemptWith())
    expect(record.reason).toContain('counting loops')
    expect(record.reason).toContain('unaided')
    expect(record.reason).not.toMatch(/theta|logit|0\.\d{3}/)
  })

  it('names the number of hints when help was taken', () => {
    const one = deriveEvidence(stateWith(), attemptWith({ hintDepth: 1 })).record
    const three = deriveEvidence(stateWith(), attemptWith({ hintDepth: 3 })).record

    expect(one.reason).toContain('one hint')
    expect(three.reason).toContain('3 hints')
  })

  it('explains that a hinted success still counts, and comes back sooner', () => {
    const { record } = deriveEvidence(
      stateWith({ theta: 0.2, evidenceCount: 2, successes: 2, unaidedSuccesses: 1 }),
      attemptWith({ hintDepth: 2 }),
    )
    expect(record.reason).toContain('progress')
    expect(record.reason).toContain('sooner')
  })

  it('mentions the move when the band changes', () => {
    const { record } = deriveEvidence(stateWith(), attemptWith())
    expect(record.reason).toContain('not started')
    expect(record.reason).toContain('developing')
  })

  it('describes a failure without blaming the learner', () => {
    const { record } = deriveEvidence(stateWith(), attemptWith({ correct: false }))
    expect(record.reason).toContain('Did not answer')
    expect(record.reason.toLowerCase()).not.toMatch(/fail|wrong|bad|poor/)
  })
})

describe('misconception observations', () => {
  it('records each tagged misconception against the attempt', () => {
    const { misconceptions } = deriveEvidence(
      stateWith(),
      attemptWith({ correct: false, misconceptions: ['range-endpoint-inclusive', 'if-is-loop'] }),
    )

    expect(misconceptions).toHaveLength(2)
    expect(misconceptions.map((observation) => observation.misconceptionId)).toEqual([
      'range-endpoint-inclusive',
      'if-is-loop',
    ])
    expect(misconceptions[0]?.attemptId).toBe('attempt-1')
  })

  it('collapses a repeated tag, so one attempt cannot inflate a recurrence count', () => {
    const { misconceptions } = deriveEvidence(
      stateWith(),
      attemptWith({
        correct: false,
        misconceptions: ['if-is-loop', 'if-is-loop', 'if-is-loop'],
      }),
    )
    expect(misconceptions).toHaveLength(1)
  })

  it('records none when none were observed', () => {
    expect(deriveEvidence(stateWith(), attemptWith()).misconceptions).toEqual([])
  })
})

describe('item calibration observations', () => {
  it('records a failure on an item the learner was almost certain to pass', () => {
    const { calibration } = deriveEvidence(
      stateWith({ theta: 2.5, evidenceCount: 4 }),
      attemptWith({ correct: false, itemDifficulty: -2 }),
    )

    expect(calibration).not.toBeNull()
    expect(calibration?.itemId).toBe('item-1')
    expect(calibration?.declaredDifficulty).toBe(-2)
    expect(calibration?.residual).toBeLessThan(0)
  })

  it('records an unaided success on an item the learner was almost certain to fail', () => {
    const { calibration } = deriveEvidence(
      stateWith({ theta: -2.5, evidenceCount: 4 }),
      attemptWith({ correct: true, itemDifficulty: 2 }),
    )

    expect(calibration).not.toBeNull()
    expect(calibration?.residual).toBeGreaterThan(0)
  })

  it('does not record a hinted success, because the help already explains it', () => {
    const { calibration } = deriveEvidence(
      stateWith({ theta: -2.5, evidenceCount: 4 }),
      attemptWith({ correct: true, itemDifficulty: 2, hintDepth: 2 }),
    )
    expect(calibration).toBeNull()
  })

  it('records nothing for an unsurprising outcome', () => {
    const { calibration } = deriveEvidence(stateWith(), attemptWith({ itemDifficulty: 0 }))
    expect(calibration).toBeNull()
  })

  it('records the difficulty as declared, leaving the caller’s item untouched', () => {
    // ADR-0004: with one learner, a surprising outcome cannot be attributed to the item
    // rather than the learner, so it is recorded and nothing is adjusted.
    const surprising = attemptWith({ correct: false, itemDifficulty: -2 })
    const result = deriveEvidence(stateWith({ theta: 2.5, evidenceCount: 4 }), surprising)

    expect(surprising.itemDifficulty).toBe(-2)
    expect(result.calibration?.declaredDifficulty).toBe(-2)
  })

  it('applies the same estimate change whether or not the outcome was surprising', () => {
    // Sweeps the surprise threshold: as the item gets easier the outcome crosses from
    // ordinary to surprising, and an observation starts being recorded. The estimate change
    // must track the difficulty smoothly across that boundary, with no step where the
    // observation begins — if recording one also nudged the estimate, this would catch it.
    const state = stateWith({ theta: 2.5, evidenceCount: 4, successes: 3, unaidedSuccesses: 3 })
    let sawOrdinary = false
    let sawSurprising = false

    for (const itemDifficulty of [2.5, 2, 1.5, 1, 0.5, 0, -0.5, -1, -1.5, -2]) {
      const result = deriveEvidence(state, attemptWith({ correct: false, itemDifficulty }))
      const independent = applyOutcome(state, { correct: false, hintDepth: 0, itemDifficulty })

      if (result.calibration === null) sawOrdinary = true
      else sawSurprising = true

      expect(result.nextState.theta, `difficulty ${String(itemDifficulty)}`).toBe(
        independent.nextState.theta,
      )
    }

    // The sweep is only meaningful if it actually crossed the threshold.
    expect(sawOrdinary && sawSurprising).toBe(true)
  })
})

describe('scheduling side effects', () => {
  it('stamps when the concept was seen and when it should come back', () => {
    const { nextState } = deriveEvidence(stateWith(), attemptWith())

    expect(nextState.lastSeenAt).toBe(NOW)
    expect(nextState.nextReviewAt).not.toBeNull()
    expect(nextState.nextReviewAt!).toBeGreaterThan(NOW)
  })

  it('brings a supported success back sooner than an unaided one', () => {
    const unaided = deriveEvidence(stateWith(), attemptWith({ hintDepth: 0 })).nextState
    const hinted = deriveEvidence(stateWith(), attemptWith({ hintDepth: 3 })).nextState

    expect(hinted.nextReviewAt!).toBeLessThan(unaided.nextReviewAt!)
  })
})
