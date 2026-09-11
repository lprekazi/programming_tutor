import { describe, expect, it } from 'vitest'

import { CONCEPTS } from '../curriculum/concepts'
import { getConcept, transitivePrerequisites } from '../curriculum/graph'
import type { ConceptId } from '../curriculum/types'
import { bandOf, bandRank, initialConceptState, type ConceptState } from '../learner-model/state'
import {
  availableConcepts,
  describeSelection,
  prerequisitesMet,
  selectNextConcept,
  stateLookupFrom,
  unmetPrerequisites,
  type StateLookup,
} from './select'

/**
 * The scheduler decides what the learner is asked to do next, and has to be able to say
 * why. The load-bearing guarantee is that it never proposes something whose prerequisites
 * the learner has not demonstrated — everything else is a priority ordering.
 */

const NOW = Date.parse('2026-09-10T12:00:00.000Z')
const DAY = 86_400_000

/**
 * Fixtures are built above each concept's own difficulty, because bands are judged on the
 * margin over that difficulty rather than on an absolute estimate. `secure` uses an
 * estimate high enough to clear the margin for even the hardest concept in the curriculum.
 */
function developing(conceptId: ConceptId, overrides: Partial<ConceptState> = {}): ConceptState {
  const base = initialConceptState(conceptId)
  return {
    ...base,
    theta: getConcept(conceptId).baselineDifficulty + 0.3,
    uncertainty: 0.7,
    evidenceCount: 2,
    successes: 2,
    unaidedSuccesses: 1,
    nextReviewAt: NOW + 5 * DAY,
    ...overrides,
  }
}

function secure(conceptId: ConceptId, overrides: Partial<ConceptState> = {}): ConceptState {
  return {
    ...initialConceptState(conceptId),
    theta: getConcept(conceptId).baselineDifficulty + 1.2,
    uncertainty: 0.3,
    evidenceCount: 6,
    successes: 5,
    unaidedSuccesses: 4,
    nextReviewAt: NOW + 10 * DAY,
    ...overrides,
  }
}

/** Attempted, never answered correctly: weak, and cannot satisfy a prerequisite. */
function weak(conceptId: ConceptId, overrides: Partial<ConceptState> = {}): ConceptState {
  return {
    ...initialConceptState(conceptId),
    theta: getConcept(conceptId).baselineDifficulty - 1.4,
    uncertainty: 0.6,
    evidenceCount: 3,
    successes: 0,
    nextReviewAt: NOW + DAY,
    ...overrides,
  }
}

/** Marks every prerequisite of `conceptId`, transitively, as secure. */
function unlock(conceptId: ConceptId): ConceptState[] {
  return [...transitivePrerequisites(conceptId)].map((id) => secure(id))
}

describe('prerequisites', () => {
  it('are unmet for everyone at the very start, except entry concepts', () => {
    const lookup = stateLookupFrom([])
    const available = availableConcepts(lookup)

    expect(available.length).toBeGreaterThan(0)
    for (const concept of available) {
      expect(concept.prerequisites).toEqual([])
    }
  })

  it('count as met once the prerequisite is developing', () => {
    const lookup = stateLookupFrom([developing('program-execution')])
    expect(prerequisitesMet(getConcept('variables-and-assignment'), lookup)).toBe(true)
  })

  it('do not count as met while the prerequisite is only weak', () => {
    const lookup = stateLookupFrom([weak('program-execution')])
    expect(prerequisitesMet(getConcept('variables-and-assignment'), lookup)).toBe(false)
  })

  it('report which prerequisites are still missing', () => {
    const lookup = stateLookupFrom([secure('if-statements')])
    expect(unmetPrerequisites('nested-conditionals', lookup)).toEqual(['logical-operators'])
  })

  it('require every prerequisite, not just one', () => {
    const lookup = stateLookupFrom([secure('for-loops-and-range')])
    // loop-control needs both loop forms.
    expect(prerequisitesMet(getConcept('loop-control'), lookup)).toBe(false)
  })
})

describe('invariant: never proposes a concept with unmet prerequisites', () => {
  it('holds from an empty history', () => {
    const selection = selectNextConcept(stateLookupFrom([]), NOW)
    expect(selection).not.toBeNull()
    expect(getConcept(selection!.conceptId).prerequisites).toEqual([])
  })

  it('holds across many randomly generated histories', () => {
    // A deterministic pseudo-random walk: enough variety to be a real check, and the same
    // sequence every run so a failure can be reproduced.
    let seed = 12_345
    const nextRandom = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }

    for (let trial = 0; trial < 200; trial += 1) {
      const states = CONCEPTS.filter(() => nextRandom() < 0.4).map((concept) => {
        const roll = nextRandom()
        if (roll < 0.34) return weak(concept.id)
        if (roll < 0.67) return developing(concept.id)
        return secure(concept.id)
      })

      const lookup = stateLookupFrom(states)
      const selection = selectNextConcept(lookup, NOW)
      if (selection === null) continue

      expect(
        unmetPrerequisites(selection.conceptId, lookup),
        `trial ${String(trial)} proposed ${selection.conceptId}`,
      ).toEqual([])
    }
  })
})

describe('priority ordering', () => {
  it('prefers a concept that is due for review over anything else', () => {
    const lookup = stateLookupFrom([
      ...unlock('while-loops'),
      // Due, and only moderately strong: still the priority.
      developing('for-loops-and-range', { nextReviewAt: NOW - 2 * DAY }),
      weak('while-loops'),
    ])

    const selection = selectNextConcept(lookup, NOW)
    expect(selection?.conceptId).toBe('for-loops-and-range')
    expect(selection?.reason.kind).toBe('review-due')
  })

  it('prefers the most overdue when several are due', () => {
    const lookup = stateLookupFrom([
      ...unlock('while-loops'),
      developing('for-loops-and-range', { nextReviewAt: NOW - DAY }),
      developing('while-loops', { nextReviewAt: NOW - 9 * DAY }),
    ])

    expect(selectNextConcept(lookup, NOW)?.conceptId).toBe('while-loops')
  })

  it('prefers a weak concept over one merely in progress', () => {
    const lookup = stateLookupFrom([
      ...unlock('while-loops'),
      developing('for-loops-and-range'),
      weak('while-loops'),
    ])

    const selection = selectNextConcept(lookup, NOW)
    expect(selection?.conceptId).toBe('while-loops')
    expect(selection?.reason.kind).toBe('weak')
  })

  it('prefers the weakest of several weak concepts', () => {
    const lookup = stateLookupFrom([
      ...unlock('while-loops'),
      weak('for-loops-and-range', { theta: -0.6 }),
      weak('while-loops', { theta: -2.2 }),
    ])

    expect(selectNextConcept(lookup, NOW)?.conceptId).toBe('while-loops')
  })

  it('prefers an in-progress concept over an untouched one', () => {
    const lookup = stateLookupFrom([...unlock('while-loops'), developing('while-loops')])

    const selection = selectNextConcept(lookup, NOW)
    expect(selection?.conceptId).toBe('while-loops')
    expect(selection?.reason.kind).toBe('in-progress')
  })

  it('prefers the least settled of several in progress', () => {
    const lookup = stateLookupFrom([
      ...unlock('while-loops'),
      developing('for-loops-and-range', { uncertainty: 0.4 }),
      developing('while-loops', { uncertainty: 0.95 }),
    ])

    expect(selectNextConcept(lookup, NOW)?.conceptId).toBe('while-loops')
  })

  it('starts something new when nothing else needs attention, easiest first', () => {
    const lookup = stateLookupFrom([secure('program-execution')])

    const selection = selectNextConcept(lookup, NOW)
    expect(selection?.reason.kind).toBe('new')
    // Both output-with-print and variables-and-assignment are unlocked; the gentler wins.
    expect(selection?.conceptId).toBe('output-with-print')
  })

  it('returns nothing when everything reachable is secure and nothing is due', () => {
    const lookup = stateLookupFrom(CONCEPTS.map((concept) => secure(concept.id)))
    expect(selectNextConcept(lookup, NOW)).toBeNull()
  })
})

describe('determinism', () => {
  it('makes the same choice for the same state', () => {
    const states = [...unlock('lists'), developing('lists'), developing('dictionaries')]
    const first = selectNextConcept(stateLookupFrom(states), NOW)
    const second = selectNextConcept(stateLookupFrom(states), NOW)
    expect(first).toEqual(second)
  })

  it('is unaffected by the order states are supplied in', () => {
    const states = [...unlock('lists'), developing('lists'), weak('dictionaries')]
    const forwards = selectNextConcept(stateLookupFrom(states), NOW)
    const backwards = selectNextConcept(stateLookupFrom([...states].reverse()), NOW)
    expect(forwards).toEqual(backwards)
  })
})

describe('the explanation shown to the learner', () => {
  const lookupFor = (states: readonly ConceptState[]): StateLookup => stateLookupFrom(states)

  it('names the concept and gives a real reason for a review', () => {
    const selection = selectNextConcept(
      lookupFor([...unlock('while-loops'), developing('while-loops', { nextReviewAt: NOW - 3 * DAY })]),
      NOW,
    )
    const sentence = describeSelection(selection!)

    expect(sentence).toContain('repeating while something is true')
    expect(sentence).toContain('3 days ago')
  })

  it('says "earlier today" rather than "0 days ago"', () => {
    const selection = selectNextConcept(
      lookupFor([
        ...unlock('while-loops'),
        developing('while-loops', { nextReviewAt: NOW - 60_000 }),
      ]),
      NOW,
    )
    expect(describeSelection(selection!)).toContain('earlier today')
  })

  it('produces a sentence for every kind of reason, with no leftover placeholders', () => {
    const cases = [
      lookupFor([...unlock('while-loops'), developing('while-loops', { nextReviewAt: NOW - DAY })]),
      lookupFor([...unlock('while-loops'), weak('while-loops')]),
      lookupFor([...unlock('while-loops'), developing('while-loops')]),
      lookupFor([secure('program-execution')]),
    ]

    for (const lookup of cases) {
      const selection = selectNextConcept(lookup, NOW)
      const sentence = describeSelection(selection!)

      expect(sentence.length).toBeGreaterThan(20)
      expect(sentence).toMatch(/\.$/)
      expect(sentence).not.toMatch(/undefined|NaN|\{|\}/)
    }
  })
})

describe('progression through the curriculum', () => {
  it('walks from the entry concept towards later material as evidence accumulates', () => {
    // Simulates a learner who answers everything correctly, unaided. Reviews are pushed
    // well beyond the simulated window so this test isolates forward progress.
    const states = new Map<ConceptId, ConceptState>()
    const visited: ConceptId[] = []
    let clock = NOW

    for (let step = 0; step < 40; step += 1) {
      const lookup: StateLookup = (id) => states.get(id) ?? initialConceptState(id)
      const selection = selectNextConcept(lookup, clock)
      if (selection === null) break

      // Prerequisites must hold at every step, not just the first.
      expect(unmetPrerequisites(selection.conceptId, lookup)).toEqual([])

      visited.push(selection.conceptId)
      states.set(selection.conceptId, secure(selection.conceptId, { nextReviewAt: clock + 400 * DAY }))
      clock += DAY
    }

    expect(visited[0]).toBe('program-execution')
    // Every concept, once each, and then nothing left to propose.
    expect(new Set(visited).size).toBe(visited.length)
    expect(visited).toHaveLength(CONCEPTS.length)
  })

  it('brings earlier concepts back once their review falls due, rather than only moving on', () => {
    // The same walk, but with realistic review intervals: the learner should be returned
    // to earlier material instead of marching forward for ever.
    const states = new Map<ConceptId, ConceptState>()
    const selections: { conceptId: ConceptId; kind: string }[] = []
    let clock = NOW

    for (let step = 0; step < 60; step += 1) {
      const lookup: StateLookup = (id) => states.get(id) ?? initialConceptState(id)
      const selection = selectNextConcept(lookup, clock)
      if (selection === null) break

      selections.push({ conceptId: selection.conceptId, kind: selection.reason.kind })
      states.set(selection.conceptId, secure(selection.conceptId, { nextReviewAt: clock + 20 * DAY }))
      clock += DAY
    }

    const revisits = selections.filter((entry, index) =>
      selections.some((other, otherIndex) => otherIndex < index && other.conceptId === entry.conceptId),
    )

    expect(revisits.length).toBeGreaterThan(0)
    // A concept is only ever returned to because it fell due, never at random.
    for (const revisit of revisits) {
      expect(revisit.kind, `${revisit.conceptId} was revisited for "${revisit.kind}"`).toBe(
        'review-due',
      )
    }
  })

  it('cannot reach object-oriented material before its foundations', () => {
    const states = new Map<ConceptId, ConceptState>()
    let clock = NOW

    for (let step = 0; step < 60; step += 1) {
      const lookup: StateLookup = (id) => states.get(id) ?? initialConceptState(id)
      const selection = selectNextConcept(lookup, clock)
      if (selection === null) break

      if (selection.conceptId === 'classes-and-objects') {
        for (const prerequisite of transitivePrerequisites('classes-and-objects')) {
          expect(bandRank(bandOf(lookup(prerequisite)))).toBeGreaterThanOrEqual(bandRank('developing'))
        }
        return
      }

      states.set(selection.conceptId, secure(selection.conceptId, { nextReviewAt: clock + 90 * DAY }))
      clock += DAY
    }

    throw new Error('The scheduler never reached classes-and-objects.')
  })
})
