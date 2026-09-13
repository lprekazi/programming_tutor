import { describe, expect, it } from 'vitest'

import { looksLikeASolution } from '@/tutor/strategies/shared'

import { CONCEPTS_BY_ID } from '../curriculum/concepts'
import { MISCONCEPTIONS_BY_ID } from '../curriculum/misconceptions'
import { AUTHORED_EXERCISES, exercisesFor } from './bank'
import { revealsReference } from './leak'
import { codeHolds } from './mark'

/**
 * The authored exercises, held to what can be checked without running Python.
 *
 * What *does* need Python — that each reference solution passes its checks, that no starter code
 * already does, that every signal's witness produces exactly its pattern — is asserted in a real
 * interpreter by `e2e/exercises.spec.ts`, because Python runs only in the browser in this project,
 * including in its tests.
 */

describe('the exercise bank', () => {
  it('gives every exercise a unique id and title', () => {
    const ids = AUTHORED_EXERCISES.map((exercise) => exercise.id)
    const titles = AUTHORED_EXERCISES.map((exercise) => exercise.title)

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('names concepts and prerequisites that exist', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      expect(CONCEPTS_BY_ID.has(exercise.conceptId), exercise.id).toBe(true)
      for (const prerequisite of exercise.prerequisites) {
        expect(CONCEPTS_BY_ID.has(prerequisite), `${exercise.id} -> ${prerequisite}`).toBe(true)
        expect(prerequisite, exercise.id).not.toBe(exercise.conceptId)
      }
    }
  })

  it('declares a difficulty on the ability scale', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      expect(Number.isFinite(exercise.difficulty), exercise.id).toBe(true)
      expect(Math.abs(exercise.difficulty), exercise.id).toBeLessThanOrEqual(3)
    }
  })

  it('has between two and five named checks, each able to fail', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      expect(exercise.tests.length, exercise.id).toBeGreaterThanOrEqual(2)
      expect(exercise.tests.length, exercise.id).toBeLessThanOrEqual(5)

      const names = exercise.tests.map((test) => test.name)
      expect(new Set(names).size, exercise.id).toBe(names.length)

      for (const test of exercise.tests) {
        // A check with no assert and no raise cannot fail, so it would pass everything and
        // measure nothing.
        expect(/\bassert\b|\braise\b/.test(test.code), `${exercise.id}: ${test.name}`).toBe(true)
      }
    }
  })

  it('keeps the brief short enough to read in a moment', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      expect(exercise.brief.length, exercise.id).toBeLessThan(400)
      // Small tasks: difficulty from the idea, not from typing.
      expect(exercise.referenceSolution.split('\n').length, exercise.id).toBeLessThanOrEqual(12)
    }
  })

  it('never shows the reference solution as the starter code', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      expect(exercise.starterCode.trim(), exercise.id).not.toBe(exercise.referenceSolution.trim())
    }
  })

  it('covers the loop concepts the end-to-end learner meets', () => {
    // The learner every end-to-end scenario creates is taught this concept first, and with no
    // provider there is no generated exercise to fall back on.
    expect(exercisesFor('while-loops').length).toBeGreaterThan(0)
  })
})

describe('the hint ladder', () => {
  it('has exactly three hints, each saying something different', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      expect(exercise.hints, exercise.id).toHaveLength(3)
      expect(new Set(exercise.hints).size, exercise.id).toBe(3)
      for (const hint of exercise.hints) expect(hint.length, exercise.id).toBeGreaterThan(30)
    }
  })

  it('never contains the solution, checked against the solution itself', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      exercise.hints.forEach((hint, index) => {
        const where = `${exercise.id} hint ${String(index + 1)}`
        expect(looksLikeASolution(hint), where).toBe(false)
        expect(revealsReference(hint, exercise.referenceSolution), where).toBe(false)
      })
    }
  })

  it('never contains the solution even taken together', () => {
    // All three are visible at once by the time the last is shown, so the leak check has to
    // hold for the ladder as a whole, not only rung by rung.
    for (const exercise of AUTHORED_EXERCISES) {
      expect(revealsReference(exercise.hints.join('\n'), exercise.referenceSolution), exercise.id).toBe(
        false,
      )
    }
  })
})

describe('misconception signals', () => {
  it('names a catalogued misconception related to what the exercise is about', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      for (const signal of exercise.signals) {
        const misconception = MISCONCEPTIONS_BY_ID.get(signal.misconception)
        expect(misconception, `${exercise.id} names unknown ${signal.misconception}`).toBeDefined()
        expect(
          misconception?.relatedConcepts,
          `${exercise.id} is about ${exercise.conceptId}, which ${signal.misconception} says nothing about`,
        ).toContain(exercise.conceptId)
      }
    }
  })

  it('declares one outcome per check, and at least one of them a failure', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      for (const signal of exercise.signals) {
        const where = `${exercise.id}: ${signal.misconception}`
        expect(signal.pattern, where).toHaveLength(exercise.tests.length)
        // An all-pass pattern would diagnose a misconception in correct code.
        expect(signal.pattern, where).toContain('fail')
      }
    }
  })

  it('gives each misconception in an exercise a pattern of its own', () => {
    // Two signals with the same pattern would name two different wrong ideas for one result,
    // unless something else tells them apart.
    for (const exercise of AUTHORED_EXERCISES) {
      const keys = exercise.signals.map((signal) => `${signal.pattern.join(',')}|${signal.codeShows}`)
      expect(new Set(keys).size, exercise.id).toBe(keys.length)
    }
  })

  it('carries a witness that is not the reference solution, and holds what the signal requires', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      for (const signal of exercise.signals) {
        const where = `${exercise.id}: ${signal.misconception}`
        expect(signal.witness.trim(), where).not.toBe(exercise.referenceSolution.trim())
        expect(codeHolds(signal, signal.witness), `${where} witness does not hold the construct`).toBe(true)
      }
    }
  })

  /*
   * The review's finding F-03, kept as data. Each counterexample is a program that does not hold
   * the belief — several are the review's own — and the signal's code evidence must reject every
   * one. (Whether their check results would also match is checked in a real interpreter by
   * `exercises.spec.ts`; the code evidence alone is what has to hold regardless.)
   */
  it('never finds the construct in a program that does not hold the belief', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      for (const signal of exercise.signals) {
        expect(signal.counterexamples.length, `${exercise.id}: ${signal.misconception}`).toBeGreaterThan(0)
        signal.counterexamples.forEach((program, index) => {
          expect(
            codeHolds(signal, program),
            `${exercise.id}: ${signal.misconception} fires on counterexample ${String(index)}`,
          ).toBe(false)
        })
      }
    }
  })

  it('does not find the construct in the reference solution', () => {
    for (const exercise of AUTHORED_EXERCISES) {
      for (const signal of exercise.signals) {
        expect(codeHolds(signal, exercise.referenceSolution), `${exercise.id}: ${signal.misconception}`).toBe(false)
      }
    }
  })
})
