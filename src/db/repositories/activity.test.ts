import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getPracticeItem } from '@/domain/assessment/items'
import type { Marking } from '@/domain/assessment/score'
import { bandOf } from '@/domain/learner-model/state'

import { closeDb, createDb, runMigrations, type Db } from '../client'
import {
  createActivity,
  readActivity,
  readSessionActivities,
  readUsedItemIds,
  recordHint,
  submitAttempt,
  type ActivityDraft,
} from './activity-repository'
import {
  countEvidence,
  ensureLearner,
  readConceptState,
  readEvidenceFor,
  readRecentMisconceptions,
  saveConfidence,
  saveExperience,
  saveGoal,
} from './learner-repository'
import { finishTutorTurn, openSession, reserveActivityTurn } from './session-repository'

/**
 * Evaluated activities against a real database.
 *
 * The guarantee this file exists for: **one answer produces at most one change in the learner
 * model.** Everything else here is about attribution — that a change in a band can be traced
 * back to the question that caused it, and that a change nobody earned never happens.
 */

const AT = Date.parse('2026-04-01T09:00:00.000Z')

function markedCorrect(): Marking {
  return { kind: 'marked', correct: true, partial: false, source: 'deterministic', misconceptions: [] }
}

function markedWrong(misconception?: 'break-leaves-all-loops'): Marking {
  return {
    kind: 'marked',
    correct: false,
    partial: false,
    source: 'deterministic',
    misconceptions: misconception === undefined ? [] : [misconception],
  }
}

describe('evaluated activities', () => {
  let directory: string
  let db: Db

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tutor-m5-'))
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

  function draftFor(itemId: string, sessionId: string, turnId: string): ActivityDraft {
    const item = getPracticeItem(itemId)

    return {
      sessionId,
      turnId,
      conceptId: item.conceptId,
      kind: item.kind,
      itemId: item.id,
      origin: 'authored',
      prompt: item.prompt,
      code: item.code ?? null,
      options: item.kind === 'choice' ? item.options : null,
      correctIndex: item.kind === 'choice' ? item.correctIndex : null,
      optionMisconceptions: item.kind === 'choice' ? item.optionMisconceptions : null,
      expectedOutput: item.kind === 'predict-output' ? item.expectedOutput : null,
      knownWrongAnswers:
        item.kind === 'predict-output' ? item.knownWrongAnswers.map((w) => ({ ...w })) : null,
      expectedPoints: item.kind === 'short-response' ? item.expectedPoints : null,
      explanation: item.kind === 'short-response' ? item.explanation : item.explanation,
      selectionGround: 'A first check on this.',
      probesMisconception: item.probes,
      strategyId: null,
      strategyVersion: null,
      model: null,
      at: AT,
    }
  }

  /**
   * Asks a question the way `askCheck` does, including completing the turn afterwards.
   *
   * The completion matters: `reserveActivityTurn` deliberately reuses an *unfinished* activity
   * turn, so a helper that skipped it would have every question in a session land on the same
   * position — which is what happened the first time this was written.
   */
  function askedIn(sessionId: string, itemId = 'p-break-inner-only') {
    const turn = reserveActivityTurn(db, sessionId, AT)
    const activity = createActivity(db, draftFor(itemId, sessionId, turn.turnId))
    finishTutorTurn(db, turn.turnId, 'complete', activity.prompt, AT)
    return activity
  }

  describe('asking a question', () => {
    it('stores it with its provenance and the reason it was chosen', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)

      expect(activity.itemId).toBe('p-break-inner-only')
      expect(activity.origin).toBe('authored')
      expect(activity.selectionGround).toBe('A first check on this.')
      expect(activity.probesMisconception).toBe('break-leaves-all-loops')
      expect(activity.attempt).toBeNull()
    })

    /*
     * The double-click case. Guarded by `unique(turn_id)` rather than by the interface, so two
     * requests arriving together cannot both decide no question exists yet.
     */
    it('attaches only one question to a position, however many times it is asked', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const turn = reserveActivityTurn(db, session.id, AT)

      const first = createActivity(db, draftFor('p-break-inner-only', session.id, turn.turnId))
      const second = createActivity(db, draftFor('p-continue-skips', session.id, turn.turnId))

      expect(second.id).toBe(first.id)
      // The first one wins: the second request found what was already there.
      expect(second.itemId).toBe('p-break-inner-only')
      expect(readSessionActivities(db, session.id)).toHaveLength(1)
    })

    it('remembers which authored items this learner has seen, across sessions', () => {
      const one = openSession(db, 'loop-control', 'r', AT)
      askedIn(one.id, 'p-break-inner-only')

      const two = openSession(db, 'while-loops', 'r', AT)
      askedIn(two.id, 'p-while-accumulate')

      expect([...readUsedItemIds(db)].sort()).toEqual(['p-break-inner-only', 'p-while-accumulate'])
    })

    it('survives a restart', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)
      closeDb(db)

      db = createDb(join(directory, 'tutor.db'))
      const resumed = readActivity(db, activity.id)

      expect(resumed?.prompt).toBe(activity.prompt)
      expect(resumed?.attempt).toBeNull()
    })
  })

  describe('answering it', () => {
    it('records the answer and derives evidence attributable to it', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)

      const result = submitAttempt(db, {
        activityId: activity.id,
        response: '0 0\n1 0',
        marking: markedCorrect(),
        feedback: 'That is right.',
        hintDepth: 0,
        at: AT + 100,
      })

      expect(result.recorded).toBe(true)
      expect(result.evidence).not.toBeNull()

      const [entry] = readEvidenceFor(db, 'loop-control')
      // Every question the milestone said the record must answer.
      expect(entry?.source).toBe('code-reading')
      expect(entry?.attemptId).toBe(result.attempt.id)
      expect(entry?.correct).toBe(true)
      expect(entry?.hintDepth).toBe(0)
      expect(entry?.priorBand).toBe('not-started')
      expect(entry?.posteriorBand).not.toBe('not-started')
      expect(entry?.reason.length).toBeGreaterThan(20)
      expect(entry?.priorTheta).not.toBe(entry?.posteriorTheta)
    })

    it('keeps the learner’s own words and how it was marked', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)

      submitAttempt(db, {
        activityId: activity.id,
        response: 'my exact answer',
        marking: markedWrong('break-leaves-all-loops'),
        feedback: 'Not quite.',
        hintDepth: 0,
        at: AT + 100,
      })

      const stored = readActivity(db, activity.id)?.attempt
      expect(stored?.response).toBe('my exact answer')
      expect(stored?.markingSource).toBe('deterministic')
      expect(stored?.misconceptions).toEqual(['break-leaves-all-loops'])
      expect(stored?.feedback).toBe('Not quite.')
    })

    it('records the misconception where the record can find it again', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)

      submitAttempt(db, {
        activityId: activity.id,
        response: '0 0',
        marking: markedWrong('break-leaves-all-loops'),
        feedback: 'Not quite.',
        hintDepth: 0,
        at: AT + 100,
      })

      // Which is what lets the next check probe it rather than asking something general.
      expect(readRecentMisconceptions(db)).toContain('break-leaves-all-loops')
    })

    it('survives a restart, with its feedback intact', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)
      submitAttempt(db, {
        activityId: activity.id,
        response: '0 0\n1 0',
        marking: markedCorrect(),
        feedback: 'The exact words shown.',
        hintDepth: 0,
        at: AT + 100,
      })
      closeDb(db)

      db = createDb(join(directory, 'tutor.db'))
      const resumed = readActivity(db, activity.id)

      // The learner must see the same words on a reload, not a regenerated approximation.
      expect(resumed?.attempt?.feedback).toBe('The exact words shown.')
      expect(resumed?.attempt?.correct).toBe(true)
    })
  })

  /*
   * The central guarantee. `unique(activity_id)` plus evidence derived only on a new row, so
   * no arrangement of retries, double-clicks or replayed actions can move a band twice.
   */
  describe('one answer, one update', () => {
    it('records nothing the second time, and says so', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)

      const first = submitAttempt(db, {
        activityId: activity.id,
        response: '0 0\n1 0',
        marking: markedCorrect(),
        feedback: 'That is right.',
        hintDepth: 0,
        at: AT + 100,
      })

      const second = submitAttempt(db, {
        activityId: activity.id,
        response: 'something completely different',
        marking: markedWrong(),
        feedback: 'Not quite.',
        hintDepth: 0,
        at: AT + 200,
      })

      expect(first.recorded).toBe(true)
      expect(second.recorded).toBe(false)
      expect(second.evidence).toBeNull()
      // The stored verdict is the original one; a stale resubmission cannot rewrite it.
      expect(second.attempt.correct).toBe(true)
      expect(second.attempt.response).toBe('0 0\n1 0')
      expect(readEvidenceFor(db, 'loop-control')).toHaveLength(1)
    })

    it('does not move the band a second time, however many times it is retried', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)

      submitAttempt(db, {
        activityId: activity.id,
        response: '0 0\n1 0',
        marking: markedCorrect(),
        feedback: 'f',
        hintDepth: 0,
        at: AT + 100,
      })

      const after = readConceptState(db, 'loop-control')

      for (let retry = 0; retry < 10; retry += 1) {
        submitAttempt(db, {
          activityId: activity.id,
          response: '0 0\n1 0',
          marking: markedCorrect(),
          feedback: 'f',
          hintDepth: 0,
          at: AT + 200 + retry,
        })
      }

      expect(readConceptState(db, 'loop-control')).toEqual(after)
      expect(countEvidence(db)).toBe(1)
    })

    it('records one piece of evidence per question, not per session', () => {
      const session = openSession(db, 'loop-control', 'r', AT)

      for (const itemId of ['p-break-inner-only', 'p-continue-skips']) {
        const activity = askedIn(session.id, itemId)
        submitAttempt(db, {
          activityId: activity.id,
          response: 'x',
          marking: markedCorrect(),
          feedback: 'f',
          hintDepth: 0,
          at: AT + 100,
        })
      }

      expect(readEvidenceFor(db, 'loop-control')).toHaveLength(2)
    })
  })

  /*
   * A safe unmarked result is better than false evidence. This is the case a provider failure,
   * a refusal, invalid output and a judge that cannot tell all arrive at.
   */
  describe('an answer that could not be marked', () => {
    const unmarked: Marking = {
      kind: 'unmarked',
      reason: 'The tutor could not read that answer just now.',
    }

    it('is kept, and changes nothing about the learner', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)
      const before = readConceptState(db, 'loop-control')

      const result = submitAttempt(db, {
        activityId: activity.id,
        response: 'their answer, still theirs',
        marking: unmarked,
        feedback: 'The tutor could not read that answer just now.',
        hintDepth: 0,
        at: AT + 100,
      })

      expect(result.recorded).toBe(true)
      expect(result.evidence).toBeNull()
      expect(result.attempt.marked).toBe(false)
      expect(result.attempt.response).toBe('their answer, still theirs')

      expect(readConceptState(db, 'loop-control')).toEqual(before)
      expect(countEvidence(db)).toBe(0)
      expect(bandOf(readConceptState(db, 'loop-control'))).toBe('not-started')
    })

    it('records no misconception either', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)

      submitAttempt(db, {
        activityId: activity.id,
        response: 'x',
        marking: unmarked,
        feedback: 'f',
        hintDepth: 0,
        at: AT + 100,
      })

      expect(readRecentMisconceptions(db)).toEqual([])
      expect(readActivity(db, activity.id)?.attempt?.misconceptions).toEqual([])
    })

    it('tells the learner why, in the words that were shown', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)

      submitAttempt(db, {
        activityId: activity.id,
        response: 'x',
        marking: unmarked,
        feedback: 'f',
        hintDepth: 0,
        at: AT + 100,
      })

      expect(readActivity(db, activity.id)?.attempt?.unmarkedReason).toBe(
        'The tutor could not read that answer just now.',
      )
    })
  })

  /*
   * ADR-0005, held to in the milestone that first produces hinted successes from a quiz.
   */
  describe('a hint taken before answering', () => {
    it('is recorded, and asking twice does not deepen it', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)

      recordHint(db, {
        activityId: activity.id,
        depth: 1,
        text: 'Think about which loop the break is inside.',
        strategyId: 'hint',
        strategyVersion: '1',
        model: 'mock',
        at: AT + 50,
      })
      recordHint(db, {
        activityId: activity.id,
        depth: 1,
        text: 'A different nudge entirely.',
        strategyId: 'hint',
        strategyVersion: '1',
        model: 'mock',
        at: AT + 60,
      })

      const hints = readActivity(db, activity.id)?.hints ?? []
      expect(hints).toHaveLength(1)
      // The same words, so the depth counts steps taken rather than buttons pressed.
      expect(hints[0]?.text).toBe('Think about which loop the break is inside.')
    })

    it('still counts a correct answer as progress, and never against them', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)
      const before = readConceptState(db, 'loop-control')

      submitAttempt(db, {
        activityId: activity.id,
        response: '0 0\n1 0',
        marking: markedCorrect(),
        feedback: 'f',
        hintDepth: 1,
        at: AT + 100,
      })

      const after = readConceptState(db, 'loop-control')
      const [entry] = readEvidenceFor(db, 'loop-control')

      expect(entry?.hintDepth).toBe(1)
      expect(entry?.correct).toBe(true)
      // Positive, and never a downgrade.
      expect(after.theta).toBeGreaterThan(before.theta)
      expect(after.successes).toBe(1)
    })

    it('counts for less than working it out unaided', () => {
      const hinted = openSession(db, 'loop-control', 'r', AT)
      const withHelp = askedIn(hinted.id, 'p-break-inner-only')
      submitAttempt(db, {
        activityId: withHelp.id,
        response: 'x',
        marking: markedCorrect(),
        feedback: 'f',
        hintDepth: 1,
        at: AT + 100,
      })
      const afterHinted = readConceptState(db, 'loop-control').theta

      // A fresh learner, same question, no hint.
      closeDb(db)
      db = createDb(join(directory, 'unaided.db'))
      runMigrations(db)
      ensureLearner(db, AT)
      saveGoal(db, AT, { goal: 'g', interests: [] })
      saveExperience(db, AT, 'some-python')
      saveConfidence(db, AT, {})

      const alone = openSession(db, 'loop-control', 'r', AT)
      const unaided = askedIn(alone.id, 'p-break-inner-only')
      submitAttempt(db, {
        activityId: unaided.id,
        response: 'x',
        marking: markedCorrect(),
        feedback: 'f',
        hintDepth: 0,
        at: AT + 100,
      })

      expect(readConceptState(db, 'loop-control').theta).toBeGreaterThan(afterHinted)
    })

    it('treats an answer that was right with something missing the same way', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)
      const before = readConceptState(db, 'loop-control')

      submitAttempt(db, {
        activityId: activity.id,
        response: 'roughly right',
        marking: {
          kind: 'marked',
          correct: true,
          partial: true,
          source: 'model',
          misconceptions: [],
        },
        feedback: 'f',
        hintDepth: 0,
        at: AT + 100,
      })

      const after = readConceptState(db, 'loop-control')
      // Attenuated like a hinted success, and still positive.
      expect(after.theta).toBeGreaterThan(before.theta)

      const evidence = readEvidenceFor(db, 'loop-control')[0]
      // The depth is the truth: they took no hint. Saying otherwise put a sentence in their own
      // evidence log about help they never asked for.
      expect(evidence?.hintDepth).toBe(0)
      expect(evidence?.reason).toContain('part of the reasoning left unsaid')
      expect(evidence?.reason).not.toContain('hint')
    })
  })

  describe('a hint asked for while the answer is being submitted', () => {
    it('is refused once the attempt exists, so the record cannot disagree with the evidence', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)

      submitAttempt(db, {
        activityId: activity.id,
        response: '0 0\n1 0',
        marking: markedCorrect(),
        feedback: 'f',
        hintDepth: 0,
        at: AT + 100,
      })

      // The provider was slow; by the time the hint text arrived the answer was already marked,
      // and marked unaided. Storing the hint now would show help that the numbers did not know
      // about.
      const stored = recordHint(db, {
        activityId: activity.id,
        depth: 1,
        text: 'Try writing out the values by hand.',
        strategyId: 'hint',
        strategyVersion: '1',
        model: 'mock',
        at: AT + 150,
      })

      expect(stored).toBe(false)
      expect(readActivity(db, activity.id)?.hints).toHaveLength(0)
      expect(readEvidenceFor(db, 'loop-control')[0]?.hintDepth).toBe(0)
    })
  })

  describe('resetting', () => {
    it('removes activities, attempts and hints with the learner', () => {
      const session = openSession(db, 'loop-control', 'r', AT)
      const activity = askedIn(session.id)
      recordHint(db, {
        activityId: activity.id,
        depth: 1,
        text: 'n',
        strategyId: null,
        strategyVersion: null,
        model: null,
        at: AT,
      })
      submitAttempt(db, {
        activityId: activity.id,
        response: 'x',
        marking: markedCorrect(),
        feedback: 'f',
        hintDepth: 1,
        at: AT + 100,
      })

      db.$client.prepare('delete from learner').run()

      for (const table of ['session_activity', 'activity_attempt', 'activity_hint']) {
        const row = db.$client.prepare(`select count(*) as n from ${table}`).get() as { n: number }
        expect(row.n, table).toBe(0)
      }
    })
  })
})
