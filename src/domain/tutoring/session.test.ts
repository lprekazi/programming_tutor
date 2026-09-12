import { describe, expect, it } from 'vitest'

import { initialConceptState, type ConceptState } from '../learner-model/state'
import {
  CONTEXT_TURNS,
  boundedHistory,
  focusFor,
  historyWasTrimmed,
  isReturning,
  nextOrdinal,
  pitchFor,
  replyInProgress,
  unfinishedTutorTurn,
  type Turn,
} from './session'

/**
 * The rules behind a tutoring conversation.
 *
 * Two of them matter more than the rest. The context window has to be genuinely bounded, or
 * the cost of a turn grows with the length of the relationship. And the opening turn has to be
 * pitched from what the learner has *demonstrated*, because the alternative is a model
 * deciding how much they know from the impression they give.
 */

function turn(partial: Partial<Turn> & { ordinal: number }): Turn {
  return {
    id: `turn-${String(partial.ordinal)}`,
    role: 'tutor',
    text: 'something',
    status: 'complete',
    ...partial,
  }
}

function stateWith(overrides: Partial<ConceptState>): ConceptState {
  return { ...initialConceptState('program-execution'), ...overrides }
}

describe('how much conversation the tutor is sent', () => {
  it('sends nothing at the start', () => {
    expect(boundedHistory([])).toEqual([])
    expect(historyWasTrimmed([])).toBe(false)
  })

  it('is bounded however long the conversation gets', () => {
    const many = Array.from({ length: 200 }, (_, index) => turn({ ordinal: index }))

    expect(boundedHistory(many)).toHaveLength(CONTEXT_TURNS)
    expect(historyWasTrimmed(many)).toBe(true)
  })

  it('keeps the most recent turns, in order', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      turn({ ordinal: index, text: `turn ${String(index)}` }),
    )
    const sent = boundedHistory(many)

    expect(sent.at(0)?.text).toBe(`turn ${String(20 - CONTEXT_TURNS)}`)
    expect(sent.at(-1)?.text).toBe('turn 19')
    expect(sent.map((each) => each.ordinal)).toEqual([...sent.map((each) => each.ordinal)].sort((a, b) => a - b))
  })

  it('puts turns in order even when they arrive out of it', () => {
    const jumbled = [turn({ ordinal: 2 }), turn({ ordinal: 0 }), turn({ ordinal: 1 })]
    expect(boundedHistory(jumbled).map((each) => each.ordinal)).toEqual([0, 1, 2])
  })

  /*
   * A cancelled or failed turn was never read to the end. Sending it as something the tutor
   * said would have it referring back to half a sentence the learner may never have seen.
   */
  it('leaves out turns that were never finished', () => {
    const turns = [
      turn({ ordinal: 0 }),
      turn({ ordinal: 1, status: 'cancelled', text: 'half a sen' }),
      turn({ ordinal: 2, status: 'failed', text: 'also half' }),
      turn({ ordinal: 3, status: 'pending', text: '' }),
      turn({ ordinal: 4, role: 'learner' }),
    ]

    expect(boundedHistory(turns).map((each) => each.ordinal)).toEqual([0, 4])
  })

  it('leaves out a completed turn with nothing in it', () => {
    expect(boundedHistory([turn({ ordinal: 0, text: '   ' })])).toEqual([])
  })

  it('reports no trimming when everything fits', () => {
    const few = Array.from({ length: CONTEXT_TURNS }, (_, index) => turn({ ordinal: index }))
    expect(historyWasTrimmed(few)).toBe(false)
  })

  it('sends nothing at all when the window is zero', () => {
    expect(boundedHistory([turn({ ordinal: 0 })], 0)).toEqual([])
  })
})

describe('where the next turn goes', () => {
  it('starts the conversation at zero', () => {
    expect(nextOrdinal([])).toBe(0)
  })

  it('follows the highest ordinal, not the count', () => {
    // A gap is what a failed insert leaves behind. Counting would collide with turn 3.
    expect(nextOrdinal([turn({ ordinal: 0 }), turn({ ordinal: 3 })])).toBe(4)
  })
})

describe('an unfinished tutor turn', () => {
  it('is found when the conversation ends on one', () => {
    const turns = [turn({ ordinal: 0 }), turn({ ordinal: 1, status: 'failed', text: 'part' })]
    expect(unfinishedTutorTurn(turns)?.ordinal).toBe(1)
  })

  it('is not reported when the last tutor turn finished', () => {
    expect(unfinishedTutorTurn([turn({ ordinal: 0 })])).toBeNull()
  })

  it('is not reported when the learner spoke last', () => {
    expect(unfinishedTutorTurn([turn({ ordinal: 0, role: 'learner' })])).toBeNull()
  })
})

/*
 * The narrower question, and why both exist.
 *
 * `unfinishedTutorTurn` includes a reply that failed, because a failed reply is exactly what a
 * retry is offered for. `replyInProgress` must not, because one failed provider call was
 * otherwise enough to stop the tutor asking a question for the rest of the session — and a
 * deterministic question needs no provider at all.
 */
describe('a reply still being written', () => {
  it('is found while it is pending', () => {
    const turns = [turn({ ordinal: 0 }), turn({ ordinal: 1, status: 'pending', text: '' })]
    expect(replyInProgress(turns)?.ordinal).toBe(1)
  })

  it('is not a reply that failed, which is finished business', () => {
    const turns = [turn({ ordinal: 0 }), turn({ ordinal: 1, status: 'failed', text: 'part' })]

    expect(unfinishedTutorTurn(turns)?.ordinal).toBe(1)
    expect(replyInProgress(turns)).toBeNull()
  })

  it('is not a reply the learner stopped', () => {
    const turns = [turn({ ordinal: 0, status: 'cancelled', text: 'half of it' })]
    expect(replyInProgress(turns)).toBeNull()
  })

  it('is not an unanswered question, which the activity path handles itself', () => {
    const turns = [turn({ ordinal: 0, role: 'activity', status: 'pending', text: '' })]
    expect(replyInProgress(turns)).toBeNull()
  })
})

/*
 * The requirement in the milestone: a learner new to a concept and a learner returning to one
 * they got wrong must not get the same opening. Both facts are already in the learner model,
 * so this is a mapping — which is the point. A model asked to judge how much the learner knows
 * would be judging it from its own impression of them.
 */
describe('how the opening turn is pitched', () => {
  it('introduces a concept nobody has attempted', () => {
    expect(pitchFor(stateWith({}))).toBe('introduce')
    expect(isReturning(stateWith({}))).toBe(false)
  })

  it('clarifies a concept that has gone wrong', () => {
    const weak = stateWith({
      theta: -3,
      evidenceCount: 3,
      successes: 0,
      uncertainty: 0.4,
      lastSeenAt: 1,
    })

    expect(pitchFor(weak)).toBe('clarify')
    expect(isReturning(weak)).toBe(true)
  })

  it('treats two answers as closer to new than to solid', () => {
    // "Developing on one or two answers" is not someone ready for the subtlety.
    const barely = stateWith({
      theta: 0,
      evidenceCount: 1,
      successes: 1,
      unaidedSuccesses: 1,
      uncertainty: 0.9,
      lastSeenAt: 1,
    })

    expect(pitchFor(barely)).toBe('introduce')
    expect(isReturning(barely)).toBe(true)
  })

  it('goes to the edge for a concept that is secure', () => {
    const secure = stateWith({
      conceptId: 'program-execution',
      theta: 3,
      evidenceCount: 6,
      successes: 6,
      unaidedSuccesses: 6,
      uncertainty: 0.3,
      lastSeenAt: 1,
    })

    expect(pitchFor(secure)).toBe('deepen')
  })

  it('reports the pitch and the return together', () => {
    const focus = focusFor(stateWith({}))
    expect(focus).toEqual({
      conceptId: 'program-execution',
      pitch: 'introduce',
      returning: false,
    })
  })

  it('gives a different opening to a first meeting and a return', () => {
    const fresh = stateWith({})
    const returning = stateWith({
      theta: -3,
      evidenceCount: 3,
      successes: 0,
      uncertainty: 0.4,
      lastSeenAt: 1,
    })

    expect(focusFor(fresh)).not.toEqual(focusFor(returning))
  })
})
