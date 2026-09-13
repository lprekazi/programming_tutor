import { describe, expect, it } from 'vitest'

import { getAuthoredExercise } from './bank'
import { PENDING_NOTES_GIVE_UP_MS, viewOfExercise, type ExerciseSource } from './view'

/**
 * The one assembly path from a stored exercise to the browser.
 *
 * Asserted over the serialised result, so a field added to the view later cannot carry the
 * reference solution or the marking's signals out by being forgotten.
 */

const NOW = Date.UTC(2026, 8, 13, 12)

function source(submissions: ExerciseSource['submissions'] = []): ExerciseSource {
  const authored = getAuthoredExercise('x-loop-sum-to')
  if (authored === null) throw new Error('no exercise')

  return {
    id: 'ex-1',
    conceptId: authored.conceptId,
    kind: authored.kind,
    origin: 'authored',
    title: authored.title,
    brief: authored.brief,
    starterCode: authored.starterCode,
    tests: authored.tests,
    referenceSolution: authored.referenceSolution,
    selectionGround: 'Builds on what you have shown.',
    draftCode: null,
    hints: [],
    submissions,
  }
}

function submission(overrides: Partial<ExerciseSource['submissions'][number]> = {}): ExerciseSource['submissions'][number] {
  return {
    id: 's-1',
    ordinal: 1,
    state: 'failed',
    passedChecks: 1,
    totalChecks: 3,
    unmarkedReason: null,
    misconceptions: ['range-endpoint-inclusive'],
    counted: true,
    hintsTaken: 0,
    feedbackStatus: 'given',
    feedback: { summary: 'Close.', observations: [], nextStep: 'Trace n = 1.' },
    outcome: { kind: 'ran', checks: [{ outcome: 'fail', error: 'AssertionError' }], incomplete: false, crash: null },
    submittedAt: NOW,
    ...overrides,
  }
}

describe('viewOfExercise', () => {
  it('never carries the reference solution or the signals to the browser', () => {
    const exercise = source([submission()])
    const serialised = JSON.stringify(viewOfExercise(exercise, NOW))

    expect(serialised).not.toContain('referenceSolution')
    expect(serialised).not.toContain(JSON.stringify(exercise.referenceSolution).slice(1, -1))
    expect(serialised).not.toContain('witness')
    expect(serialised).not.toContain('codeShows')
    // Nor which misconception the marking read into the result.
    expect(serialised).not.toContain('range-endpoint-inclusive')
  })

  it('opens the editor on the draft where there is one, and the starter otherwise', () => {
    expect(viewOfExercise(source(), NOW).code).toBe(source().starterCode)
    expect(viewOfExercise({ ...source(), draftCode: 'my draft' }, NOW).code).toBe('my draft')
  })

  /*
   * M6 review finding F-17. Notes are written inside the submission request; a row still pending
   * long after that request must have ended belongs to one that died, and waiting for it forever
   * helps nobody.
   */
  it('says notes are still coming only while they plausibly are', () => {
    const pending = submission({ feedbackStatus: 'pending', feedback: null, submittedAt: NOW - 10_000 })
    const abandoned = submission({ feedbackStatus: 'pending', feedback: null, submittedAt: NOW - PENDING_NOTES_GIVE_UP_MS - 1 })

    expect(viewOfExercise(source([pending]), NOW).submissions[0]?.feedbackStatus).toBe('pending')
    expect(viewOfExercise(source([abandoned]), NOW).submissions[0]?.feedbackStatus).toBe('unavailable')
  })

  it('reads stored JSON defensively rather than trusting its shape', () => {
    const odd = submission({ feedback: { summary: 42 }, outcome: 'not an outcome' })
    const view = viewOfExercise(source([odd]), NOW).submissions[0]

    expect(view?.feedback).toBeNull()
    expect(view?.checks).toEqual([])
  })

  it('is finished once a submission has passed', () => {
    expect(viewOfExercise(source([submission()]), NOW).finished).toBe(false)
    expect(viewOfExercise(source([submission({ state: 'passed', passedChecks: 3 })]), NOW).finished).toBe(true)
  })
})
