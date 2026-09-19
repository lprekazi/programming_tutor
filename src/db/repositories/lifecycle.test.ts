import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EXERCISE_BANK_VERSION, getAuthoredExercise } from '@/domain/exercises/bank'
import { markPractical, type PracticalOutcome } from '@/domain/exercises/mark'
import { buildExportDocument, EXPORT_SCHEMA, EXPORT_SCHEMA_VERSION } from '@/domain/export/document'

import { closeDb, createDb, runMigrations, type Db } from '../client'
import { createActivity, readSessionActivities, recordHint, submitAttempt } from './activity-repository'
import { completeDiagnostic, openDiagnostic, submitAnswer } from './diagnostic-repository'
import { readExportInput } from './export-repository'
import {
  createExercise,
  readExercise,
  readSessionExercises,
  recordExerciseHint,
  saveDraft,
  submitExerciseAttempt,
  type ExerciseCandidate,
} from './exercise-repository'
import {
  countEvidence,
  ensureLearner,
  readConceptState,
  readProfile,
  saveConfidence,
  saveExperience,
  saveGoal,
} from './learner-repository'
import { generationIsCurrent, readDataGeneration, readLastResetAt, resetEverything } from './meta-repository'
import {
  finishTutorTurn,
  openSession,
  readAllSessions,
  readSession,
  reserveActivityTurn,
  reserveTutorTurn,
} from './session-repository'

/**
 * The learner's data over time: restarting the application, deleting everything on purpose,
 * and taking a copy away.
 *
 * Everything here goes through a real database file rather than an in-memory one, because two
 * of the three questions are about what survives the process — and a test against a connection
 * that never closes cannot answer that.
 */

const AT = Date.parse('2026-09-19T09:00:00.000Z')
const LATER = AT + 60 * 60 * 1000

describe('the learner’s data over time', () => {
  let directory: string
  let path: string
  let db: Db

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tutor-m7-'))
    path = join(directory, 'tutor.db')
    db = createDb(path)
    runMigrations(db)
  })

  afterEach(() => {
    closeDb(db)
    rmSync(directory, { recursive: true, force: true })
  })

  /** Closes the database and opens the file again, as restarting the application would. */
  function restart(): void {
    closeDb(db)
    db = createDb(path)
    runMigrations(db)
  }

  function onboard(): void {
    ensureLearner(db, AT)
    saveGoal(db, AT, { goal: 'I want to automate a spreadsheet at work.', interests: ['loops'] })
    saveExperience(db, AT, 'some-python')
    saveConfidence(db, AT, { loops: 'some', fundamentals: 'comfortable' })
  }

  function answerDiagnostic(): void {
    const progress = openDiagnostic(db, AT)
    submitAnswer(db, {
      sessionId: progress.sessionId,
      itemId: 'print-value',
      answer: '1',
      correct: true,
      verdictSource: 'deterministic',
      misconceptions: [],
      at: AT,
    })
    completeDiagnostic(db, progress.sessionId, 'Enough asked.', AT)
  }

  /** A session with an opening turn, an answered question and a solved exercise. */
  function study(): { readonly sessionId: string } {
    const session = openSession(db, 'while-loops', 'Starting while loops.', AT)
    const opening = reserveTutorTurn(db, session.id, { strategyId: 's', strategyVersion: '1', model: 'mock' }, AT)
    finishTutorTurn(db, opening.turnId, 'complete', 'A while loop repeats while something is true.', AT)

    const questionTurn = reserveActivityTurn(db, session.id, AT)
    const activity = createActivity(db, {
      sessionId: session.id,
      turnId: questionTurn.turnId,
      conceptId: 'while-loops',
      kind: 'choice',
      itemId: 'p-while-accumulate',
      origin: 'authored',
      prompt: 'When does a while loop stop?',
      code: null,
      options: ['When its condition is false', 'After ten times'],
      correctIndex: 0,
      optionMisconceptions: [null, 'accumulator-overwritten'],
      expectedOutput: null,
      knownWrongAnswers: null,
      expectedPoints: null,
      explanation: 'It checks the condition before every pass.',
      selectionGround: 'Nothing has been demonstrated here yet.',
      probesMisconception: null,
      strategyId: null,
      strategyVersion: null,
      model: null,
      at: AT,
    })
    finishTutorTurn(db, questionTurn.turnId, 'complete', 'Asked a question.', AT)
    recordHint(db, {
      activityId: activity.id,
      depth: 1,
      text: 'Think about the condition.',
      strategyId: null,
      strategyVersion: null,
      model: null,
      at: AT,
    })
    submitAttempt(db, {
      activityId: activity.id,
      response: '0',
      marking: { kind: 'marked', correct: true, partial: false, source: 'deterministic', misconceptions: [] },
      feedback: 'That is right.',
      hintDepth: 1,
      at: AT,
    })

    const exerciseTurn = reserveActivityTurn(db, session.id, LATER)
    const exercise = createExercise(db, {
      sessionId: session.id,
      turnId: exerciseTurn.turnId,
      at: LATER,
      ...authored('x-while-countdown'),
    })
    finishTutorTurn(db, exerciseTurn.turnId, 'complete', exercise.title, LATER)
    saveDraft(db, { id: exercise.id, code: 'def countdown(n):\n    pass\n', editedAt: LATER })
    recordExerciseHint(db, {
      exerciseId: exercise.id,
      depth: 1,
      text: 'Start from n and count down.',
      source: 'authored',
      strategyId: null,
      strategyVersion: null,
      model: null,
      at: LATER,
    })
    submitCode(exercise.id, 'def countdown(n):\n    return []\n', ran('fail', 'fail', 'fail'))

    return { sessionId: session.id }
  }

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
      selectionGround: 'A short exercise on while loops.',
      verification: 'verified',
      generationAttempt: 0,
      strategyId: null,
      strategyVersion: null,
      model: null,
    }
  }

  function ran(...outcomes: ('pass' | 'fail')[]): PracticalOutcome {
    return {
      kind: 'ran',
      checks: outcomes.map((outcome) => ({ outcome, error: outcome === 'fail' ? 'AssertionError' : null })),
      incomplete: false,
      crash: null,
    }
  }

  function submitCode(exerciseId: string, code: string, outcome: PracticalOutcome): void {
    const exercise = readExercise(db, exerciseId)
    if (exercise === null) throw new Error('no exercise')
    const marking = markPractical({ outcome, tests: exercise.tests, signals: exercise.signals, code })
    submitExerciseAttempt(db, { exerciseId, code, outcome, marking, at: LATER })
  }

  /** Every table's row count, so nothing can be left behind unnoticed. */
  function rowCounts(): Record<string, number> {
    const names = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'")
      .all() as { name: string }[]

    const counts: Record<string, number> = {}
    for (const { name } of names) {
      const [row] = db.$client.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).all() as { n: number }[]
      counts[name] = row?.n ?? 0
    }
    return counts
  }

  // -------------------------------------------------------------------------
  describe('surviving a restart', () => {
    it('keeps everything the learner did, with the application stopped in between', () => {
      onboard()
      answerDiagnostic()
      const { sessionId } = study()
      const evidenceBefore = countEvidence(db)
      const stateBefore = readConceptState(db, 'while-loops')

      restart()

      expect(readProfile(db)).toMatchObject({
        goal: 'I want to automate a spreadsheet at work.',
        experience: 'some-python',
        onboardingComplete: true,
        diagnosticComplete: true,
      })
      expect(countEvidence(db)).toBe(evidenceBefore)
      expect(readConceptState(db, 'while-loops')).toEqual(stateBefore)

      const session = readSession(db, sessionId)
      expect(session?.turns).toHaveLength(3)
      expect(session?.turns[0]?.text).toContain('while loop repeats')

      const [activity] = readSessionActivities(db, sessionId)
      expect(activity?.attempt?.correct).toBe(true)
      expect(activity?.hints).toHaveLength(1)
    })

    it('brings back an unfinished exercise with the code and hints as they were left', () => {
      onboard()
      const { sessionId } = study()

      restart()

      const [stored] = readSessionExercises(db, sessionId)
      expect(stored?.draftCode).toBe('def countdown(n):\n    pass\n')
      expect(stored?.hints).toHaveLength(1)
      expect(stored?.submissions).toHaveLength(1)
      expect(stored?.submissions[0]?.counted).toBe(true)
    })

    it('keeps the review schedule, so what is due does not depend on the process', () => {
      onboard()
      study()
      const dueBefore = readConceptState(db, 'while-loops').nextReviewAt
      expect(dueBefore).not.toBeNull()

      restart()

      expect(readConceptState(db, 'while-loops').nextReviewAt).toBe(dueBefore)
    })
  })

  // -------------------------------------------------------------------------
  describe('deleting everything', () => {
    const states = {
      'an empty installation': () => {
        // Nothing at all: reset must still be a no-op rather than an error.
      },
      'just after onboarding': () => {
        onboard()
      },
      'after the diagnostic': () => {
        onboard()
        answerDiagnostic()
      },
      'during an active session': () => {
        onboard()
        answerDiagnostic()
        openSession(db, 'while-loops', 'Starting while loops.', AT)
      },
      'after questions, hints and an exercise': () => {
        onboard()
        answerDiagnostic()
        study()
      },
    }

    for (const [description, arrange] of Object.entries(states)) {
      it(`leaves nothing behind, starting from ${description}`, () => {
        arrange()

        resetEverything(db, LATER)

        const counts = rowCounts()
        const { app_meta: meta, ...learnerTables } = counts
        expect(meta).toBe(1)
        for (const [table, count] of Object.entries(learnerTables)) {
          expect([table, count]).toEqual([table, 0])
        }
        expect(readProfile(db)).toBeNull()
      })
    }

    it('can be done twice in a row, and the second time changes nothing but the generation', () => {
      onboard()
      study()

      const first = resetEverything(db, LATER)
      const second = resetEverything(db, LATER + 1000)

      expect(second.generation).toBe(first.generation + 1)
      expect(readProfile(db)).toBeNull()
      expect(readLastResetAt(db)).toBe(LATER + 1000)
    })

    it('returns the application to its first run', () => {
      onboard()
      answerDiagnostic()
      resetEverything(db, LATER)

      ensureLearner(db, LATER)
      expect(readProfile(db)).toMatchObject({ onboardingStep: 'goal', onboardingComplete: false, diagnosticComplete: false })
      expect(countEvidence(db)).toBe(0)
    })

    it('survives a restart, rather than coming back with the file', () => {
      onboard()
      study()
      resetEverything(db, LATER)

      restart()

      expect(readProfile(db)).toBeNull()
      expect(readAllSessions(db)).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  describe('the data generation', () => {
    it('starts at one and moves on with every reset', () => {
      expect(readDataGeneration(db)).toBe(1)

      resetEverything(db, LATER)

      expect(readDataGeneration(db)).toBe(2)
    })

    it('marks a write from before the reset as stale, and one from after as current', () => {
      const before = readDataGeneration(db)
      resetEverything(db, LATER)

      expect(generationIsCurrent(db, before)).toBe(false)
      expect(generationIsCurrent(db, readDataGeneration(db))).toBe(true)
    })

    it('treats a missing or malformed generation as stale', () => {
      expect(generationIsCurrent(db, undefined)).toBe(false)
      expect(generationIsCurrent(db, '1')).toBe(false)
      expect(generationIsCurrent(db, 1.5)).toBe(false)
    })

    it('outlives the deletion, so the counter cannot be reset by resetting', () => {
      resetEverything(db, LATER)
      restart()

      expect(readDataGeneration(db)).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  describe('exporting', () => {
    it('collects what the learner did, with a schema and a version', () => {
      onboard()
      answerDiagnostic()
      study()

      const document = buildExportDocument(readExportInput(db, LATER))

      expect(document.schema).toBe(EXPORT_SCHEMA)
      expect(document.schemaVersion).toBe(EXPORT_SCHEMA_VERSION)
      expect(document.learner.goal).toBe('I want to automate a spreadsheet at work.')
      expect(document.learner.selfReport).toContainEqual({ area: 'loops', confidence: 'some' })
      expect(document.concepts.length).toBeGreaterThan(30)
      expect(document.evidence.length).toBeGreaterThan(0)
      expect(document.diagnostic?.responses).toHaveLength(1)
      expect(document.counts.sessions).toBe(1)
      expect(document.counts.activities).toBe(1)
      expect(document.counts.exercises).toBe(1)

      const [session] = document.sessions
      expect(session?.turns.some((turn) => turn.role === 'tutor' && turn.text.length > 0)).toBe(true)
      expect(session?.activities[0]?.attempt?.response).toBe('0')
      expect(session?.exercises[0]?.submissions[0]?.code).toContain('return []')
      expect(session?.standing).toBe('active')
    })

    it('is valid JSON with every moment written as a readable date', () => {
      onboard()
      study()

      const text = JSON.stringify(buildExportDocument(readExportInput(db, LATER)))
      const parsed: unknown = JSON.parse(text)

      expect(parsed).toMatchObject({ schema: EXPORT_SCHEMA })
      const document = parsed as { exportedAt: string; sessions: { startedAt: string }[] }
      expect(Date.parse(document.exportedAt)).toBe(LATER)
      expect(Date.parse(document.sessions[0]?.startedAt ?? '')).toBe(AT)
    })

    /*
     * The exclusions are the point of the export having its own builder. Everything named here
     * is one row away from the fields that are exported, and each would hand the learner
     * something the rest of the application works to keep from them.
     */
    it('contains no answer key, no reference solution and nothing about the provider', () => {
      onboard()
      answerDiagnostic()
      study()

      const text = JSON.stringify(buildExportDocument(readExportInput(db, LATER)))
      const exercise = getAuthoredExercise('x-while-countdown')

      expect(exercise).not.toBeNull()
      expect(text).not.toContain(exercise?.referenceSolution.split('\n')[1]?.trim() ?? 'unreachable')
      expect(text).not.toContain('referenceSolution')
      expect(text).not.toContain('correctIndex')
      expect(text).not.toContain('expectedOutput')
      expect(text).not.toContain('knownWrongAnswers')
      expect(text).not.toContain('It checks the condition before every pass.')
      expect(text.toLowerCase()).not.toContain('openai')
      expect(text.toLowerCase()).not.toContain('api_key')
      expect(text).not.toContain('llm_call')
    })

    it('exports nothing at all once the data has been deleted', () => {
      onboard()
      study()
      resetEverything(db, LATER)

      const input = readExportInput(db, LATER)

      expect(input.learner).toBeNull()
      expect(input.sessions).toEqual([])
      expect(input.diagnostic).toBeNull()
      expect(buildExportDocument(input).counts).toMatchObject({ evidence: 0, sessions: 0 })
    })

    it('does not create anything by being asked for', () => {
      const before = rowCounts()

      readExportInput(db, LATER)

      expect(rowCounts()).toEqual(before)
    })
  })

})
