import { describe, expect, it } from 'vitest'

import { initialConceptState, type ConceptState } from '../learner-model/state'
import { MAX_CHECKS_PER_SESSION, decideCheck, describeGround, type CheckContext } from './select'

/**
 * When the tutor decides to check understanding, and with what.
 *
 * Two requirements from the milestone are tested here, and they pull against each other, which
 * is why the balance is worth asserting rather than assuming:
 *
 *   - "Do not ask questions merely to populate data." A tutor that tests after every paragraph
 *     is administering an examination, and a question asked of a learner who is demonstrably
 *     solid tells nobody anything.
 *   - "A learner returning to a weak misconception should receive an activity that actually
 *     probes that misconception." Not a general question on the topic — the specific probe.
 */

function contextWith(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    conceptId: 'loop-control',
    state: initialConceptState('loop-control'),
    recentMisconceptions: [],
    usedItemIds: [],
    assessed: [],
    exchanges: 3,
    checksSoFar: 0,
    lastWasCheck: false,
    ...overrides,
  }
}

function stateWith(overrides: Partial<ConceptState>): ConceptState {
  return { ...initialConceptState('loop-control'), ...overrides }
}

describe('holding off', () => {
  it('says nothing before any teaching has happened', () => {
    const decision = decideCheck(contextWith({ exchanges: 0 }))

    expect(decision.kind).toBe('hold')
    expect(decision.kind === 'hold' && decision.because).toBe('too-early')
  })

  it('does not ask twice in a row', () => {
    const decision = decideCheck(contextWith({ lastWasCheck: true }))

    expect(decision.kind === 'hold' && decision.because).toBe('just-asked')
  })

  it('stops after enough checks in one session', () => {
    const decision = decideCheck(contextWith({ checksSoFar: MAX_CHECKS_PER_SESSION }))

    expect(decision.kind === 'hold' && decision.because).toBe('enough-for-now')
  })

  /*
   * The "not merely to populate data" rule. A learner who is secure with strong evidence has
   * nothing left to demonstrate here, and asking anyway costs them time for no information.
   */
  it('does not test a learner who is demonstrably solid', () => {
    const decision = decideCheck(
      contextWith({
        state: stateWith({
          theta: 4,
          evidenceCount: 8,
          successes: 8,
          unaidedSuccesses: 7,
          uncertainty: 0.25,
          lastSeenAt: 1,
        }),
      }),
    )

    expect(decision.kind === 'hold' && decision.because).toBe('nothing-to-learn')
  })

  it('still tests a secure learner whose evidence is thin', () => {
    // Secure on three answers is not the same as secure on eight, and another answer here does
    // tell somebody something.
    const decision = decideCheck(
      contextWith({
        state: stateWith({
          theta: 4,
          evidenceCount: 3,
          successes: 3,
          unaidedSuccesses: 2,
          uncertainty: 0.4,
          lastSeenAt: 1,
        }),
      }),
    )

    expect(decision.kind).not.toBe('hold')
  })
})

describe('probing a misconception', () => {
  it('chooses an item designed for the wrong idea that was seen', () => {
    const decision = decideCheck(
      contextWith({
        recentMisconceptions: ['break-leaves-all-loops'],
        state: stateWith({ evidenceCount: 2, successes: 1, lastSeenAt: 1 }),
      }),
    )

    if (decision.kind !== 'ask') throw new Error('expected a question')
    expect(decision.ground.kind).toBe('probes-misconception')
    // Not a general question on loops: the item that exposes this particular belief.
    expect(decision.item.probes).toBe('break-leaves-all-loops')
  })

  it('reaches a probe on a neighbouring concept rather than giving up', () => {
    const decision = decideCheck(
      contextWith({
        conceptId: 'while-loops',
        state: stateWith({ conceptId: 'while-loops', evidenceCount: 2, successes: 1, lastSeenAt: 1 }),
        recentMisconceptions: ['break-leaves-all-loops'],
      }),
    )

    if (decision.kind !== 'ask') throw new Error('expected a question')
    expect(decision.item.probes).toBe('break-leaves-all-loops')
  })

  /*
   * The limit on that. `program-execution` is a root concept in the fundamentals area, and
   * `self-assignable` is only probed by an item about methods and attributes — material this
   * learner has not been introduced to, in a session about something else, whose answer would
   * move a band for a concept they are not studying.
   */
  it('does not reach into material the learner has never met', () => {
    const decision = decideCheck(
      contextWith({
        conceptId: 'program-execution',
        state: stateWith({ conceptId: 'program-execution', evidenceCount: 2, successes: 1, lastSeenAt: 1 }),
        recentMisconceptions: ['self-assignable'],
        assessed: ['program-execution'],
      }),
    )

    if (decision.kind !== 'ask') throw new Error('expected a question')
    expect(decision.item.conceptId).not.toBe('methods-and-attributes')
    expect(decision.ground.kind).not.toBe('probes-misconception')
  })

  /*
   * The other half of the rule. A wrong answer in the diagnostic is exactly the case worth
   * following up later, and the concept it was about is by definition one the learner has met —
   * so the probe is allowed, and the reason shown says which topic it is going back to.
   */
  it('does reach a concept the learner has already been assessed on, and says so', () => {
    const decision = decideCheck(
      contextWith({
        conceptId: 'program-execution',
        state: stateWith({ conceptId: 'program-execution', evidenceCount: 2, successes: 1, lastSeenAt: 1 }),
        recentMisconceptions: ['self-assignable'],
        assessed: ['program-execution', 'methods-and-attributes'],
      }),
    )

    if (decision.kind !== 'ask') throw new Error('expected a question')
    expect(decision.item.conceptId).toBe('methods-and-attributes')
    expect(decision.ground.kind === 'probes-misconception' && decision.ground.about).toBe(
      'methods-and-attributes',
    )
    expect(describeGround(decision.ground)).toContain('methods and attributes')
  })

  it('does not claim to probe a misconception it has no unused item for', () => {
    const probes = decideCheck(contextWith({ recentMisconceptions: ['break-leaves-all-loops'] }))
    if (probes.kind !== 'ask') throw new Error('expected a question')

    // Every item for it already used: the ground must fall back to something true rather than
    // claiming a probe and asking a general question.
    const exhausted = decideCheck(
      contextWith({
        recentMisconceptions: ['break-leaves-all-loops'],
        usedItemIds: ['p-break-inner-only'],
      }),
    )

    expect(probes.ground.kind).toBe('probes-misconception')
    expect(exhausted.kind === 'ask' && exhausted.ground.kind).not.toBe('probes-misconception')
  })

  it('prefers the most recent wrong idea when several are outstanding', () => {
    const decision = decideCheck(
      contextWith({
        recentMisconceptions: ['break-leaves-all-loops', 'continue-ends-the-loop'],
      }),
    )

    if (decision.kind !== 'ask') throw new Error('expected a question')
    expect(decision.ground.kind === 'probes-misconception' && decision.ground.misconception).toBe(
      'break-leaves-all-loops',
    )
  })
})

describe('choosing a question otherwise', () => {
  it('reports why it is asking, and the reason matches the learner', () => {
    const fresh = decideCheck(contextWith())
    expect(fresh.kind === 'ask' && fresh.ground.kind).toBe('no-evidence-yet')

    const weak = decideCheck(
      contextWith({
        state: stateWith({ theta: -5, evidenceCount: 3, successes: 0, uncertainty: 0.4, lastSeenAt: 1 }),
      }),
    )
    expect(weak.kind === 'ask' && weak.ground.kind).toBe('shaky')

    const going = decideCheck(
      contextWith({
        state: stateWith({ evidenceCount: 2, successes: 1, uncertainty: 0.8, lastSeenAt: 1 }),
      }),
    )
    expect(going.kind === 'ask' && going.ground.kind).toBe('unsettled')
  })

  it('never asks the same question twice', () => {
    const asked: string[] = []

    for (let round = 0; round < 12; round += 1) {
      const decision = decideCheck(contextWith({ usedItemIds: asked }))
      if (decision.kind !== 'ask') break
      expect(asked, decision.item.id).not.toContain(decision.item.id)
      asked.push(decision.item.id)
    }

    expect(asked.length).toBeGreaterThan(1)
  })

  it('falls back to generating once the bank is exhausted for a concept', () => {
    // Every authored item for this concept already used.
    const decision = decideCheck(
      contextWith({
        conceptId: 'problem-decomposition',
        state: stateWith({ conceptId: 'problem-decomposition' }),
      }),
    )

    expect(decision.kind).toBe('generate')
    expect(decision.kind === 'generate' && decision.conceptId).toBe('problem-decomposition')
  })

  it('pitches near where the learner looks on that concept', () => {
    const struggling = decideCheck(
      contextWith({
        conceptId: 'loop-control',
        state: stateWith({ theta: -2, evidenceCount: 2, successes: 0, lastSeenAt: 1 }),
      }),
    )
    const confident = decideCheck(
      contextWith({
        conceptId: 'loop-control',
        state: stateWith({ theta: 2, evidenceCount: 2, successes: 2, lastSeenAt: 1 }),
      }),
    )

    if (struggling.kind !== 'ask' || confident.kind !== 'ask') {
      throw new Error('expected questions')
    }
    expect(struggling.item.difficulty).toBeLessThanOrEqual(confident.item.difficulty)
  })
})

describe('the reason shown to the learner', () => {
  it('says something true and specific for every ground', () => {
    const grounds = [
      { kind: 'probes-misconception', misconception: 'break-leaves-all-loops' },
      { kind: 'no-evidence-yet' },
      { kind: 'shaky' },
      { kind: 'unsettled' },
    ] as const

    for (const ground of grounds) {
      const words = describeGround(ground)
      expect(words.length, ground.kind).toBeGreaterThan(25)
      expect(words, ground.kind).toMatch(/\.$/)
      expect(words, ground.kind).not.toMatch(/undefined|NaN|\{|\}/)
    }
  })

  it('exposes no internal number', () => {
    const words = describeGround({ kind: 'unsettled' })
    expect(words).not.toMatch(/theta|uncertainty|0\.\d/)
  })
})
