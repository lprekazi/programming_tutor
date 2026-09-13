import { describe, expect, it } from 'vitest'

import { initialConceptState, type ConceptState } from '../learner-model/state'
import { AUTHORED_EXERCISES, exercisesFor } from './bank'
import { presentExercise } from './present'
import {
  MAX_EXERCISES_PER_SITTING,
  decideExercise,
  describeExerciseGround,
  fallbackExercise,
  type ExerciseContext,
} from './select'

function contextWith(overrides: Partial<ExerciseContext> = {}): ExerciseContext {
  return {
    conceptId: 'loop-accumulation',
    state: initialConceptState('loop-accumulation'),
    exchanges: 2,
    exercisesThisSitting: 0,
    openActivity: false,
    usedExerciseIds: [],
    recentMisconceptions: [],
    ...overrides,
  }
}

describe('holding off', () => {
  it('waits until something has been taught', () => {
    expect(decideExercise(contextWith({ exchanges: 0 }))).toEqual({ kind: 'hold', because: 'too-early' })
  })

  it('does one thing at a time', () => {
    expect(decideExercise(contextWith({ openActivity: true }))).toEqual({
      kind: 'hold',
      because: 'finish-open-one',
    })
  })

  it('stops after enough exercises in one sitting', () => {
    expect(
      decideExercise(contextWith({ exercisesThisSitting: MAX_EXERCISES_PER_SITTING })),
    ).toEqual({ kind: 'hold', because: 'enough-for-now' })
  })

  it('does not set work that would tell nobody anything', () => {
    const solid: ConceptState = {
      ...initialConceptState('loop-accumulation'),
      theta: 4,
      evidenceCount: 9,
      successes: 9,
      unaidedSuccesses: 8,
      uncertainty: 0.2,
      lastSeenAt: 1,
    }

    expect(decideExercise(contextWith({ state: solid }))).toEqual({
      kind: 'hold',
      because: 'nothing-to-learn',
    })
  })
})

describe('choosing', () => {
  it('sets an authored exercise on the concept being taught', () => {
    const decision = decideExercise(contextWith())

    if (decision.kind !== 'set') throw new Error('expected an exercise')
    expect(decision.exercise.conceptId).toBe('loop-accumulation')
  })

  it('prefers the exercise whose checks could observe a wrong idea seen recently', () => {
    const decision = decideExercise(contextWith({ recentMisconceptions: ['accumulator-overwritten'] }))

    if (decision.kind !== 'set') throw new Error('expected an exercise')
    expect(decision.ground).toEqual({ kind: 'probes-misconception', misconception: 'accumulator-overwritten' })
    expect(
      decision.exercise.signals.some((signal) => signal.misconception === 'accumulator-overwritten'),
    ).toBe(true)
  })

  it('never sets the same authored exercise twice', () => {
    const used: string[] = []
    for (let round = 0; round < exercisesFor('loop-accumulation').length; round += 1) {
      const decision = decideExercise(contextWith({ usedExerciseIds: used }))
      if (decision.kind !== 'set') throw new Error('expected an exercise')
      expect(used).not.toContain(decision.exercise.id)
      used.push(decision.exercise.id)
    }

    // All used: the next one has to be written.
    expect(decideExercise(contextWith({ usedExerciseIds: used })).kind).toBe('generate')
  })

  it('generates for a concept with no authored exercise', () => {
    expect(decideExercise(contextWith({ conceptId: 'booleans', state: initialConceptState('booleans') })).kind).toBe(
      'generate',
    )
  })
})

describe('falling back', () => {
  it('reaches only for something the concept builds on, and says which', () => {
    const fallback = fallbackExercise('nested-loops', [])

    if (fallback === null) throw new Error('expected a fallback')
    // nested-loops builds on loop-accumulation, for-loops-and-range and if-statements, among others.
    expect(['loop-accumulation', 'for-loops-and-range', 'if-statements', 'while-loops']).toContain(
      fallback.exercise.conceptId,
    )
    expect(fallback.ground.kind).toBe('builds-on')
    expect(describeExerciseGround(fallback.ground)).toContain('which this builds on')
  })

  it('offers nothing rather than something unrelated', () => {
    // program-execution is a root concept: nothing sits beneath it.
    expect(fallbackExercise('program-execution', [])).toBeNull()
  })
})

describe('what reaches the browser', () => {
  it('never carries the reference solution, under any field name', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      const presented = presentExercise({
        id: 'e1',
        conceptId: exercise.conceptId,
        kind: exercise.kind,
        origin: 'authored',
        title: exercise.title,
        brief: exercise.brief,
        starterCode: exercise.starterCode,
        tests: exercise.tests,
        referenceSolution: exercise.referenceSolution,
        selectionGround: 'A short exercise.',
      })

      const serialised = JSON.stringify(presented)
      expect(serialised, exercise.id).not.toContain(JSON.stringify(exercise.referenceSolution).slice(1, -1))
      expect(Object.keys(presented), exercise.id).not.toContain('referenceSolution')
      // Nor the wrong programs behind the marking's patterns — except where a repair exercise's
      // witness is part of its starter code, which the learner is meant to see and fix.
      for (const signal of exercise.signals) {
        if (exercise.starterCode.includes(signal.witness.trim())) continue
        expect(serialised, exercise.id).not.toContain(JSON.stringify(signal.witness).slice(1, -1))
      }
    }
  })

  it('carries the named checks, because they have to run in the browser', () => {
    const [exercise] = AUTHORED_EXERCISES
    if (exercise === undefined) throw new Error('empty bank')

    const presented = presentExercise({
      id: 'e1',
      conceptId: exercise.conceptId,
      kind: exercise.kind,
      origin: 'authored',
      title: exercise.title,
      brief: exercise.brief,
      starterCode: exercise.starterCode,
      tests: exercise.tests,
      referenceSolution: exercise.referenceSolution,
      selectionGround: 'A short exercise.',
    })

    expect(presented.checks.map((check) => check.name)).toEqual(exercise.tests.map((test) => test.name))
  })
})
