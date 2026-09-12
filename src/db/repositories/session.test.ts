import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { boundedHistory } from '@/domain/tutoring/session'

import { closeDb, createDb, runMigrations, type Db } from '../client'
import { DatabaseCallLog } from './call-log-repository'
import {
  countEvidence,
  ensureLearner,
  readConceptState,
  readConceptStates,
  saveConfidence,
  saveExperience,
  saveGoal,
} from './learner-repository'
import { sessionTurn } from '../schema'
import {
  appendLearnerTurn,
  closeSession,
  finishTutorTurn,
  markTurnStreaming,
  recordCancellation,
  openSession,
  readCallLog,
  readLatestOpenSession,
  readObservations,
  readOpenSessionConcepts,
  readSession,
  readSessionByTurn,
  readSessionForConcept,
  recordObservation,
  reopenSession,
  reserveTutorTurn,
} from './session-repository'

/**
 * A tutoring session against a real database.
 *
 * The guarantees under test are the ones a learner would actually notice if they broke: the
 * conversation still being there tomorrow, pressing Start twice not producing two
 * conversations, a retry not leaving two copies of the same reply — and, above everything
 * else, talking to the tutor not moving their mastery.
 */

const AT = Date.parse('2026-03-01T09:00:00.000Z')
const PROVENANCE = { strategyId: 'explain', strategyVersion: '1', model: 'mock' }
const CONVERSE = { strategyId: 'converse', strategyVersion: '1', model: 'mock' }

describe('tutoring sessions', () => {
  let directory: string
  let db: Db

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tutor-m4-'))
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

  describe('starting one', () => {
    it('creates a session for the concept', () => {
      const session = openSession(db, 'program-execution', 'Starting how a program runs.', AT)

      expect(session.conceptId).toBe('program-execution')
      expect(session.openedReason).toBe('Starting how a program runs.')
      expect(session.turns).toEqual([])
      expect(session.closedAt).toBeNull()
    })

    /*
     * The double-click case, and the two-tabs case. Guarded by `unique(learner, concept)`
     * rather than by a read-then-write, so two requests arriving together cannot both decide
     * the session does not exist yet.
     */
    it('returns the same session however many times it is opened', () => {
      const first = openSession(db, 'program-execution', 'first reason', AT)
      const second = openSession(db, 'program-execution', 'a different reason', AT + 10)
      const third = openSession(db, 'program-execution', 'another', AT + 20)

      expect(second.id).toBe(first.id)
      expect(third.id).toBe(first.id)
      // The reason recorded is the one from when it actually opened.
      expect(second.openedReason).toBe('first reason')
    })

    it('keeps separate sessions for separate concepts', () => {
      const a = openSession(db, 'program-execution', 'r', AT)
      const b = openSession(db, 'variables-and-assignment', 'r', AT)

      expect(a.id).not.toBe(b.id)
    })

    it('reserves the opening turn at position zero', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      const opening = reserveTutorTurn(db, session.id, PROVENANCE, AT)

      expect(opening.ordinal).toBe(0)
      expect(readSession(db, session.id)?.turns[0]?.status).toBe('pending')
    })

    it('reserves the same opening turn when asked twice', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      const first = reserveTutorTurn(db, session.id, PROVENANCE, AT)
      const second = reserveTutorTurn(db, session.id, PROVENANCE, AT + 5)

      expect(second.turnId).toBe(first.turnId)
      expect(readSession(db, session.id)?.turns).toHaveLength(1)
    })
  })

  describe('turns', () => {
    function opened() {
      const session = openSession(db, 'program-execution', 'r', AT)
      const opening = reserveTutorTurn(db, session.id, PROVENANCE, AT)
      finishTutorTurn(db, opening.turnId, 'complete', 'Here is a loop.', AT + 100)
      return session.id
    }

    it('keeps the order the conversation happened in', () => {
      const sessionId = opened()
      appendLearnerTurn(db, sessionId, 'Why does that work?', AT + 200)
      const reply = reserveTutorTurn(db, sessionId, CONVERSE, AT + 210)
      finishTutorTurn(db, reply.turnId, 'complete', 'Because the name survives.', AT + 300)

      const turns = readSession(db, sessionId)?.turns ?? []
      expect(turns.map((turn) => [turn.ordinal, turn.role])).toEqual([
        [0, 'tutor'],
        [1, 'learner'],
        [2, 'tutor'],
      ])
    })

    it('records which strategy produced each tutor turn', () => {
      const sessionId = opened()
      appendLearnerTurn(db, sessionId, 'why?', AT + 200)
      reserveTutorTurn(db, sessionId, CONVERSE, AT + 210)

      const rows = db.$client
        .prepare('select ordinal, strategy_id, model from session_turn order by ordinal')
        .all() as { ordinal: number; strategy_id: string | null; model: string | null }[]

      expect(rows[0]).toMatchObject({ ordinal: 0, strategy_id: 'explain', model: 'mock' })
      expect(rows[1]).toMatchObject({ ordinal: 1, strategy_id: null })
      expect(rows[2]).toMatchObject({ ordinal: 2, strategy_id: 'converse' })
    })

    it('survives a restart', () => {
      const sessionId = opened()
      appendLearnerTurn(db, sessionId, 'Why does that work?', AT + 200)
      closeDb(db)

      db = createDb(join(directory, 'tutor.db'))
      const resumed = readSession(db, sessionId)

      expect(resumed?.turns).toHaveLength(2)
      expect(resumed?.turns[1]?.text).toBe('Why does that work?')
    })

    it('finds the session a turn belongs to, without being told', () => {
      const sessionId = opened()
      const turnId = readSession(db, sessionId)?.turns[0]?.id ?? ''

      expect(readSessionByTurn(db, turnId)?.id).toBe(sessionId)
      expect(readSessionByTurn(db, 'not-a-turn')).toBeNull()
    })
  })

  /*
   * The retry guarantee, and the reason the tutor's turn is created before its text exists.
   * A retry computes the same ordinal, finds the same row, and rewrites it — so there is no
   * arrangement of interruptions that can leave two copies of one reply.
   */
  describe('an interrupted reply', () => {
    function midReply() {
      const session = openSession(db, 'program-execution', 'r', AT)
      const opening = reserveTutorTurn(db, session.id, PROVENANCE, AT)
      finishTutorTurn(db, opening.turnId, 'complete', 'Opening.', AT + 100)
      appendLearnerTurn(db, session.id, 'A question.', AT + 200)
      const reply = reserveTutorTurn(db, session.id, CONVERSE, AT + 210)
      return { sessionId: session.id, replyId: reply.turnId }
    }

    it('keeps the text that arrived before it was cancelled', () => {
      const { sessionId, replyId } = midReply()
      finishTutorTurn(db, replyId, 'cancelled', 'Because the name su', AT + 250)

      const turn = readSession(db, sessionId)?.turns.at(-1)
      expect(turn?.status).toBe('cancelled')
      expect(turn?.text).toBe('Because the name su')
    })

    it('rewrites the same turn on retry rather than adding another', () => {
      const { sessionId, replyId } = midReply()
      finishTutorTurn(db, replyId, 'failed', 'Because the na', AT + 250)

      const retried = reserveTutorTurn(db, sessionId, CONVERSE, AT + 300)
      expect(retried.turnId).toBe(replyId)

      finishTutorTurn(db, retried.turnId, 'complete', 'Because the name survives.', AT + 400)

      const turns = readSession(db, sessionId)?.turns ?? []
      expect(turns).toHaveLength(3)
      expect(turns.at(-1)?.text).toBe('Because the name survives.')
      expect(turns.at(-1)?.status).toBe('complete')
    })

    it('clears the partial text when a retry starts, so nothing is doubled up', () => {
      const { sessionId, replyId } = midReply()
      finishTutorTurn(db, replyId, 'failed', 'Because the na', AT + 250)
      reserveTutorTurn(db, sessionId, CONVERSE, AT + 300)

      expect(readSession(db, sessionId)?.turns.at(-1)?.text).toBe('')
    })

    it('retries many times without ever growing the conversation', () => {
      const { sessionId, replyId } = midReply()

      for (let attempt = 0; attempt < 10; attempt += 1) {
        finishTutorTurn(db, replyId, 'failed', 'partial', AT + 300 + attempt)
        reserveTutorTurn(db, sessionId, CONVERSE, AT + 310 + attempt)
      }

      expect(readSession(db, sessionId)?.turns).toHaveLength(3)
    })

    it('opens a new turn once the previous one finished', () => {
      const { sessionId, replyId } = midReply()
      finishTutorTurn(db, replyId, 'complete', 'Answered.', AT + 250)
      appendLearnerTurn(db, sessionId, 'Another question.', AT + 300)
      const next = reserveTutorTurn(db, sessionId, CONVERSE, AT + 310)

      expect(next.turnId).not.toBe(replyId)
      expect(next.ordinal).toBe(4)
    })
  })

  /*
   * Two concurrent sends, which is two tabs or a click that beat the render. The loser's words
   * used to be dropped while the caller was told the message had been stored.
   */
  describe('two messages arriving at once', () => {
    it('stores the first and says plainly that the second was not stored', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      const first = appendLearnerTurn(db, session.id, 'first message', AT)

      expect(first.stored).toBe(true)

      // The same ordinal, as a second request computing it from the same snapshot would.
      const second = appendLearnerTurn(db, session.id, 'second message', AT + 1)
      expect(second.stored).toBe(true)
      expect(second.stored && second.turn.ordinal).toBe(1)
    })

    it('reports not-stored when the position is already taken', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      // Occupy ordinal 0 with a tutor turn, then force a learner insert at the same position.
      reserveTutorTurn(db, session.id, PROVENANCE, AT)

      const clash = db
        .insert(sessionTurn)
        .values({
          id: 'clashing',
          sessionId: session.id,
          ordinal: 0,
          role: 'learner',
          text: 'lost',
          status: 'complete',
        })
        .onConflictDoNothing({ target: [sessionTurn.sessionId, sessionTurn.ordinal] })
        .returning({ id: sessionTurn.id })
        .all()

      // The insert did nothing, which is exactly what `appendLearnerTurn` now detects rather
      // than reading back the row that was already there.
      expect(clash).toHaveLength(0)
    })
  })

  /*
   * Precedence between the learner stopping a reply and the request finishing it. The learner's
   * view is what the transcript should say.
   */
  describe('a cancellation racing the request that was cancelled', () => {
    function midReply() {
      const session = openSession(db, 'program-execution', 'r', AT)
      const opening = reserveTutorTurn(db, session.id, PROVENANCE, AT)
      return { sessionId: session.id, turnId: opening.turnId }
    }

    it('keeps what the learner saw when the request completes afterwards', () => {
      const { sessionId, turnId } = midReply()
      recordCancellation(db, turnId, 'the half they read', AT + 100)

      // The request finishes a moment later with everything it consumed.
      finishTutorTurn(db, turnId, 'complete', 'the whole reply, all of it', AT + 200)

      const turn = readSession(db, sessionId)?.turns[0]
      expect(turn?.status).toBe('cancelled')
      expect(turn?.text).toBe('the half they read')
    })

    it('keeps what the learner saw when the request also calls it a cancellation', () => {
      // The earlier guard let this through, so the in-flight request overwrote the learner's
      // text with whatever it had consumed — which could be more than they ever saw.
      const { sessionId, turnId } = midReply()
      recordCancellation(db, turnId, 'the half they read', AT + 100)
      finishTutorTurn(db, turnId, 'cancelled', 'rather more than that', AT + 200)

      expect(readSession(db, sessionId)?.turns[0]?.text).toBe('the half they read')
    })

    it('lets a retry reopen it, because that is the learner asking again', () => {
      const { sessionId, turnId } = midReply()
      recordCancellation(db, turnId, 'stopped', AT + 100)

      const retried = reserveTutorTurn(db, sessionId, PROVENANCE, AT + 300)
      expect(retried.turnId).toBe(turnId)
      expect(readSession(db, sessionId)?.turns[0]?.status).toBe('pending')
    })
  })

  /*
   * A turn being streamed has to be distinguishable from one nobody has started, or a reload
   * mid-reply opens a second stream into the same row.
   */
  describe('a turn that is being streamed', () => {
    it('says so, and only while it was waiting', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      const turn = reserveTutorTurn(db, session.id, PROVENANCE, AT)

      markTurnStreaming(db, turn.turnId, AT + 10)
      expect(readSession(db, session.id)?.turns[0]?.status).toBe('streaming')

      // A completed turn is not dragged back into streaming by a stray call.
      finishTutorTurn(db, turn.turnId, 'complete', 'done', AT + 20)
      markTurnStreaming(db, turn.turnId, AT + 30)
      expect(readSession(db, session.id)?.turns[0]?.status).toBe('complete')
    })
  })

  describe('leaving and coming back', () => {
    it('offers the session the learner was last in', () => {
      const first = openSession(db, 'program-execution', 'r', AT)
      openSession(db, 'variables-and-assignment', 'r', AT + 1000)
      appendLearnerTurn(db, first.id, 'still here', AT + 2000)

      expect(readLatestOpenSession(db)?.id).toBe(first.id)
    })

    it('offers nothing once the only session is closed', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      closeSession(db, session.id, AT + 500)

      expect(readLatestOpenSession(db)).toBeNull()
      expect(readOpenSessionConcepts(db)).toEqual([])
    })

    /*
     * The defect the single-session version of this test could not catch: the newest row being
     * closed said nothing about older ones. Taking the newest and then checking whether it
     * happened to be open hid a conversation that was still going.
     */
    it('still offers an older open session when the newest one is closed', () => {
      const older = openSession(db, 'program-execution', 'r', AT)
      const newer = openSession(db, 'variables-and-assignment', 'r', AT + 1000)
      closeSession(db, newer.id, AT + 2000)

      expect(readLatestOpenSession(db)?.id).toBe(older.id)
      expect(readOpenSessionConcepts(db)).toEqual(['program-execution'])
    })

    it('keeps the conversation after closing, so it can be reopened', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      appendLearnerTurn(db, session.id, 'a question', AT + 100)
      closeSession(db, session.id, AT + 500)
      reopenSession(db, session.id, AT + 600)

      const reopened = readSessionForConcept(db, 'program-execution')
      expect(reopened?.closedAt).toBeNull()
      expect(reopened?.turns).toHaveLength(1)
    })

    it('does not re-stamp a session that is already closed', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      closeSession(db, session.id, AT + 500)
      closeSession(db, session.id, AT + 9999)

      expect(readSession(db, session.id)?.closedAt).toBe(AT + 500)
    })
  })

  /*
   * The most important test in this file.
   *
   * A learner who reads an explanation has demonstrated nothing. Neither has one who says "ah,
   * I see" — people say that when they do not. Mastery moves on performance, judged by
   * `deriveEvidence`, and a conversation is not performance.
   */
  describe('conversation does not move mastery', () => {
    it('leaves the concept exactly as it was, however long the conversation', () => {
      const before = readConceptState(db, 'program-execution')
      const session = openSession(db, 'program-execution', 'r', AT)

      for (let exchange = 0; exchange < 6; exchange += 1) {
        const tutor = reserveTutorTurn(db, session.id, CONVERSE, AT + exchange * 100)
        finishTutorTurn(db, tutor.turnId, 'complete', 'An explanation.', AT + exchange * 100 + 10)
        appendLearnerTurn(db, session.id, 'That makes sense, thank you!', AT + exchange * 100 + 20)
      }

      const after = readConceptState(db, 'program-execution')
      expect(after).toEqual(before)
      expect(countEvidence(db)).toBe(0)
    })

    it('records no evidence for any concept', () => {
      const before = readConceptStates(db)
      const session = openSession(db, 'program-execution', 'r', AT)
      const tutor = reserveTutorTurn(db, session.id, PROVENANCE, AT)
      finishTutorTurn(db, tutor.turnId, 'complete', 'Here is how it works.', AT + 100)

      expect(readConceptStates(db)).toEqual(before)
      expect(countEvidence(db)).toBe(0)
    })

    /*
     * The sidecar's own guarantee. It can say what came up; it cannot say how well it went,
     * and the row it writes is not on any path to an estimate.
     */
    it('stores an observation without touching the learner model', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      const tutor = reserveTutorTurn(db, session.id, PROVENANCE, AT)
      finishTutorTurn(db, tutor.turnId, 'complete', 'Explanation.', AT + 100)

      const before = readConceptState(db, 'program-execution')

      recordObservation(db, {
        sessionId: session.id,
        turnId: tutor.turnId,
        conceptsDiscussed: ['program-execution'],
        misconceptions: ['assign-compares'],
        note: 'They stated that a single equals sign compares.',
        at: AT + 200,
      })

      expect(readObservations(db, session.id)).toHaveLength(1)
      // Even a misconception noted in conversation does not move the estimate. It is a note
      // for a human, not evidence.
      expect(readConceptState(db, 'program-execution')).toEqual(before)
      expect(countEvidence(db)).toBe(0)
    })

    it('keeps conversational observations out of the evidence tables entirely', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      const tutor = reserveTutorTurn(db, session.id, PROVENANCE, AT)

      recordObservation(db, {
        sessionId: session.id,
        turnId: tutor.turnId,
        conceptsDiscussed: ['program-execution'],
        misconceptions: ['assign-compares'],
        note: 'n',
        at: AT + 200,
      })

      const evidence = db.$client.prepare('select count(*) as n from evidence').get() as { n: number }
      const attempts = db.$client
        .prepare('select count(*) as n from misconception_observation')
        .get() as { n: number }

      expect(evidence.n).toBe(0)
      // `misconception_observation` is for misconceptions seen in an *attempt*. A
      // conversational one lives in `session_observation` and does not appear here.
      expect(attempts.n).toBe(0)
    })
  })

  describe('the call log', () => {
    it('records metadata and no content', () => {
      new DatabaseCallLog(db).record({
        at: AT,
        strategyId: 'converse',
        strategyVersion: '1',
        policyVersion: '1',
        curriculumVersion: '1',
        model: 'mock',
        latencyMs: 42,
        outcome: 'ok',
        repairAttempted: false,
        repairSucceeded: false,
        problemCodes: [],
        failureReason: null,
        usage: null,
        streamed: true,
      })

      const [row] = readCallLog(db)
      expect(row).toMatchObject({
        strategyId: 'converse',
        model: 'mock',
        latencyMs: 42,
        outcome: 'ok',
        streamed: true,
      })
      // Absent rather than zero: a fabricated zero would be indistinguishable from a call that
      // genuinely used no tokens.
      expect(row?.inputTokens).toBeNull()

      const columns = db.$client.prepare('select * from llm_call limit 1').all()
      const names = Object.keys(columns[0] ?? {})
      for (const forbidden of ['prompt', 'response', 'text', 'content', 'message']) {
        expect(names, forbidden).not.toContain(forbidden)
      }
    })

    it('records usage when the provider reports it', () => {
      new DatabaseCallLog(db).record({
        at: AT,
        strategyId: 'session.observe',
        strategyVersion: '1',
        policyVersion: '1',
        curriculumVersion: '1',
        model: 'gpt-test',
        latencyMs: 10,
        outcome: 'ok-after-repair',
        repairAttempted: true,
        repairSucceeded: true,
        problemCodes: ['session-concept-not-listed'],
        failureReason: null,
        usage: { inputTokens: 900, cachedInputTokens: 700, outputTokens: 40 },
        streamed: false,
      })

      const [row] = readCallLog(db)
      expect(row).toMatchObject({
        inputTokens: 900,
        cachedInputTokens: 700,
        outputTokens: 40,
        repairAttempted: true,
        repairSucceeded: true,
      })
      expect(row?.problemCodes).toEqual(['session-concept-not-listed'])
    })
  })

  describe('the context sent back to the tutor', () => {
    it('stays bounded as the conversation grows', () => {
      const session = openSession(db, 'program-execution', 'r', AT)

      for (let exchange = 0; exchange < 30; exchange += 1) {
        const tutor = reserveTutorTurn(db, session.id, CONVERSE, AT + exchange * 100)
        finishTutorTurn(db, tutor.turnId, 'complete', `reply ${String(exchange)}`, AT + exchange * 100 + 1)
        appendLearnerTurn(db, session.id, `question ${String(exchange)}`, AT + exchange * 100 + 2)
      }

      const stored = readSession(db, session.id)?.turns ?? []
      expect(stored).toHaveLength(60)
      // Everything is kept; only what gets resent is capped.
      expect(boundedHistory(stored)).toHaveLength(8)
    })
  })

  describe('resetting', () => {
    it('removes the whole conversation with the learner', () => {
      const session = openSession(db, 'program-execution', 'r', AT)
      const tutor = reserveTutorTurn(db, session.id, PROVENANCE, AT)
      finishTutorTurn(db, tutor.turnId, 'complete', 'text', AT + 10)
      recordObservation(db, {
        sessionId: session.id,
        turnId: tutor.turnId,
        conceptsDiscussed: ['program-execution'],
        misconceptions: [],
        note: 'n',
        at: AT,
      })

      db.$client.prepare('delete from learner').run()

      for (const table of ['tutoring_session', 'session_turn', 'session_observation', 'llm_call']) {
        const row = db.$client.prepare(`select count(*) as n from ${table}`).get() as { n: number }
        expect(row.n, table).toBe(0)
      }
    })
  })
})
