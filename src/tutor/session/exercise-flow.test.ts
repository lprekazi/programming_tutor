import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb, createDb, runMigrations, type Db } from '@/db/client'
import {
  readGenerationLog,
  readSessionExercises,
  replaceCandidate,
  type ExerciseCandidate,
  type ExerciseRecord,
} from '@/db/repositories/exercise-repository'
import {
  countEvidence,
  ensureLearner,
  saveConfidence,
  saveExperience,
  saveGoal,
} from '@/db/repositories/learner-repository'
import { appendLearnerTurn, openSession } from '@/db/repositories/session-repository'
import { getAuthoredExercise } from '@/domain/exercises/bank'
import type { PracticalOutcome } from '@/domain/exercises/mark'
import { CODE_FEEDBACK_AGREEING, CODE_TASK_FOR_REQUESTED_CONCEPT, REFUSED } from '@/llm/fixtures'
import { MockProvider, type MockResponse } from '@/llm/mock-provider'

/**
 * The exercise actions, end to end on the server, against a real database.
 *
 * What the browser does is stood in for: its verdicts on a generated candidate and its report of
 * running the checks are supplied directly. Everything the server decides — when to set an
 * exercise, what to do with a rejected candidate, what the submission is worth, and what happens
 * when the tutor cannot write notes — runs for real.
 */

const state: { db: Db | null; provider: MockProvider | null } = { db: null, provider: null }

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/db/instance', () => ({
  getDb: () => {
    if (state.db === null) throw new Error('no test database')
    return state.db
  },
}))
vi.mock('@/llm/resolve', () => ({
  resolveProvider: () => (state.provider === null ? null : { provider: state.provider, model: 'mock' }),
}))

const actions = await import('../../../app/exercise-actions')

const pass = { outcome: 'pass', error: null } as const
const fail = { outcome: 'fail', error: 'AssertionError' } as const

/** A stored exercise as a candidate that could replace it. */
function candidateOf(record: ExerciseRecord): ExerciseCandidate {
  return {
    conceptId: record.conceptId,
    kind: record.kind,
    origin: record.origin,
    exerciseId: record.exerciseId,
    bankVersion: null,
    title: record.title,
    brief: record.brief,
    starterCode: record.starterCode,
    tests: record.tests,
    referenceSolution: record.referenceSolution,
    signals: record.signals,
    authoredHints: record.authoredHints,
    difficulty: record.difficulty,
    selectionGround: record.selectionGround,
    verification: record.verification,
    generationAttempt: record.generationAttempt,
    strategyId: record.strategyId,
    strategyVersion: record.strategyVersion,
    model: record.model,
  }
}

function ran(...checks: (typeof pass | typeof fail)[]): PracticalOutcome {
  return { kind: 'ran', checks, incomplete: false, crash: null }
}

describe('the exercise actions', () => {
  let directory: string
  const now = Date.now()

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tutor-m6-flow-'))
    state.db = createDb(join(directory, 'tutor.db'))
    runMigrations(state.db)
    ensureLearner(state.db, now)
    saveGoal(state.db, now, { goal: 'Understand loops', interests: [] })
    saveExperience(state.db, now, 'some-python')
    saveConfidence(state.db, now, {})
    state.provider = null
  })

  afterEach(() => {
    if (state.db !== null) closeDb(state.db)
    state.db = null
    rmSync(directory, { recursive: true, force: true })
  })

  /** A session on `conceptId` with one learner turn, so it is not too early for practice. */
  function sessionOn(conceptId: 'while-loops' | 'booleans' | 'loop-control') {
    const db = state.db
    if (db === null) throw new Error('no db')
    const session = openSession(db, conceptId, 'r', now)
    appendLearnerTurn(db, session.id, 'Can I try something?', now)
    return session
  }

  function providerWith(...responses: readonly [string, MockResponse][]): MockProvider {
    const provider = new MockProvider()
    for (const [strategy, response] of responses) provider.on(strategy, response)
    return provider
  }

  describe('setting', () => {
    it('sets an authored exercise without any provider', async () => {
      const session = sessionOn('while-loops')

      const result = await actions.askExercise(session.id)

      expect(result.status).toBe('set')
      expect(readSessionExercises(state.db as Db, session.id)[0]?.exerciseId).toBe('x-while-countdown')
    })

    it('holds off before anything has been said', async () => {
      const db = state.db as Db
      const session = openSession(db, 'while-loops', 'r', now)

      expect(await actions.askExercise(session.id)).toEqual({ status: 'held', because: 'too-early' })
    })

    it('does not set a second exercise over one that has not been submitted', async () => {
      const session = sessionOn('while-loops')
      await actions.askExercise(session.id)

      expect(await actions.askExercise(session.id)).toEqual({ status: 'held', because: 'finish-open-one' })
    })
  })

  describe('a generated exercise', () => {
    it('is not shown until the browser has verified it, and carries its bundle only for that', async () => {
      state.provider = providerWith(['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT])
      const session = sessionOn('booleans')

      const result = await actions.askExercise(session.id)

      if (result.status !== 'verify') throw new Error(`expected verification, got ${result.status}`)
      expect(result.bundle.referenceSolution).toContain('def largest')
      // Not set yet: nothing a learner could read, and nothing a submission could be made against.
      expect(await actions.readExerciseView(result.exerciseId)).toBeNull()

      const accepted = await actions.recordExerciseVerification(result.exerciseId, result.bundle.candidate, { status: 'verified' })
      expect(accepted).toEqual({ status: 'set', exerciseId: result.exerciseId })
      expect(readGenerationLog(state.db as Db, result.exerciseId)).toEqual([
        { attempt: 1, outcome: 'verified', reason: null },
      ])
    })

    it('is regenerated once when the browser rejects it, and the replacement is verified in turn', async () => {
      state.provider = providerWith(
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
      )
      const session = sessionOn('booleans')
      const first = await actions.askExercise(session.id)
      if (first.status !== 'verify') throw new Error('expected verification')

      const second = await actions.recordExerciseVerification(first.exerciseId, first.bundle.candidate, {
        status: 'rejected',
        reason: 'starter-solves',
      })

      if (second.status !== 'verify') throw new Error(`expected a second verification, got ${second.status}`)
      // The same position in the conversation, not a second exercise.
      expect(second.exerciseId).toBe(first.exerciseId)
      expect(readSessionExercises(state.db as Db, session.id)[0]?.generationAttempt).toBe(2)

      // The regeneration prompt says why, in this application's words.
      const prompt = state.provider.calls.at(-1)?.prompt ?? ''
      expect(prompt).toContain('its starter code already passed every test')

      expect(await actions.recordExerciseVerification(first.exerciseId, second.bundle.candidate, { status: 'verified' })).toMatchObject({
        status: 'set',
      })
    })

    it('falls back to an authored exercise the concept builds on after a second rejection', async () => {
      state.provider = providerWith(
        ['code.feedback', CODE_FEEDBACK_AGREEING],
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
      )
      // loop-control builds on while loops and for loops, which have authored exercises, and has
      // one of its own — used up first so that generation is what happens.
      const db = state.db as Db
      const earlier = sessionOn('loop-control')
      await actions.askExercise(earlier.id)
      const [used] = readSessionExercises(db, earlier.id)
      if (used === undefined) throw new Error('expected the authored loop-control exercise')
      await actions.submitExercise(used.id, getAuthoredExercise('x-first-negative')?.referenceSolution ?? '', ran(pass, pass, pass), '')

      const first = await actions.askExercise(earlier.id)
      if (first.status !== 'verify') throw new Error(`expected generation, got ${first.status}`)
      const second = await actions.recordExerciseVerification(first.exerciseId, first.bundle.candidate, { status: 'rejected', reason: 'reference-fails' })
      if (second.status !== 'verify') throw new Error('expected a regeneration')

      const final = await actions.recordExerciseVerification(first.exerciseId, second.bundle.candidate, { status: 'rejected', reason: 'timeout' })

      expect(final).toEqual({ status: 'set', exerciseId: first.exerciseId })
      const replaced = readSessionExercises(db, earlier.id).find((exercise) => exercise.id === first.exerciseId)
      expect(replaced?.origin).toBe('authored')
      expect(['for-loops-and-range', 'while-loops', 'if-statements']).toContain(replaced?.conceptId)
      expect(replaced?.selectionGround).toContain('which this builds on')
      expect(readGenerationLog(db, first.exerciseId).map((entry) => entry.outcome)).toEqual([
        'rejected',
        'rejected',
        'fallback',
      ])
    })

    /*
     * M6 review finding F-04. Two verification flows on one row — a reload during a regeneration —
     * used to let a "verified" for an older bundle settle whichever candidate was stored by then,
     * which nobody had run, and let both flows regenerate.
     */
    it('never settles a candidate that was not the one checked', async () => {
      state.provider = providerWith(
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
      )
      const session = sessionOn('booleans')
      const first = await actions.askExercise(session.id)
      if (first.status !== 'verify') throw new Error('expected verification')

      // The stored candidate is replaced, as a regeneration would.
      const db = state.db as Db
      const [stored] = readSessionExercises(db, session.id)
      if (stored === undefined) throw new Error('no candidate')
      replaceCandidate(db, stored.id, { ...candidateOf(stored), title: 'A different candidate', referenceSolution: 'def largest(numbers):\n    return max(numbers)\n' })

      // A verdict about the old bundle does not settle the new candidate: it is handed back to check.
      const stale = await actions.recordExerciseVerification(first.exerciseId, first.bundle.candidate, { status: 'verified' })

      expect(stale.status).toBe('verify')
      expect(stale.status === 'verify' && stale.bundle.referenceSolution).toContain('return max(numbers)')
      expect(await actions.readExerciseView(first.exerciseId)).toBeNull()
    })

    it('lets only one of two concurrent rejections regenerate', async () => {
      state.provider = providerWith(
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
      )
      const session = sessionOn('booleans')
      const first = await actions.askExercise(session.id)
      if (first.status !== 'verify') throw new Error('expected verification')

      const [a, b] = await Promise.all([
        actions.recordExerciseVerification(first.exerciseId, first.bundle.candidate, { status: 'rejected', reason: 'timeout' }),
        actions.recordExerciseVerification(first.exerciseId, first.bundle.candidate, { status: 'rejected', reason: 'timeout' }),
      ])

      expect(readSessionExercises(state.db as Db, session.id)[0]?.generationAttempt).toBe(2)
      // Both flows are told to check the same, current candidate.
      if (a.status !== 'verify' || b.status !== 'verify') throw new Error('expected verification')
      expect(a.bundle.candidate).toBe(b.bundle.candidate)
    })

    /*
     * M6 review finding F-05. After a candidate was rejected with nothing to fall back on, every
     * later request reused the same turn, found the rejected exercise on it, and failed again.
     */
    it('frees the position after a total failure, so the next request starts afresh', async () => {
      state.provider = providerWith(
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
      )
      const session = sessionOn('booleans')
      const first = await actions.askExercise(session.id)
      if (first.status !== 'verify') throw new Error('expected verification')
      const second = await actions.recordExerciseVerification(first.exerciseId, first.bundle.candidate, { status: 'rejected', reason: 'reference-fails' })
      if (second.status !== 'verify') throw new Error('expected a regeneration')
      expect((await actions.recordExerciseVerification(first.exerciseId, second.bundle.candidate, { status: 'rejected', reason: 'reference-fails' })).status).toBe('unavailable')

      const retry = await actions.askExercise(session.id)

      if (retry.status !== 'verify') throw new Error(`expected a fresh candidate, got ${retry.status}`)
      expect(retry.exerciseId).not.toBe(first.exerciseId)
    })

    it('never sets a candidate Python could not check, and falls back instead', async () => {
      state.provider = providerWith(['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT])
      const session = sessionOn('booleans')
      const first = await actions.askExercise(session.id)
      if (first.status !== 'verify') throw new Error('expected verification')

      const result = await actions.recordExerciseVerification(first.exerciseId, first.bundle.candidate, { status: 'unavailable' })

      // booleans builds on variables-and-assignment only, which has no authored exercise, so there
      // is nothing to fall back on: said plainly, and nothing unverified is left on the page.
      expect(result.status).toBe('unavailable')
      expect(await actions.readExerciseView(first.exerciseId)).toBeNull()
    })

    it('refuses a verdict it cannot read', async () => {
      state.provider = providerWith(['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT])
      const session = sessionOn('booleans')
      const first = await actions.askExercise(session.id)
      if (first.status !== 'verify') throw new Error('expected verification')

      expect((await actions.recordExerciseVerification(first.exerciseId, first.bundle.candidate, { status: 'verified', extra: true })).status).toBe(
        'unavailable',
      )
      expect(await actions.readExerciseView(first.exerciseId)).toBeNull()
    })
  })

  describe('submitting', () => {
    async function setWhileLoops() {
      const session = sessionOn('while-loops')
      await actions.askExercise(session.id)
      const [exercise] = readSessionExercises(state.db as Db, session.id)
      if (exercise === undefined) throw new Error('no exercise')
      return exercise
    }

    it('marks from the checks, not the model, and the notes agree with them', async () => {
      state.provider = providerWith(['code.feedback', CODE_FEEDBACK_AGREEING])
      const exercise = await setWhileLoops()

      const result = await actions.submitExercise(exercise.id, 'def countdown(n):\n    return []\n', ran(fail, fail, pass), '')

      if (result.status !== 'recorded') throw new Error('expected a recorded submission')
      const latest = result.view.submissions.at(-1)
      expect(latest).toMatchObject({ state: 'failed', feedbackStatus: 'given', counted: true })
      expect(latest?.feedback?.summary).toContain('do not pass')
      expect(countEvidence(state.db as Db)).toBe(1)
    })

    it('keeps the result and the evidence when the notes cannot be written', async () => {
      state.provider = providerWith(['code.feedback', REFUSED], ['code.feedback', REFUSED])
      const exercise = await setWhileLoops()

      const result = await actions.submitExercise(exercise.id, getAuthoredExercise('x-while-countdown')?.referenceSolution ?? '', ran(pass, pass, pass), '')

      if (result.status !== 'recorded') throw new Error('expected a recorded submission')
      expect(result.view.submissions.at(-1)).toMatchObject({ state: 'passed', counted: true, feedbackStatus: 'unavailable' })
      expect(countEvidence(state.db as Db)).toBe(1)
    })

    it('never lets a failure while writing notes undo a submission that was recorded', async () => {
      // A provider that throws rather than reporting a failure: not what the contract allows, and
      // exactly why the action does not rely on it.
      const throwing = new MockProvider()
      state.provider = throwing
      const exercise = await setWhileLoops()

      const result = await actions.submitExercise(exercise.id, 'def countdown(n):\n    return []\n', ran(fail, fail, pass), '')

      if (result.status !== 'recorded') throw new Error(`expected a recorded submission, got ${result.status}`)
      expect(result.view.submissions.at(-1)).toMatchObject({ state: 'failed', counted: true, feedbackStatus: 'unavailable' })
      expect(countEvidence(state.db as Db)).toBe(1)
    })

    it('refuses a report that was not produced by running the checks', async () => {
      const exercise = await setWhileLoops()

      const forged = { kind: 'ran', checks: [pass, pass, pass], incomplete: false, crash: null, verdict: 'correct' }
      expect((await actions.submitExercise(exercise.id, 'x = 1', forged, '')).status).toBe('rejected')
      expect(countEvidence(state.db as Db)).toBe(0)
    })

    it('never sends the reference solution back, in any view it returns', async () => {
      state.provider = providerWith(['code.feedback', CODE_FEEDBACK_AGREEING])
      const exercise = await setWhileLoops()
      const reference = getAuthoredExercise('x-while-countdown')?.referenceSolution ?? ''

      const submitted = await actions.submitExercise(exercise.id, 'def countdown(n):\n    return [n]\n', ran(fail, pass, fail), '')
      const hint = await actions.askExerciseHint(exercise.id, 1, null)
      const view = await actions.readExerciseView(exercise.id)

      for (const returned of [submitted, hint, view]) {
        expect(JSON.stringify(returned)).not.toContain(JSON.stringify(reference).slice(1, -1))
        expect(JSON.stringify(returned)).not.toContain('referenceSolution')
      }
    })
  })

  describe('hints', () => {
    it('come from the authored ladder with no provider, in order', async () => {
      const session = sessionOn('while-loops')
      await actions.askExercise(session.id)
      const [exercise] = readSessionExercises(state.db as Db, session.id)
      if (exercise === undefined) throw new Error('no exercise')

      expect(await actions.askExerciseHint(exercise.id, 2, null)).toMatchObject({ status: 'unavailable' })
      const first = await actions.askExerciseHint(exercise.id, 1, null)
      expect(first).toEqual({ status: 'given', depth: 1, text: getAuthoredExercise('x-while-countdown')?.hints[0] })
      expect(countEvidence(state.db as Db)).toBe(0)
    })

    it('are refused for a generated exercise when the model would give the solution away', async () => {
      const reference = 'def largest(numbers):\n    best = numbers[0]\n    for number in numbers:\n        if number > best:\n            best = number\n    return best\n'
      const leaking: MockResponse = {
        kind: 'value',
        value: {
          text: 'Try this: best = numbers[0], then for number in numbers: if number > best: best = number, and finally return best',
          kind: 'specific',
        },
      }
      state.provider = providerWith(
        ['code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT],
        ['hint', leaking],
        ['hint', leaking],
      )
      const session = sessionOn('booleans')
      const first = await actions.askExercise(session.id)
      if (first.status !== 'verify') throw new Error('expected verification')
      expect(first.bundle.referenceSolution).toBe(reference)
      await actions.recordExerciseVerification(first.exerciseId, first.bundle.candidate, { status: 'verified' })

      const hint = await actions.askExerciseHint(first.exerciseId, 1, null)

      expect(hint).toEqual({ status: 'unavailable', message: 'A hint could not be prepared just now.' })
    })
  })
})
