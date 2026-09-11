import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CONCEPTS } from '@/domain/curriculum/concepts'
import { getDiagnosticItem } from '@/domain/diagnostic/items'
import { bandOf } from '@/domain/learner-model/state'

import { closeDb, createDb, runMigrations, type Db } from '../client'
import {
  completeDiagnostic,
  decideNext,
  openDiagnostic,
  readResponses,
  skipItem,
  submitAnswer,
} from './diagnostic-repository'
import {
  countEvidence,
  ensureLearner,
  readConceptState,
  readConceptStates,
  readEvidenceFor,
  readOnboardingAnswers,
  readProfile,
  readSelfReport,
  reopenOnboardingAt,
  resetLearner,
  saveConfidence,
  saveExperience,
  saveGoal,
} from './learner-repository'

/**
 * The first-run journey, against a real database.
 *
 * These are the guarantees a learner would notice if they broke: their answers surviving a
 * restart, the tutor not claiming they are good at something they only said they were good at,
 * and one answer counting exactly once.
 */

const AT = Date.parse('2026-02-02T10:00:00.000Z')

describe('first run', () => {
  let directory: string
  let db: Db

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tutor-m3-'))
    db = createDb(join(directory, 'tutor.db'))
    runMigrations(db)
  })

  afterEach(() => {
    closeDb(db)
    rmSync(directory, { recursive: true, force: true })
  })

  describe('onboarding persistence', () => {
    it('starts a new learner at the first step', () => {
      ensureLearner(db, AT)

      const profile = readProfile(db)
      expect(profile?.onboardingStep).toBe('goal')
      expect(profile?.onboardingComplete).toBe(false)
      expect(profile?.diagnosticComplete).toBe(false)
    })

    it('advances one step at a time, saving as it goes', () => {
      saveGoal(db, AT, { goal: 'I want to automate a spreadsheet at work.', interests: ['loops'] })
      expect(readProfile(db)?.onboardingStep).toBe('experience')

      saveExperience(db, AT, 'some-python')
      expect(readProfile(db)?.onboardingStep).toBe('confidence')

      saveConfidence(db, AT, { loops: 'some' })
      expect(readProfile(db)?.onboardingStep).toBe('done')
      expect(readProfile(db)?.onboardingComplete).toBe(true)
    })

    it('returns a part-way learner to the step they were on, not the beginning', () => {
      // The case that matters: they answered the first question and closed the application.
      saveGoal(db, AT, { goal: 'Learn enough to read my team’s code.', interests: [] })
      closeDb(db)

      db = createDb(join(directory, 'tutor.db'))
      const profile = readProfile(db)

      expect(profile?.onboardingStep).toBe('experience')
      expect(profile?.goal).toBe('Learn enough to read my team’s code.')
    })

    it('keeps the learner’s own words exactly as written', () => {
      const goal = 'I keep bouncing off "for" loops — I want them to click.'
      saveGoal(db, AT, { goal, interests: [] })

      expect(readProfile(db)?.goal).toBe(goal)
    })

    it('stores the self-assessment separately from anything the learner demonstrated', () => {
      saveGoal(db, AT, { goal: 'g', interests: [] })
      saveExperience(db, AT, 'regular-python')
      saveConfidence(db, AT, { loops: 'confident', functions: 'comfortable' })

      expect(readSelfReport(db)).toEqual({ loops: 'confident', functions: 'comfortable' })
    })

    it('rebuilds the full onboarding answers for the planner', () => {
      saveGoal(db, AT, { goal: 'g', interests: ['collections'] })
      saveExperience(db, AT, 'other-language')
      saveConfidence(db, AT, { loops: 'some' })

      expect(readOnboardingAnswers(db)).toEqual({
        goal: 'g',
        experience: 'other-language',
        interests: ['collections'],
        confidence: { loops: 'some' },
      })
    })
  })

  describe('self-report is a prior, not an achievement', () => {
    beforeEach(() => {
      saveGoal(db, AT, { goal: 'g', interests: [] })
      saveExperience(db, AT, 'regular-python')
      // The strongest possible claim, across every area.
      saveConfidence(db, AT, {
        fundamentals: 'confident',
        'variables-and-types': 'confident',
        expressions: 'confident',
        conditionals: 'confident',
        loops: 'confident',
        functions: 'confident',
        collections: 'confident',
        debugging: 'confident',
        decomposition: 'confident',
        'object-oriented': 'confident',
      })
    })

    it('leaves every concept not started, however advanced the learner says they are', () => {
      // The guarantee: no band can be earned from a claim.
      for (const state of readConceptStates(db)) {
        expect(bandOf(state), state.conceptId).toBe('not-started')
      }
    })

    it('records no evidence at all', () => {
      expect(countEvidence(db)).toBe(0)
    })

    it('creates a state for every concept, so nothing is missing from the profile', () => {
      expect(readConceptStates(db)).toHaveLength(CONCEPTS.length)
      for (const state of readConceptStates(db)) {
        expect(state.evidenceCount).toBe(0)
      }
    })

    it('does move the starting estimate, since a claim is still information', () => {
      const confident = readConceptState(db, 'for-loops-and-range')

      // Above the concept's own difficulty, because they said they were confident with loops.
      const loops = CONCEPTS.find((concept) => concept.id === 'for-loops-and-range')
      expect(confident.theta).toBeGreaterThan(loops!.baselineDifficulty)
    })
  })

  describe('answering the diagnostic', () => {
    beforeEach(() => {
      saveGoal(db, AT, { goal: 'g', interests: [] })
      saveExperience(db, AT, 'some-python')
      saveConfidence(db, AT, { loops: 'some' })
    })

    it('creates one session and reuses it', () => {
      const first = openDiagnostic(db, AT)
      const second = openDiagnostic(db, AT + 1_000)

      expect(second.sessionId).toBe(first.sessionId)
    })

    it('records an answer and the evidence explaining it', () => {
      const { sessionId } = openDiagnostic(db, AT)

      const result = submitAnswer(db, {
        sessionId,
        itemId: 'range-values',
        answer: '0\n1\n2',
        correct: true,
        verdictSource: 'deterministic',
        misconceptions: [],
        at: AT,
      })

      expect(result.recorded).toBe(true)
      expect(result.conceptId).toBe('for-loops-and-range')

      const records = readEvidenceFor(db, 'for-loops-and-range')
      expect(records).toHaveLength(1)
      expect(records[0]?.source).toBe('diagnostic')
      expect(records[0]?.correct).toBe(true)
      expect(records[0]?.reason).toContain('counting loops')
    })

    it('ties every movement to the answer that caused it', () => {
      const { sessionId } = openDiagnostic(db, AT)
      submitAnswer(db, {
        sessionId,
        itemId: 'range-values',
        answer: '0\n1\n2\n3',
        correct: false,
        verdictSource: 'deterministic',
        misconceptions: ['range-endpoint-inclusive'],
        at: AT,
      })

      const [record] = readEvidenceFor(db, 'for-loops-and-range')
      const [response] = readResponses(db, sessionId)

      expect(record?.attemptId).toBe(response?.id)
    })

    it('changes the band once there is real evidence', () => {
      const { sessionId } = openDiagnostic(db, AT)
      expect(bandOf(readConceptState(db, 'for-loops-and-range'))).toBe('not-started')

      submitAnswer(db, {
        sessionId,
        itemId: 'range-values',
        answer: '0\n1\n2',
        correct: true,
        verdictSource: 'deterministic',
        misconceptions: [],
        at: AT,
      })

      expect(bandOf(readConceptState(db, 'for-loops-and-range'))).not.toBe('not-started')
    })

    it('records which kind of verdict produced the result', () => {
      // Kept distinct because they are not equally trustworthy: a compared answer, a test run
      // and a model judgement are three different things.
      const { sessionId } = openDiagnostic(db, AT)

      submitAnswer(db, {
        sessionId,
        itemId: 'code-count-evens',
        answer: 'def count_evens(numbers):\n    return 0',
        correct: false,
        verdictSource: 'execution',
        misconceptions: [],
        executionOutput: '',
        failedTests: ['counts evens in a mixed list'],
        at: AT,
      })

      const [response] = readResponses(db, sessionId)
      expect(response?.verdictSource).toBe('execution')
      expect(response?.failedTests).toEqual(['counts evens in a mixed list'])
    })
  })

  describe('one answer counts once', () => {
    beforeEach(() => {
      saveGoal(db, AT, { goal: 'g', interests: [] })
      saveExperience(db, AT, 'some-python')
      saveConfidence(db, AT, {})
    })

    const submit = (sessionId: string, at: number) =>
      submitAnswer(db, {
        sessionId,
        itemId: 'range-values',
        answer: '0\n1\n2',
        correct: true,
        verdictSource: 'deterministic',
        misconceptions: [],
        at,
      })

    it('ignores a repeated submission of the same item', () => {
      // A double-click, a refresh mid-request, or a component re-rendering and firing twice.
      const { sessionId } = openDiagnostic(db, AT)

      expect(submit(sessionId, AT).recorded).toBe(true)
      expect(submit(sessionId, AT + 50).recorded).toBe(false)
      expect(submit(sessionId, AT + 100).recorded).toBe(false)

      expect(readResponses(db, sessionId)).toHaveLength(1)
      expect(readEvidenceFor(db, 'for-loops-and-range')).toHaveLength(1)
    })

    it('does not move the estimate twice for one answer', () => {
      const { sessionId } = openDiagnostic(db, AT)

      submit(sessionId, AT)
      const afterFirst = readConceptState(db, 'for-loops-and-range')
      submit(sessionId, AT + 50)
      const afterSecond = readConceptState(db, 'for-loops-and-range')

      expect(afterSecond).toEqual(afterFirst)
    })

    it('reports the stored verdict, not a stale resubmission', () => {
      const { sessionId } = openDiagnostic(db, AT)
      submit(sessionId, AT)

      // A retry arriving late with the opposite verdict must not appear to change anything.
      const repeat = submitAnswer(db, {
        sessionId,
        itemId: 'range-values',
        answer: 'nonsense',
        correct: false,
        verdictSource: 'deterministic',
        misconceptions: [],
        at: AT + 200,
      })

      expect(repeat.recorded).toBe(false)
      expect(repeat.correct).toBe(true)
      expect(readResponses(db, sessionId)[0]?.answer).toBe('0\n1\n2')
    })

    it('completes idempotently', () => {
      const { sessionId } = openDiagnostic(db, AT)
      completeDiagnostic(db, sessionId, 'covered-enough', AT)
      const first = readProfile(db)?.diagnosticComplete

      completeDiagnostic(db, sessionId, 'reached-limit', AT + 5_000)

      expect(first).toBe(true)
      expect(openDiagnostic(db, AT).completionReason).toBe('covered-enough')
    })
  })

  describe('resuming', () => {
    beforeEach(() => {
      saveGoal(db, AT, { goal: 'g', interests: [] })
      saveExperience(db, AT, 'some-python')
      saveConfidence(db, AT, {})
    })

    it('comes back to the same session with the answers already given', () => {
      const { sessionId } = openDiagnostic(db, AT)
      submitAnswer(db, {
        sessionId,
        itemId: 'exec-order',
        answer: 'first\nsecond',
        correct: true,
        verdictSource: 'deterministic',
        misconceptions: [],
        at: AT,
      })
      closeDb(db)

      db = createDb(join(directory, 'tutor.db'))
      const resumed = openDiagnostic(db, AT + 60_000)

      expect(resumed.sessionId).toBe(sessionId)
      expect(resumed.answers).toHaveLength(1)
      expect(resumed.answers[0]?.itemId).toBe('exec-order')
    })

    it('asks a different item after resuming, not the one already answered', () => {
      const { sessionId } = openDiagnostic(db, AT)
      const first = decideNext(db, openDiagnostic(db, AT))
      if (first.kind !== 'ask') throw new Error('expected an item')

      submitAnswer(db, {
        sessionId,
        itemId: first.item.id,
        answer: '0',
        correct: true,
        verdictSource: 'deterministic',
        misconceptions: [],
        at: AT,
      })

      const second = decideNext(db, openDiagnostic(db, AT + 1_000))
      if (second.kind !== 'ask') throw new Error('expected an item')

      expect(second.item.id).not.toBe(first.item.id)
      expect(second.position).toBe(2)
    })

    it('refuses to plan before onboarding has been answered', () => {
      resetLearner(db)
      ensureLearner(db, AT)

      expect(() => decideNext(db, openDiagnostic(db, AT))).toThrow(/before onboarding/)
    })
  })

  /*
   * The path taken when a question genuinely cannot be marked — a written answer with no tutor
   * to read it. The temptation is to call it wrong and move on, which would write invented
   * evidence into a learner's profile because a network call failed.
   */
  describe('a question that cannot be marked', () => {
    beforeEach(() => {
      saveGoal(db, AT, { goal: 'g', interests: [] })
      saveExperience(db, AT, 'some-python')
      saveConfidence(db, AT, {})
    })

    it('records no answer and no evidence', () => {
      const { sessionId } = openDiagnostic(db, AT)
      skipItem(db, sessionId, 'explain-scope')

      expect(readResponses(db, sessionId)).toHaveLength(0)
      expect(countEvidence(db)).toBe(0)
    })

    it('leaves the concept not started rather than assuming anything', () => {
      const { sessionId } = openDiagnostic(db, AT)
      const item = getDiagnosticItem('explain-scope')
      skipItem(db, sessionId, item.id)

      expect(bandOf(readConceptState(db, item.conceptId))).toBe('not-started')
    })

    it('stops offering the item, so the diagnostic can still finish', () => {
      const { sessionId } = openDiagnostic(db, AT)
      skipItem(db, sessionId, 'explain-scope')

      const progress = openDiagnostic(db, AT)
      expect(progress.skippedItemIds).toEqual(['explain-scope'])

      for (let step = 0; step < 40; step += 1) {
        const decision = decideNext(db, openDiagnostic(db, AT + step))
        if (decision.kind === 'finished') return
        expect(decision.item.id).not.toBe('explain-scope')

        submitAnswer(db, {
          sessionId,
          itemId: decision.item.id,
          answer: '0',
          correct: true,
          verdictSource: 'deterministic',
          misconceptions: [],
          at: AT + step,
        })
      }

      throw new Error('the diagnostic never finished')
    })

    it('does not record the same set-aside twice', () => {
      const { sessionId } = openDiagnostic(db, AT)
      skipItem(db, sessionId, 'explain-scope')
      skipItem(db, sessionId, 'explain-scope')

      expect(openDiagnostic(db, AT).skippedItemIds).toEqual(['explain-scope'])
    })

    it('refuses an item that is not in the bank', () => {
      const { sessionId } = openDiagnostic(db, AT)
      expect(() => {
        skipItem(db, sessionId, 'not-a-real-item')
      }).toThrow(/Unknown diagnostic item/)
    })

    it('survives a restart', () => {
      const { sessionId } = openDiagnostic(db, AT)
      skipItem(db, sessionId, 'explain-scope')
      closeDb(db)

      db = createDb(join(directory, 'tutor.db'))
      expect(openDiagnostic(db, AT + 60_000).skippedItemIds).toEqual(['explain-scope'])
    })

    it('is reported as unasked when the caller excludes an item it cannot mark', () => {
      const progress = openDiagnostic(db, AT)

      // What the application does when no tutor is configured: the written question is taken
      // out of the pool before it is ever offered.
      for (let step = 0; step < 40; step += 1) {
        const decision = decideNext(db, openDiagnostic(db, AT + step), ['explain-scope'])
        if (decision.kind === 'finished') {
          expect(readResponses(db, progress.sessionId).map((row) => row.itemId)).not.toContain(
            'explain-scope',
          )
          return
        }
        expect(decision.item.id).not.toBe('explain-scope')

        submitAnswer(db, {
          sessionId: progress.sessionId,
          itemId: decision.item.id,
          answer: '0',
          correct: false,
          verdictSource: 'deterministic',
          misconceptions: [],
          at: AT + step,
        })
      }

      throw new Error('the diagnostic never finished')
    })
  })

  /*
   * The guard that review found missing. `saveConfidence` rebuilds every concept state from
   * self-report, and nothing stopped it running a second time — a stale onboarding form left
   * open in another tab was enough to replace a whole diagnostic's worth of evidence with the
   * learner's own claims, leaving a profile that said "built from 11 answers" above 33
   * concepts reading "not started".
   */
  describe('onboarding cannot be replayed over evidence', () => {
    beforeEach(() => {
      saveGoal(db, AT, { goal: 'g', interests: [] })
      saveExperience(db, AT, 'regular-python')
      saveConfidence(db, AT, { loops: 'confident' })
    })

    it('refuses a second confidence submission once onboarding is finished', () => {
      expect(saveConfidence(db, AT + 1_000, { loops: 'none' })).toBe('refused-already-complete')
    })

    it('leaves the evidence from answers already given untouched', () => {
      const { sessionId } = openDiagnostic(db, AT)
      const decision = decideNext(db, openDiagnostic(db, AT))
      if (decision.kind !== 'ask') throw new Error('expected an item')

      submitAnswer(db, {
        sessionId,
        itemId: decision.item.id,
        answer: '0',
        correct: true,
        verdictSource: 'deterministic',
        misconceptions: [],
        at: AT,
      })

      const before = readConceptState(db, decision.item.conceptId)
      expect(before.evidenceCount).toBe(1)

      saveConfidence(db, AT + 2_000, { loops: 'none' })

      const after = readConceptState(db, decision.item.conceptId)
      expect(after.evidenceCount).toBe(1)
      expect(after.theta).toBe(before.theta)
      expect(countEvidence(db)).toBe(1)
    })

    it('refuses the goal and experience steps too, so onboarding cannot restart', () => {
      expect(saveGoal(db, AT + 1_000, { goal: 'other', interests: [] })).toBe(
        'refused-already-complete',
      )
      expect(saveExperience(db, AT + 1_000, 'new-to-programming')).toBe('refused-already-complete')
      expect(readProfile(db)?.goal).toBe('g')
      expect(readProfile(db)?.onboardingStep).toBe('done')
    })

    it('refuses to reopen an earlier step once onboarding is finished', () => {
      expect(reopenOnboardingAt(db, AT + 1_000, 'goal')).toBe('refused-already-complete')
      expect(readProfile(db)?.onboardingStep).toBe('done')
    })
  })

  describe('going back during onboarding', () => {
    it('returns to an earlier question with the answer still there', () => {
      saveGoal(db, AT, { goal: 'read my team scripts', interests: [] })
      saveExperience(db, AT, 'some-python')

      expect(reopenOnboardingAt(db, AT + 500, 'goal')).toBe('saved')
      expect(readProfile(db)?.onboardingStep).toBe('goal')
      // Nothing is cleared: going back shows what they said, not an empty form.
      expect(readProfile(db)?.goal).toBe('read my team scripts')
      expect(readProfile(db)?.experience).toBe('some-python')
    })
  })

  describe('a diagnostic that is already finished', () => {
    beforeEach(() => {
      saveGoal(db, AT, { goal: 'g', interests: [] })
      saveExperience(db, AT, 'some-python')
      saveConfidence(db, AT, {})
    })

    it('refuses a late answer rather than adding to a profile already shown', () => {
      const { sessionId } = openDiagnostic(db, AT)
      completeDiagnostic(db, sessionId, 'reached-limit', AT + 1_000)

      expect(() =>
        submitAnswer(db, {
          sessionId,
          itemId: 'exec-order',
          answer: 'anything',
          correct: true,
          verdictSource: 'deterministic',
          misconceptions: [],
          at: AT + 2_000,
        }),
      ).toThrow(/already complete/)

      expect(countEvidence(db)).toBe(0)
    })
  })

  describe('resetting', () => {
    it('removes everything and returns to first run', () => {
      saveGoal(db, AT, { goal: 'g', interests: [] })
      saveExperience(db, AT, 'some-python')
      saveConfidence(db, AT, { loops: 'some' })
      const { sessionId } = openDiagnostic(db, AT)
      submitAnswer(db, {
        sessionId,
        itemId: 'range-values',
        answer: '0\n1\n2',
        correct: true,
        verdictSource: 'deterministic',
        misconceptions: [],
        at: AT,
      })

      resetLearner(db)

      expect(readProfile(db)).toBeNull()
      expect(countEvidence(db)).toBe(0)
      expect(readSelfReport(db)).toEqual({})
      // Cascades: the session and its responses go with the learner.
      expect(readResponses(db, sessionId)).toEqual([])
    })
  })
})
