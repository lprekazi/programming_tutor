import { describe, expect, it } from 'vitest'

import { getConcept } from '../curriculum/graph'
import {
  EVIDENCE_MODERATE_MIN,
  EVIDENCE_STRONG_MIN,
  SECURE_MIN_UNAIDED_SUCCESSES,
} from './parameters'
import {
  bandOf,
  bandRank,
  evidenceStrengthOf,
  expectedSuccess,
  initialConceptState,
  isReviewDue,
  type Band,
  type ConceptState,
} from './state'

/** All fixtures use 'lists'; bands are judged on the margin over its own difficulty. */
const DIFFICULTY = getConcept('lists').baselineDifficulty

function stateWith(overrides: Partial<ConceptState> = {}): ConceptState {
  return { ...initialConceptState('lists'), ...overrides }
}

/** A state that satisfies every requirement for `secure`, so each can be removed in turn. */
function secureState(overrides: Partial<ConceptState> = {}): ConceptState {
  return stateWith({
    theta: DIFFICULTY + 1.2,
    uncertainty: 0.4,
    evidenceCount: 5,
    successes: 4,
    unaidedSuccesses: SECURE_MIN_UNAIDED_SUCCESSES,
    ...overrides,
  })
}

describe('initial state', () => {
  it('starts with no evidence and maximum uncertainty', () => {
    const state = initialConceptState('lists')
    expect(state.evidenceCount).toBe(0)
    expect(state.unaidedSuccesses).toBe(0)
    expect(state.uncertainty).toBe(1)
    expect(state.lastSeenAt).toBeNull()
    expect(state.nextReviewAt).toBeNull()
    expect(bandOf(state)).toBe('not-started')
  })
})

describe('bands', () => {
  it('orders from untouched to established', () => {
    const ordered: Band[] = ['not-started', 'needs-review', 'developing', 'secure']
    const ranks = ordered.map(bandRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(new Set(ranks).size).toBe(ordered.length)
  })

  it('reports not-started until there is any evidence at all', () => {
    // Even a flattering estimate means nothing without an attempt behind it.
    expect(bandOf(stateWith({ theta: 3, uncertainty: 0.25, evidenceCount: 0, successes: 0 }))).toBe('not-started')
  })

  it('reports secure when estimate, certainty, evidence and independence all hold', () => {
    expect(bandOf(secureState())).toBe('secure')
  })

  it('withholds secure when the estimate is not high enough', () => {
    expect(bandOf(secureState({ theta: DIFFICULTY + 0.2 }))).not.toBe('secure')
  })

  it('withholds secure when the model is still uncertain', () => {
    expect(bandOf(secureState({ uncertainty: 0.9 }))).not.toBe('secure')
  })

  it('withholds secure when too few attempts back it up', () => {
    expect(bandOf(secureState({ evidenceCount: 1 }))).not.toBe('secure')
  })

  it('withholds secure when every success needed help', () => {
    // The case that matters most: the arithmetic is satisfied, but the learner has never
    // once answered unaided, so calling it secure would overstate what was shown.
    expect(bandOf(secureState({ unaidedSuccesses: 0 }))).toBe('developing')
  })

  it('reports needs-review when the estimate has fallen', () => {
    expect(bandOf(stateWith({ theta: DIFFICULTY - 1.2, evidenceCount: 3, successes: 2 }))).toBe('needs-review')
  })

  it('reports developing in between', () => {
    expect(
      bandOf(stateWith({ theta: DIFFICULTY + 0.3, evidenceCount: 2, successes: 2, unaidedSuccesses: 1 })),
    ).toBe('developing')
  })
})

describe('evidence strength', () => {
  it('changes exactly at the documented thresholds', () => {
    // Probes each boundary rather than sampling comfortably either side of it, so an
    // off-by-one between > and >= would fail here.
    expect(evidenceStrengthOf(stateWith({ evidenceCount: 0 }))).toBe('none')
    expect(evidenceStrengthOf(stateWith({ evidenceCount: 1 }))).toBe('limited')
    expect(evidenceStrengthOf(stateWith({ evidenceCount: EVIDENCE_MODERATE_MIN - 1 }))).toBe('limited')
    expect(evidenceStrengthOf(stateWith({ evidenceCount: EVIDENCE_MODERATE_MIN }))).toBe('moderate')
    expect(evidenceStrengthOf(stateWith({ evidenceCount: EVIDENCE_STRONG_MIN - 1 }))).toBe('moderate')
    expect(evidenceStrengthOf(stateWith({ evidenceCount: EVIDENCE_STRONG_MIN }))).toBe('strong')
  })

  it('is independent of the estimate, so a confident guess is still thin evidence', () => {
    const thin = stateWith({ theta: 2.5, uncertainty: 0.3, evidenceCount: 1, successes: 1 })
    expect(evidenceStrengthOf(thin)).toBe('limited')
  })
})

describe('review due', () => {
  it('is never due when nothing has been scheduled', () => {
    expect(isReviewDue(stateWith({ nextReviewAt: null }), 1_000)).toBe(false)
  })

  it('becomes due once the scheduled time has passed', () => {
    expect(isReviewDue(stateWith({ nextReviewAt: 1_000 }), 999)).toBe(false)
    expect(isReviewDue(stateWith({ nextReviewAt: 1_000 }), 1_000)).toBe(true)
    expect(isReviewDue(stateWith({ nextReviewAt: 1_000 }), 5_000)).toBe(true)
  })

  it('is separate from mastery, so a secure concept can still be due', () => {
    const state = secureState({ nextReviewAt: 500 })
    expect(bandOf(state)).toBe('secure')
    expect(isReviewDue(state, 1_000)).toBe(true)
  })
})

describe('expected success', () => {
  it('is even when ability matches difficulty', () => {
    expect(expectedSuccess(0, 0)).toBeCloseTo(0.5)
    expect(expectedSuccess(1.5, 1.5)).toBeCloseTo(0.5)
  })

  it('rises with ability and falls with difficulty', () => {
    expect(expectedSuccess(2, 0)).toBeGreaterThan(0.5)
    expect(expectedSuccess(-2, 0)).toBeLessThan(0.5)
    expect(expectedSuccess(0, 2)).toBeLessThan(expectedSuccess(0, 1))
  })

  it('is confident, but never certain, at the extremes of the scale', () => {
    // Asserting only 0 < p < 1 would be vacuous — that holds for any logistic and any
    // input. These bound how confident the model is allowed to get within its own scale.
    expect(expectedSuccess(-3, 3)).toBeLessThan(0.01)
    expect(expectedSuccess(-3, 3)).toBeGreaterThan(0)
    expect(expectedSuccess(3, -3)).toBeGreaterThan(0.99)
    expect(expectedSuccess(3, -3)).toBeLessThan(1)
  })
})
