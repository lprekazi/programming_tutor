import { describe, expect, it } from 'vitest'

import { CONCEPTS } from '../curriculum/concepts'
import { getConcept } from '../curriculum/graph'
import type { ConceptId } from '../curriculum/types'
import { deriveEvidence } from '../evidence/derive'
import { initialConceptState, type ConceptState } from '../learner-model/state'
import { selectNextConcept, unmetPrerequisites, type StateLookup } from './select'

/**
 * End-to-end behaviour of the domain over a simulated course of study.
 *
 * Every other scheduling test builds states by hand, which makes them precise but lets them
 * assume away the thing that matters most: whether a learner using this system actually
 * gets taught the curriculum. These tests drive the real `deriveEvidence` with realistic
 * review intervals and measure coverage.
 *
 * This is not a hypothetical concern. An earlier version of the model failed here badly:
 * an absolute `secure` threshold meant the easiest concepts needed the most evidence, and
 * fixed review intervals meant a handful of settled concepts generated roughly one review
 * per session. A perfect learner saw 9 of 33 concepts in 120 sessions and never reached
 * loops, functions or collections.
 */

const DAY = 86_400_000
const START = Date.parse('2026-01-06T09:00:00.000Z')

interface SessionRecord {
  readonly conceptId: ConceptId
  readonly reason: string
}

interface SimulationResult {
  readonly sessions: readonly SessionRecord[]
  readonly states: ReadonlyMap<ConceptId, ConceptState>
  readonly distinctConcepts: number
}

/**
 * Runs one session per day.
 *
 * `answer` decides the outcome, so the same harness can model a strong learner, a weak one
 * or one who leans on hints. Items are pitched at the concept's own declared difficulty,
 * which is what a real item bank would aim for.
 */
function simulate(
  sessionCount: number,
  answer: (conceptId: ConceptId, attempt: number) => { correct: boolean; hintDepth: number },
): SimulationResult {
  const states = new Map<ConceptId, ConceptState>()
  const attempts = new Map<ConceptId, number>()
  const sessions: SessionRecord[] = []
  const lookup: StateLookup = (id) => states.get(id) ?? initialConceptState(id)

  let clock = START

  for (let day = 0; day < sessionCount; day += 1) {
    const selection = selectNextConcept(lookup, clock)
    if (selection === null) break

    // The guarantee must hold at every step of a long run, not merely at the start.
    expect(
      unmetPrerequisites(selection.conceptId, lookup),
      `day ${String(day)} proposed ${selection.conceptId} with unmet prerequisites`,
    ).toEqual([])

    const attemptNumber = (attempts.get(selection.conceptId) ?? 0) + 1
    attempts.set(selection.conceptId, attemptNumber)

    const outcome = answer(selection.conceptId, attemptNumber)
    const { nextState } = deriveEvidence(lookup(selection.conceptId), {
      attemptId: `attempt-${String(day)}`,
      conceptId: selection.conceptId,
      itemId: `item-${String(day)}`,
      itemDifficulty: getConcept(selection.conceptId).baselineDifficulty,
      correct: outcome.correct,
      hintDepth: outcome.hintDepth,
      misconceptions: [],
      observedAt: clock,
    })

    states.set(selection.conceptId, nextState)
    sessions.push({ conceptId: selection.conceptId, reason: selection.reason.kind })
    clock += DAY
  }

  return {
    sessions,
    states,
    distinctConcepts: new Set(sessions.map((session) => session.conceptId)).size,
  }
}

const alwaysCorrect = () => ({ correct: true, hintDepth: 0 })

describe('a learner who answers everything correctly and unaided', () => {
  // Long enough to work through the whole curriculum at roughly five attempts per concept.
  const result = simulate(220, alwaysCorrect)

  it('is eventually taught the entire curriculum', () => {
    // The regression this file exists for. Before the scheduling fixes: 9 of 33, and the
    // run never terminated because reviews crowded out every new concept.
    expect(result.distinctConcepts).toBe(CONCEPTS.length)
  })

  it('finishes, rather than recycling the same material for ever', () => {
    // The simulation stops early when the scheduler reports nothing left to do.
    expect(result.sessions.length).toBeLessThan(220)
  })

  it('covers a useful amount of ground in a shorter course too', () => {
    expect(simulate(120, alwaysCorrect).distinctConcepts).toBeGreaterThanOrEqual(24)
  })

  it('reaches material from every part of the course, including the last areas', () => {
    const taught = new Set(result.sessions.map((session) => session.conceptId))
    for (const conceptId of [
      'for-loops-and-range',
      'defining-functions',
      'return-values',
      'lists',
      'dictionaries',
      'problem-decomposition',
      'classes-and-objects',
    ] as const) {
      expect(taught.has(conceptId), `never taught ${conceptId}`).toBe(true)
    }
  })

  it('does not spend session after session on the same concept', () => {
    let longestRun = 0
    let currentRun = 0

    for (let index = 0; index < result.sessions.length; index += 1) {
      const same = index > 0 && result.sessions[index]?.conceptId === result.sessions[index - 1]?.conceptId
      currentRun = same ? currentRun + 1 : 1
      longestRun = Math.max(longestRun, currentRun)
    }

    // Previously the first concept alone took fifteen consecutive sessions.
    expect(longestRun).toBeLessThanOrEqual(5)
  })

  it('spends a reasonable share of sessions on new material rather than only reviewing', () => {
    const fresh = result.sessions.filter((session) => session.reason === 'new').length
    expect(fresh).toBeGreaterThan(result.sessions.length / 5)
  })

  it('needs a comparable amount of evidence to secure easy and hard concepts', () => {
    // With an absolute threshold this was inverted: the gentlest concept in the curriculum
    // needed five times the evidence of the hardest.
    const attemptsFor = (conceptId: ConceptId): number =>
      result.sessions.filter((session) => session.conceptId === conceptId).length

    const easiest = attemptsFor('program-execution')
    const hardest = attemptsFor('classes-and-objects')

    expect(easiest).toBeGreaterThan(0)
    expect(hardest).toBeGreaterThan(0)
    expect(easiest).toBeLessThanOrEqual(hardest + 2)
  })
})

describe('a learner who always needs hints', () => {
  const result = simulate(60, () => ({ correct: true, hintDepth: 2 }))

  it('still makes steady progress rather than being held on one concept', () => {
    // Before the fix this learner saw two concepts in sixty sessions, spending thirty-seven
    // of them on the first one.
    expect(result.distinctConcepts).toBeGreaterThanOrEqual(6)
  })

  it('is never recorded as secure, because nothing was done unaided', () => {
    for (const [conceptId, state] of result.states) {
      expect(state.unaidedSuccesses, conceptId).toBe(0)
    }
  })
})

describe('a learner who keeps getting a concept wrong', () => {
  // Fails everything except the entry concept, so the scheduler cannot simply move on.
  const result = simulate(30, (conceptId) => ({
    correct: conceptId === 'program-execution',
    hintDepth: 0,
  }))

  it('is not advanced past material they have not demonstrated', () => {
    const taught = new Set(result.sessions.map((session) => session.conceptId))
    expect(taught.has('classes-and-objects')).toBe(false)
    expect(taught.has('problem-decomposition')).toBe(false)
  })

  it('keeps being brought back to what is weak rather than being abandoned', () => {
    const revisited = result.sessions.filter(
      (session) => session.reason === 'weak' || session.reason === 'review-due',
    )
    expect(revisited.length).toBeGreaterThan(0)
  })
})
