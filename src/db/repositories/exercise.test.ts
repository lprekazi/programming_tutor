import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EXERCISE_BANK_VERSION, getAuthoredExercise } from '@/domain/exercises/bank'
import { markPractical, type PracticalOutcome, type ReportedCheck } from '@/domain/exercises/mark'
import { bandOf } from '@/domain/learner-model/state'

import { closeDb, createDb, runMigrations, type Db } from '../client'
import {
  createExercise,
  readExercise,
  readGenerationLog,
  readSessionExercises,
  readUsedExerciseIds,
  recordExerciseHint,
  recordSubmissionFeedback,
  replaceCandidate,
  saveDraft,
  settleVerification,
  submitExerciseAttempt,
  type ExerciseCandidate,
} from './exercise-repository'
import {
  countEvidence,
  ensureLearner,
  readConceptState,
  readEvidenceFor,
  readRecentMisconceptions,
  resetLearner,
  saveConfidence,
  saveExperience,
  saveGoal,
} from './learner-repository'
import { finishTutorTurn, openSession, reserveActivityTurn } from './session-repository'

/**
 * Programming exercises against a real database.
 *
 * The guarantees under test are the ones the brief made non-negotiable: one piece of evidence per
 * exercise however the submission arrives; running code, editing it and opening hints change
 * nothing about the learner; hints attenuate a success and never turn it into a failure; and an
 * exercise, once accepted, stays the exercise the learner was given.
 */

const AT = Date.parse('2026-09-13T09:00:00.000Z')

const pass: ReportedCheck = { outcome: 'pass', error: null }
const fail: ReportedCheck = { outcome: 'fail', error: 'AssertionError' }

function ran(...checks: ReportedCheck[]): PracticalOutcome {
  return { kind: 'ran', checks, incomplete: false, crash: null }
}

describe('programming exercises', () => {
  let directory: string
  let db: Db

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tutor-m6-'))
    db = createDb(join(directory, 'tutor.db'))
    runMigrations(db)
    ensureLearner(db, AT)
    saveGoal(db, AT, { goal: 'Understand loops', interests: [] })
    saveExperience(db, AT, 'some-python')
    saveConfidence(db, AT, {})
  })

  afterEach(() => {
    closeDb(db)
    rmSync(directory, { recursive: true, force: true })
  })

  function authored(id: string): ExerciseCandidate {
    const exercise = getAuthoredExercise(id)
    if (exercise === null) throw new Error(`no exercise ${id}`)

    return {
      conceptId: exercise.conceptId,
      kind: exercise.kind,
      origin: 'authored',
      exerciseId: exercise.id,
      bankVersion: EXERCISE_BANK_VERSION,
      title: exercise.title,
      brief: exercise.brief,
      starterCode: exercise.starterCode,
      tests: exercise.tests,
      referenceSolution: exercise.referenceSolution,
      signals: exercise.signals,
      authoredHints: exercise.hints,
      difficulty: exercise.difficulty,
      selectionGround: 'A short exercise.',
      verification: 'verified',
      generationAttempt: 0,
      strategyId: null,
      strategyVersion: null,
      model: null,
    }
  }

  /** Sets an exercise the way the action does, including finishing the turn. */
  function setIn(sessionId: string, candidate: ExerciseCandidate) {
    const turn = reserveActivityTurn(db, sessionId, AT)
    const exercise = createExercise(db, { sessionId, turnId: turn.turnId, at: AT, ...candidate })
    finishTutorTurn(db, turn.turnId, 'complete', exercise.title, AT)
    return exercise
  }

  function submit(exerciseId: string, code: string, outcome: PracticalOutcome, at = AT + 100) {
    const exercise = readExercise(db, exerciseId)
    if (exercise === null) throw new Error('no exercise')
    const marking = markPractical({ outcome, tests: exercise.tests, signals: exercise.signals, code })
    return submitExerciseAttempt(db, { exerciseId, code, outcome, marking, at })
  }

  describe('setting an exercise', () => {
    it('sets one per position however many times it is asked', () => {
      const session = openSession(db, 'while-loops', 'r', AT)
      const turn = reserveActivityTurn(db, session.id, AT)

      const first = createExercise(db, { sessionId: session.id, turnId: turn.turnId, at: AT, ...authored('x-while-countdown') })
      const second = createExercise(db, { sessionId: session.id, turnId: turn.turnId, at: AT, ...authored('x-range-evens') })

      expect(second.id).toBe(first.id)
      expect(second.title).toBe('Counting down')
      expect(readSessionExercises(db, session.id)).toHaveLength(1)
    })

    it('remembers which authored exercises have been set, across sessions', () => {
      setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))

      expect(readUsedExerciseIds(db)).toEqual(['x-while-countdown'])
    })

    it('keeps an accepted exercise fixed', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))

      // Verified from the start, so no replacement is possible.
      expect(replaceCandidate(db, exercise.id, authored('x-range-evens'))).toBeNull()
      expect(readExercise(db, exercise.id)?.title).toBe('Counting down')
    })
  })

  describe('a generated candidate', () => {
    function generated(): ExerciseCandidate {
      return {
        ...authored('x-while-countdown'),
        origin: 'generated',
        exerciseId: null,
        bankVersion: null,
        signals: [],
        authoredHints: null,
        verification: 'unverified',
        generationAttempt: 1,
        strategyId: 'code.task.generate',
        strategyVersion: '2',
        model: 'mock',
      }
    }

    it('can be replaced while unverified, and is fixed once verified', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, generated())

      const regenerated = replaceCandidate(db, exercise.id, { ...generated(), title: 'A second go', generationAttempt: 2 })
      expect(regenerated?.title).toBe('A second go')

      expect(settleVerification(db, { id: exercise.id, verdict: 'verified', reason: null, at: AT })).toBe(true)
      expect(replaceCandidate(db, exercise.id, { ...generated(), title: 'Too late' })).toBeNull()
    })

    it('cannot have its verdict flipped by a second report', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, generated())

      settleVerification(db, { id: exercise.id, verdict: 'rejected', reason: 'reference-fails', at: AT })
      expect(settleVerification(db, { id: exercise.id, verdict: 'verified', reason: null, at: AT })).toBe(false)
      expect(readExercise(db, exercise.id)?.verification).toBe('rejected')
    })

    it('logs how verification went, without the content', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, generated())
      settleVerification(db, { id: exercise.id, verdict: 'rejected', reason: 'starter-solves', at: AT })

      expect(readGenerationLog(db, exercise.id)).toEqual([
        { attempt: 1, outcome: 'rejected', reason: 'starter-solves' },
      ])
    })

    it('refuses a submission before it has been verified', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, generated())

      expect(submit(exercise.id, 'x', ran(pass, pass, pass))).toEqual({
        status: 'refused',
        reason: 'not-verified',
      })
      expect(countEvidence(db)).toBe(0)
    })
  })

  describe('things that are not evidence', () => {
    it('saving what the learner has typed changes nothing about them', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      const before = readConceptState(db, 'while-loops')

      saveDraft(db, { id: exercise.id, code: 'def countdown(n):\n    return [n]\n', editedAt: AT + 1 })

      expect(readConceptState(db, 'while-loops')).toEqual(before)
      expect(countEvidence(db)).toBe(0)
    })

    it('taking every hint changes nothing about them', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      const before = readConceptState(db, 'while-loops')

      for (const depth of [1, 2, 3]) {
        recordExerciseHint(db, {
          exerciseId: exercise.id,
          depth,
          text: exercise.authoredHints?.[depth - 1] ?? '',
          source: 'authored',
          strategyId: null,
          strategyVersion: null,
          model: null,
          at: AT + depth,
        })
      }

      expect(readConceptState(db, 'while-loops')).toEqual(before)
      expect(countEvidence(db)).toBe(0)
    })
  })

  describe('keeping the learner’s code', () => {
    it('restores the latest code after a restart', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      saveDraft(db, { id: exercise.id, code: 'first', editedAt: AT + 1 })
      saveDraft(db, { id: exercise.id, code: 'second', editedAt: AT + 2 })

      closeDb(db)
      db = createDb(join(directory, 'tutor.db'))

      expect(readExercise(db, exercise.id)?.draftCode).toBe('second')
    })

    it('never lets an older save overwrite a newer one that arrived first', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))

      saveDraft(db, { id: exercise.id, code: 'newer', editedAt: AT + 20 })
      expect(saveDraft(db, { id: exercise.id, code: 'older', editedAt: AT + 10 })).toBe(false)

      expect(readExercise(db, exercise.id)?.draftCode).toBe('newer')
    })
  })

  describe('the hint ladder', () => {
    function hint(exerciseId: string, depth: number) {
      return recordExerciseHint(db, {
        exerciseId,
        depth,
        text: `hint ${String(depth)}`,
        source: 'authored',
        strategyId: null,
        strategyVersion: null,
        model: null,
        at: AT + depth,
      })
    }

    it('cannot be skipped', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))

      expect(hint(exercise.id, 2)).toEqual({ status: 'refused', reason: 'out-of-order' })
      expect(readExercise(db, exercise.id)?.hints).toHaveLength(0)
    })

    it('counts a rung once however many times it is asked for', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))

      hint(exercise.id, 1)
      const again = hint(exercise.id, 1)

      expect(again).toMatchObject({ status: 'given', created: false })
      expect(readExercise(db, exercise.id)?.hints).toHaveLength(1)
    })

    it('stops once the exercise has been passed', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      submit(exercise.id, 'solved', ran(pass, pass, pass))

      expect(hint(exercise.id, 1)).toEqual({ status: 'refused', reason: 'finished' })
    })
  })

  describe('one exercise, one piece of evidence', () => {
    it('records a passing first submission as evidence attributable to it', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))

      const result = submit(exercise.id, 'solved', ran(pass, pass, pass))

      if (result.status !== 'recorded') throw new Error('expected a recorded submission')
      expect(result.submission).toMatchObject({ ordinal: 1, state: 'passed', counted: true, hintsTaken: 0 })
      const [evidence] = readEvidenceFor(db, 'while-loops')
      expect(evidence).toMatchObject({ source: 'exercise', attemptId: result.submission.id, correct: true, hintDepth: 0 })
      // Said as what the learner did, not borrowed from a question's wording.
      expect(evidence?.reason).toContain('Solved an exercise on repeating while something is true, unaided')
    })

    it('records the same code twice as one submission and one piece of evidence', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))

      const first = submit(exercise.id, 'same code', ran(fail, pass, pass))
      const second = submit(exercise.id, 'same code', ran(fail, pass, pass), AT + 500)

      expect(second).toMatchObject({ status: 'recorded', created: false, evidence: null })
      expect(first.status === 'recorded' && second.status === 'recorded' && second.submission.id).toBe(
        first.status === 'recorded' ? first.submission.id : 'none',
      )
      expect(countEvidence(db)).toBe(1)
      expect(readExercise(db, exercise.id)?.submissions).toHaveLength(1)
    })

    it('marks a later submission but does not count it', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))

      submit(exercise.id, 'wrong', ran(fail, fail, pass))
      const fixed = submit(exercise.id, 'right', ran(pass, pass, pass), AT + 500)

      expect(fixed).toMatchObject({ status: 'recorded', created: true, evidence: null })
      expect(fixed.status === 'recorded' && fixed.submission).toMatchObject({ ordinal: 2, state: 'passed', counted: false })
      expect(countEvidence(db)).toBe(1)
    })

    it('refuses anything after the exercise has been passed', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      submit(exercise.id, 'right', ran(pass, pass, pass))

      expect(submit(exercise.id, 'something else', ran(pass, pass, pass))).toEqual({
        status: 'refused',
        reason: 'already-passed',
      })
    })

    it('keeps an unmarked submission, records nothing, and leaves the measurement for later', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      const before = readConceptState(db, 'while-loops')

      const timedOut = submit(exercise.id, 'while True: pass', { kind: 'timeout' })
      expect(timedOut).toMatchObject({ status: 'recorded', evidence: null })
      expect(timedOut.status === 'recorded' && timedOut.submission).toMatchObject({ state: 'unmarked', counted: false })
      expect(readConceptState(db, 'while-loops')).toEqual(before)

      // A run that never finished demonstrated nothing, so it does not use up the one submission
      // that can count.
      const next = submit(exercise.id, 'fixed', ran(pass, pass, pass), AT + 500)
      expect(next.status === 'recorded' && next.submission.counted).toBe(true)
      expect(countEvidence(db)).toBe(1)
    })

    /*
     * M6 review finding F-08. The same code was the same submission even when that submission
     * had timed out, so correct code that ran out of time on a slow machine could never be marked
     * without a meaningless edit.
     */
    it('lets the same code be marked after it timed out, counting it once', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))

      submit(exercise.id, 'the same code', { kind: 'timeout' })
      const retried = submit(exercise.id, 'the same code', ran(pass, pass, pass), AT + 500)

      expect(retried.status === 'recorded' && retried.submission).toMatchObject({ state: 'passed', counted: true })
      expect(readExercise(db, exercise.id)?.submissions).toHaveLength(1)
      expect(countEvidence(db)).toBe(1)

      // And a further replay of it changes nothing.
      submit(exercise.id, 'the same code', ran(pass, pass, pass), AT + 900)
      expect(countEvidence(db)).toBe(1)
    })

    it('records a matched misconception only from the counted submission', () => {
      const exercise = setIn(openSession(db, 'loop-accumulation', 'r', AT).id, authored('x-loop-sum-to'))

      submit(exercise.id, 'range(n)', ran(fail, fail, pass))

      expect(readRecentMisconceptions(db)).toEqual(['range-endpoint-inclusive'])
    })
  })

  describe('hints and evidence (ADR-0005)', () => {
    function hinted(sessionConcept: 'while-loops', depth: number) {
      const exercise = setIn(openSession(db, sessionConcept, 'r', AT).id, authored('x-while-countdown'))
      for (let rung = 1; rung <= depth; rung += 1) {
        recordExerciseHint(db, {
          exerciseId: exercise.id,
          depth: rung,
          text: `hint ${String(rung)}`,
          source: 'authored',
          strategyId: null,
          strategyVersion: null,
          model: null,
          at: AT + rung,
        })
      }
      return exercise
    }

    it('records the true number of hints taken, on the submission and on the evidence', () => {
      const exercise = hinted('while-loops', 2)

      const result = submit(exercise.id, 'solved', ran(pass, pass, pass))

      expect(result.status === 'recorded' && result.submission.hintsTaken).toBe(2)
      expect(readEvidenceFor(db, 'while-loops')[0]?.hintDepth).toBe(2)
    })

    it('never lowers the estimate or the band for a success reached with every hint', () => {
      const exercise = hinted('while-loops', 3)
      const before = readConceptState(db, 'while-loops')

      submit(exercise.id, 'solved', ran(pass, pass, pass))
      const after = readConceptState(db, 'while-loops')

      expect(after.theta).toBeGreaterThanOrEqual(before.theta)
      const order = ['not-started', 'needs-review', 'developing', 'secure']
      expect(order.indexOf(bandOf(after))).toBeGreaterThanOrEqual(order.indexOf(bandOf(before)))
    })

    it('counts a success with hints for less than the same success without', () => {
      const unaided = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      submit(unaided.id, 'solved', ran(pass, pass, pass))
      const unaidedGain = (readEvidenceFor(db, 'while-loops')[0]?.posteriorTheta ?? 0) - (readEvidenceFor(db, 'while-loops')[0]?.priorTheta ?? 0)

      resetLearner(db)
      ensureLearner(db, AT)
      saveExperience(db, AT, 'some-python')
      saveConfidence(db, AT, {})

      const withHints = hinted('while-loops', 3)
      submit(withHints.id, 'solved', ran(pass, pass, pass))
      const hintedGain = (readEvidenceFor(db, 'while-loops')[0]?.posteriorTheta ?? 0) - (readEvidenceFor(db, 'while-loops')[0]?.priorTheta ?? 0)

      expect(hintedGain).toBeGreaterThan(0)
      expect(hintedGain).toBeLessThan(unaidedGain)
    })

    it('ignores hints taken after the submission that counted', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      submit(exercise.id, 'wrong', ran(fail, fail, pass))

      recordExerciseHint(db, {
        exerciseId: exercise.id,
        depth: 1,
        text: 'hint',
        source: 'authored',
        strategyId: null,
        strategyVersion: null,
        model: null,
        at: AT + 200,
      })

      expect(readEvidenceFor(db, 'while-loops')[0]?.hintDepth).toBe(0)
    })
  })

  describe('feedback', () => {
    it('attaches notes without touching the marking or the evidence', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      const result = submit(exercise.id, 'wrong', ran(fail, fail, pass))
      if (result.status !== 'recorded') throw new Error('expected a submission')
      const evidenceBefore = readEvidenceFor(db, 'while-loops')

      recordSubmissionFeedback(db, {
        submissionId: result.submission.id,
        status: 'given',
        feedback: { summary: 'It works perfectly.' },
        strategyId: 'code.feedback',
        strategyVersion: '2',
        model: 'mock',
      })

      const stored = readExercise(db, exercise.id)?.submissions[0]
      expect(stored).toMatchObject({ state: 'failed', feedbackStatus: 'given' })
      expect(readEvidenceFor(db, 'while-loops')).toEqual(evidenceBefore)
    })

    it('keeps the deterministic result when feedback is unavailable', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      const result = submit(exercise.id, 'solved', ran(pass, pass, pass))
      if (result.status !== 'recorded') throw new Error('expected a submission')

      recordSubmissionFeedback(db, {
        submissionId: result.submission.id,
        status: 'unavailable',
        feedback: null,
        strategyId: null,
        strategyVersion: null,
        model: null,
      })

      expect(readExercise(db, exercise.id)?.submissions[0]).toMatchObject({
        state: 'passed',
        counted: true,
        feedbackStatus: 'unavailable',
      })
      expect(countEvidence(db)).toBe(1)
    })
  })

  describe('resetting', () => {
    it('removes exercises, hints, submissions and logs with the learner', () => {
      const exercise = setIn(openSession(db, 'while-loops', 'r', AT).id, authored('x-while-countdown'))
      submit(exercise.id, 'solved', ran(pass, pass, pass))

      resetLearner(db)

      expect(readExercise(db, exercise.id)).toBeNull()
      expect(readUsedExerciseIds(db)).toEqual([])
    })
  })
})
