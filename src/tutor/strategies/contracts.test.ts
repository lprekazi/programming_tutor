import { describe, expect, it } from 'vitest'

import { UNKNOWN_LEARNER } from '../blocks/learner'
import { ALL_STRATEGIES } from './index'
import { looksLikeASolution, strategyContext } from './shared'
import type { InvariantProblem, StrategyContext } from './types'

/**
 * A loose view of a structured strategy.
 *
 * The nine strategies each have their own input and output types, so iterating over them as a
 * union gives an intersection TypeScript cannot satisfy. These tests only assert properties
 * common to all of them, so a common view is the honest shape to work through — and it is
 * confined to this file rather than weakening the real types.
 */
interface AnyStructured {
  readonly id: string
  readonly version: string
  readonly purpose: string
  readonly streams: false
  readonly schemaName: string
  readonly schema: { safeParse: (value: unknown) => { success: boolean } }
  safeFallback: (input: never) => unknown
  checkInvariants: (output: never, input: never, context: StrategyContext) => readonly InvariantProblem[]
}

/**
 * Properties every strategy must have, checked across all nine at once.
 *
 * Written this way so that adding a tenth strategy cannot skip the contract: a new entry in
 * the registry is checked by every test here without anybody remembering to add one.
 */

const structured = ALL_STRATEGIES.filter(
  (strategy) => strategy.kind === 'structured',
) as unknown as AnyStructured[]
const prose = ALL_STRATEGIES.filter((strategy) => strategy.kind === 'prose')

describe('every strategy', () => {
  it('is one of the ten that were planned', () => {
    // Listed rather than counted, so adding a strategy is a deliberate act with a name
    // attached rather than a number quietly going up.
    expect(ALL_STRATEGIES.map((strategy) => strategy.id).sort()).toEqual([
      'answer.evaluate',
      'code.feedback',
      'code.task.generate',
      'converse',
      'diagnose',
      'explain',
      'hint',
      'profile.update',
      'quiz.generate',
      'session.observe',
    ])
  })

  it('has a unique identifier', () => {
    const ids = ALL_STRATEGIES.map((strategy) => strategy.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declares a version and a purpose', () => {
    // The version is recorded against every call; without it, a change in behaviour months
    // later cannot be traced to the prompt change that caused it.
    for (const strategy of ALL_STRATEGIES) {
      expect(strategy.version, strategy.id).toMatch(/^\d+$/)
      expect(strategy.purpose.length, strategy.id).toBeGreaterThan(20)
    }
  })

  it('streams only when its output is prose', () => {
    // Structured output cannot be validated until it is complete, and validating it is the
    // entire point of having a schema.
    for (const strategy of prose) expect(strategy.streams, strategy.id).toBe(true)
    for (const strategy of structured) expect(strategy.streams, strategy.id).toBe(false)
  })
})

describe('every structured strategy', () => {
  it('names its schema with a stable identifier', () => {
    for (const strategy of structured) {
      expect(strategy.schemaName, strategy.id).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('has a schema that rejects an empty object', () => {
    // A schema that accepts `{}` would let an empty response through as valid.
    for (const strategy of structured) {
      expect(strategy.schema.safeParse({}).success, strategy.id).toBe(false)
    }
  })

  it('has a schema that rejects unknown fields', () => {
    // Strictness is what stops a model inventing a field — most importantly, one that would
    // write learner state.
    for (const strategy of structured) {
      const problems = strategy.schema.safeParse({ somethingInvented: true })
      expect(problems.success, strategy.id).toBe(false)
    }
  })

  it('declares what happens when the model cannot produce something valid', () => {
    // Either a deterministic fallback, or an explicit null meaning "there is no safe
    // substitute". Both are decisions; neither is an omission.
    for (const strategy of structured) {
      expect(() => strategy.safeFallback(fallbackInput()), strategy.id).not.toThrow()
    }
  })

  it('produces a fallback that satisfies its own schema, where it has one', () => {
    // A fallback that failed its own validation would be worse than none: it would be handed
    // to code expecting a valid value.
    for (const strategy of structured) {
      const fallback = strategy.safeFallback(fallbackInput())
      if (fallback === null) continue
      expect(strategy.schema.safeParse(fallback).success, strategy.id).toBe(true)
    }
  })

  it('accepts its own fallback as passing its invariants', () => {
    for (const strategy of structured) {
      const fallback = strategy.safeFallback(fallbackInput())
      if (fallback === null || fallback === undefined) continue
      expect(
        strategy.checkInvariants(fallback as never, fallbackInput(), strategyContext()),
        strategy.id,
      ).toEqual([])
    }
  })
})

/** Minimal input for each structured strategy, enough to ask it for a fallback. */
function fallbackInput(): never {
  const base = {
    learner: UNKNOWN_LEARNER,
    conceptId: 'for-loops-and-range',
    avoid: [],
    question: 'q',
    expected: null,
    learnerAnswer: 'a',
    attempts: [],
    brief: 'b',
    learnerCode: 'code',
    executionOutput: 'out',
    failedTests: [],
    learnerAttempt: null,
    depth: 1,
    previousHints: [],
    activityDescription: 'd',
    learnerResponse: 'r',
    wasCorrect: false,
    hintDepth: 0,
  }
  return base as never
}

describe('the solution heuristic', () => {
  it('flags a complete function definition', () => {
    expect(
      looksLikeASolution(
        'def count_evens(numbers):\n    total = 0\n    for n in numbers:\n        if n % 2 == 0:\n            total += 1\n    return total',
      ),
    ).toBe(true)
  })

  it('allows a short illustrative fragment', () => {
    // Hints are allowed to show a technique. The heuristic has to leave room for that or it
    // would reject every useful hint.
    expect(looksLikeASolution('Try `total += 1` inside the loop.')).toBe(false)
    expect(looksLikeASolution('Remember that `range(3)` gives 0, 1 and 2.')).toBe(false)
  })

  it('allows prose that merely mentions a function', () => {
    expect(looksLikeASolution('Your function needs to return the total rather than print it.')).toBe(
      false,
    )
  })

  it('is a backstop, not a guarantee', () => {
    // Stated plainly because it matters: a solution written some other way gets through, and
    // the policy instruction is the first line of defence. Claiming otherwise would be false.
    expect(looksLikeASolution('The answer is: add one to total each time n is even.')).toBe(false)
  })
})
