import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDb, createDb, runMigrations, type Db } from '@/db/client'
import { readSessionActivities } from '@/db/repositories/activity-repository'
import {
  countEvidence,
  ensureLearner,
  readConceptState,
  readConceptStates,
  readProfile,
  saveConfidence,
  saveExperience,
  saveGoal,
} from '@/db/repositories/learner-repository'
import { readDataGeneration, resetEverything } from '@/db/repositories/meta-repository'
import { finishTutorTurn, readAllSessions, readSession } from '@/db/repositories/session-repository'
import { recordAttempt } from '@/db/repositories/learner-repository'
import { MILLISECONDS_PER_DAY } from '@/domain/learner-model/parameters'
import { selectNextConcept, stateLookupFrom } from '@/domain/scheduling/select'

/**
 * Starting, reviewing and resetting, through the real server actions and a real database.
 *
 * The questions here are the lifecycle ones a learner meets across days rather than minutes:
 * does a concept that has come due open as a review, does opening it change anything by itself,
 * and can a page left open before a reset put any of the deleted data back.
 */

const state: { db: Db | null } = { db: null }

vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
}))
vi.mock('@/db/instance', () => ({
  getDb: () => {
    if (state.db === null) throw new Error('no test database')
    return state.db
  },
}))
vi.mock('@/llm/resolve', () => ({ resolveProvider: () => null }))

const actions = await import('../../../app/actions')

describe('the lifecycle actions', () => {
  let directory: string
  const now = Date.now()

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tutor-m7-flow-'))
    state.db = createDb(join(directory, 'tutor.db'))
    runMigrations(state.db)
    ensureLearner(state.db, now)
    saveGoal(state.db, now, { goal: 'Understand loops', interests: [] })
    saveExperience(state.db, now, 'some-python')
    saveConfidence(state.db, now, {})
  })

  afterEach(() => {
    if (state.db !== null) closeDb(state.db)
    state.db = null
    rmSync(directory, { recursive: true, force: true })
  })

  function db(): Db {
    if (state.db === null) throw new Error('no db')
    return state.db
  }

  function generation(): number {
    return readDataGeneration(db())
  }

  /**
   * A learner returning to something they had settled.
   *
   * Built out of real answers through `recordAttempt`, because that is the only way concept
   * state is ever written, and then the clock is wound forward the only way a test can: by
   * moving the scheduled date into the past, which is what three weeks passing would do.
   */
  function makeDue(): void {
    for (let index = 0; index < 4; index += 1) {
      recordAttempt(db(), 'practice', {
        attemptId: `warm-${String(index)}`,
        conceptId: 'program-execution',
        itemId: 'p-exec-order',
        itemDifficulty: 0,
        correct: true,
        hintDepth: 0,
        misconceptions: [],
        observedAt: now - (20 - index) * MILLISECONDS_PER_DAY,
      })
    }

    db()
      .$client.prepare('UPDATE concept_state SET next_review_at = ? WHERE concept_id = ?')
      .run(now - 3 * MILLISECONDS_PER_DAY, 'program-execution')
  }

  /** The opening turn, streamed and finished, as the session page would leave it. */
  function settleOpening(sessionId: string, turnId?: string): void {
    const opening =
      turnId === undefined
        ? readSession(db(), sessionId)?.turns.find((turn) => turn.ordinal === 0)
        : readSession(db(), sessionId)?.turns.find((turn) => turn.id === turnId)

    if (opening === undefined) throw new Error('no opening turn')
    finishTutorTurn(db(), opening.id, 'complete', 'Here is the idea again, briefly.', now)
  }

  describe('starting a session', () => {
    it('opens an ordinary sitting for new material, and says why in its own words', async () => {
      const result = await actions.startSession('program-execution', generation())

      if (result.status !== 'ready') throw new Error(`expected a session, got ${result.status}`)
      const session = readSession(db(), result.sessionId)
      expect(session?.mode).toBe('teach')
      expect(session?.openedReason).toContain('Starting how a program runs'.slice(0, 8))
    })

    it('opens a review when the scheduler says the concept is due, and records why', async () => {
      makeDue()

      const result = await actions.startSession('program-execution', generation())

      if (result.status !== 'ready') throw new Error('expected a session')
      const session = readSession(db(), result.sessionId)
      expect(session?.mode).toBe('review')
      // What the page shows: why this sitting, falling back to why the conversation began.
      expect(session?.resumedReason ?? session?.openedReason).toContain('due for review')
    })

    it('turns the same conversation from a lesson into a review when it next comes due', async () => {
      const first = await actions.startSession('program-execution', generation())
      if (first.status !== 'ready') throw new Error('expected a session')
      expect(readSession(db(), first.sessionId)?.mode).toBe('teach')
      const openedReason = readSession(db(), first.sessionId)?.openedReason

      makeDue()
      const second = await actions.startSession('program-execution', generation())

      if (second.status !== 'ready') throw new Error('expected a session')
      expect(second.sessionId).toBe(first.sessionId)
      expect(readSession(db(), second.sessionId)?.mode).toBe('review')
      // Why it began is kept; why they are here today is recorded separately.
      expect(readSession(db(), second.sessionId)?.openedReason).toBe(openedReason)
      expect(readSession(db(), second.sessionId)?.resumedReason).toContain('due for review')
    })

    it('records nothing about the learner merely because a review was opened', async () => {
      makeDue()
      const before = { evidence: countEvidence(db()), due: readConceptState(db(), 'program-execution').nextReviewAt }

      await actions.startSession('program-execution', generation())

      expect(countEvidence(db())).toBe(before.evidence)
      expect(readConceptState(db(), 'program-execution').nextReviewAt).toBe(before.due)
    })

    it('refuses a concept the scheduler has not chosen and there is no conversation about', async () => {
      expect((await actions.startSession('dictionaries', generation())).status).toBe('nothing-to-study')
    })
  })

  describe('a review sitting', () => {
    it('asks its question straight away, rather than holding for some teaching first', async () => {
      makeDue()
      const opened = await actions.startSession('program-execution', generation())
      if (opened.status !== 'ready') throw new Error('expected a session')
      settleOpening(opened.sessionId)

      const result = await actions.askCheck(opened.sessionId)

      expect(result.status).toBe('asked')
      const [activity] = readSessionActivities(db(), opened.sessionId)
      expect(activity?.selectionGround).toContain('review')
    })

    it('holds a lesson back until something has been said, as before', async () => {
      const opened = await actions.startSession('program-execution', generation())
      if (opened.status !== 'ready') throw new Error('expected a session')
      settleOpening(opened.sessionId)

      const result = await actions.askCheck(opened.sessionId)

      expect(result).toMatchObject({ status: 'held', because: 'too-early' })
    })

    it('does not become due again until the learner has actually answered something', async () => {
      makeDue()
      const evidenceBefore = countEvidence(db())
      const opened = await actions.startSession('program-execution', generation())
      if (opened.status !== 'ready') throw new Error('expected a session')
      settleOpening(opened.sessionId)
      await actions.askCheck(opened.sessionId)

      // Asked, unanswered: still due, and still no evidence.
      expect(readConceptState(db(), 'program-execution').nextReviewAt).toBeLessThan(now)
      expect(countEvidence(db())).toBe(evidenceBefore)
    })
  })

  /*
   * The case the review was built for, and the one nothing exercised: a concept that already
   * has a conversation. Everything the M7 review found under H1 lives here — the sitting has to
   * begin, the tutor has to open it, and the sitting's own history has to decide what can
   * happen, not a conversation from three weeks ago.
   */
  describe('returning to a conversation that already exists', () => {
    /** A lesson, a message and an answered question, all in one sitting some weeks ago. */
    async function taughtAndChecked(): Promise<string> {
      const opened = await actions.startSession('program-execution', generation())
      if (opened.status !== 'ready') throw new Error('expected a session')
      settleOpening(opened.sessionId)
      await actions.sendMessage(opened.sessionId, 'That makes sense.')

      const replied = readSession(db(), opened.sessionId)?.turns.at(-1)
      if (replied === undefined) throw new Error('no reply turn')
      finishTutorTurn(db(), replied.id, 'complete', 'Good — here is the next part.', now)

      const asked = await actions.askCheck(opened.sessionId)
      if (asked.status !== 'asked') throw new Error(`expected a question, got ${asked.status}`)
      await actions.submitActivityAnswer(asked.activityId, '0')

      // The sitting ended here, long enough ago that returning is a new one.
      db()
        .$client.prepare('UPDATE tutoring_session SET updated_at = ?, resumed_at = ? WHERE id = ?')
        .run(now - 21 * MILLISECONDS_PER_DAY, now - 21 * MILLISECONDS_PER_DAY, opened.sessionId)
      db()
        .$client.prepare('UPDATE session_turn SET created_at = ? WHERE session_id = ?')
        .run(now - 21 * MILLISECONDS_PER_DAY, opened.sessionId)

      return opened.sessionId
    }

    it('starts a new sitting, with a turn for the tutor to open it', async () => {
      const sessionId = await taughtAndChecked()
      const turnsBefore = readSession(db(), sessionId)?.turns.length ?? 0
      makeDue()

      const reopened = await actions.startSession('program-execution', generation())

      expect(reopened).toMatchObject({ status: 'ready', sessionId })
      const session = readSession(db(), sessionId)
      expect(session?.mode).toBe('review')
      expect(session?.resumedAt).toBeGreaterThan(now - MILLISECONDS_PER_DAY)
      // A turn of its own, waiting for the tutor: without it the learner lands on a three-week
      // old conversation with nothing new in it, and the model is never told it is a review.
      expect(session?.turns).toHaveLength(turnsBefore + 1)
      expect(session?.turns.at(-1)).toMatchObject({ role: 'tutor', status: 'pending' })
    })

    it('opens with the question, even though the last sitting ended on one', async () => {
      const sessionId = await taughtAndChecked()
      makeDue()
      await actions.startSession('program-execution', generation())
      settleOpening(sessionId, readSession(db(), sessionId)?.turns.at(-1)?.id)

      const result = await actions.askCheck(sessionId)

      expect(result.status).toBe('asked')
    })

    it('stops lifting the holds once the review is answered, and stays the sitting it was', async () => {
      const sessionId = await taughtAndChecked()
      makeDue()
      await actions.startSession('program-execution', generation())

      // Answered: the scheduler has moved the next review into the future.
      db()
        .$client.prepare('UPDATE concept_state SET next_review_at = ? WHERE concept_id = ?')
        .run(now + 7 * MILLISECONDS_PER_DAY, 'program-execution')
      settleOpening(sessionId, readSession(db(), sessionId)?.turns.at(-1)?.id)

      /*
       * The holds apply again, and this asserts it: nothing has been said in this sitting, so an
       * ordinary sitting holds with `too-early`. The earlier version asserted "asked" in a state
       * where no hold could have applied either way, so it did not test its own claim (M7 fresh
       * review finding M-3).
       */
      expect(await actions.askCheck(sessionId)).toMatchObject({ status: 'held', because: 'too-early' })

      // And the sitting is still the review it began as — its purpose is fixed for the sitting,
      // so the export records a review as a review (finding M-2).
      expect(readSession(db(), sessionId)?.mode).toBe('review')
    })

    it('keeps the sitting a review after the learner writes in it', async () => {
      const sessionId = await taughtAndChecked()
      makeDue()
      await actions.startSession('program-execution', generation())
      const before = readSession(db(), sessionId)
      settleOpening(sessionId, before?.turns.at(-1)?.id)

      db()
        .$client.prepare('UPDATE concept_state SET next_review_at = ? WHERE concept_id = ?')
        .run(now + 7 * MILLISECONDS_PER_DAY, 'program-execution')
      await actions.sendMessage(sessionId, 'I think I remember it now.')

      /*
       * Every in-session action used to recompute the purpose from the scheduler's opinion *now*,
       * which changes the moment the learner answers: the review became a lesson mid-sitting and
       * the header read "Starting how a program runs" over a five-turn conversation (M-2).
       */
      const after = readSession(db(), sessionId)
      expect(after?.mode).toBe('review')
      expect(after?.resumedReason).toBe(before?.resumedReason)
    })

    it('holds a returning lesson back until something has been said in this sitting', async () => {
      const sessionId = await taughtAndChecked()
      // Not due: an ordinary lesson, coming back three weeks later.
      await actions.startSession('program-execution', generation())
      settleOpening(sessionId, readSession(db(), sessionId)?.turns.at(-1)?.id)

      // Counted over the conversation, the learner's message three weeks ago spent `too-early`.
      expect(await actions.askCheck(sessionId)).toMatchObject({ status: 'held', because: 'too-early' })
    })

    /*
     * M7 fresh review finding H-1. Once the opening turn was stopped, "ordinal 0 is not complete"
     * stayed true for ever, and every press of Continue appended another tutor turn — and another
     * provider call re-answering the same message.
     */
    it('opens a sitting once, however often Continue is pressed after a stopped opening', async () => {
      const opened = await actions.startSession('program-execution', generation())
      if (opened.status !== 'ready') throw new Error('expected a session')
      const opening = readSession(db(), opened.sessionId)?.turns[0]
      if (opening === undefined) throw new Error('no opening')
      await actions.cancelTutorTurn(opening.id, 'A program runs one line')

      await actions.sendMessage(opened.sessionId, 'Can you just tell me the short version?')
      const reply = readSession(db(), opened.sessionId)?.turns.at(-1)
      if (reply === undefined) throw new Error('no reply turn')
      finishTutorTurn(db(), reply.id, 'complete', 'The short version is…', now)
      const settled = readSession(db(), opened.sessionId)?.turns.length ?? 0

      await actions.startSession('program-execution', generation())
      await actions.startSession('program-execution', generation())
      await actions.startSession('program-execution', generation())

      expect(readSession(db(), opened.sessionId)?.turns).toHaveLength(settled)
    })

    /*
     * M7 fresh review finding M-1. A new sitting took over the trailing tutor turn whenever it
     * was unfinished — including a reply the learner had stopped part-way through, erasing the
     * half they had read from the transcript and the export.
     */
    it('never erases a reply the learner stopped, when a new sitting begins', async () => {
      const sessionId = await taughtAndChecked()
      await actions.sendMessage(sessionId, 'Why does that happen?')
      const reply = readSession(db(), sessionId)?.turns.at(-1)
      if (reply === undefined) throw new Error('no reply turn')
      await actions.cancelTutorTurn(reply.id, 'Because the interpreter reads each line ')

      // Three weeks later.
      db()
        .$client.prepare('UPDATE tutoring_session SET updated_at = ? WHERE id = ?')
        .run(now - 21 * MILLISECONDS_PER_DAY, sessionId)
      await actions.startSession('program-execution', generation())

      const stopped = readSession(db(), sessionId)?.turns.find((turn) => turn.id === reply.id)
      expect(stopped).toMatchObject({ status: 'cancelled', text: 'Because the interpreter reads each line ' })
      // The new sitting has a turn of its own, after it.
      expect(readSession(db(), sessionId)?.turns.at(-1)).toMatchObject({ role: 'tutor', status: 'pending' })
      expect(readSession(db(), sessionId)?.turns.at(-1)?.id).not.toBe(reply.id)
    })

    /*
     * M7 fresh review finding H-2. A bookmark, Back, or the "still open" list lands on the page
     * without going through Home, and nothing started the sitting.
     */
    it('starts the sitting for a conversation reached by a link, once', async () => {
      const sessionId = await taughtAndChecked()
      const turnsBefore = readSession(db(), sessionId)?.turns.length ?? 0
      makeDue()

      await actions.resumeSitting(sessionId)
      await actions.resumeSitting(sessionId)

      const session = readSession(db(), sessionId)
      expect(session?.mode).toBe('review')
      expect(session?.turns).toHaveLength(turnsBefore + 1)
      expect(session?.turns.at(-1)).toMatchObject({ role: 'tutor', status: 'pending' })
    })

    it('leaves a finished conversation finished when it is merely looked at', async () => {
      const sessionId = await taughtAndChecked()
      await expect(actions.finishSession(sessionId)).rejects.toThrow('redirect:/home')
      const turnsBefore = readSession(db(), sessionId)?.turns.length ?? 0

      await actions.resumeSitting(sessionId)

      expect(readSession(db(), sessionId)?.closedAt).not.toBeNull()
      expect(readSession(db(), sessionId)?.turns).toHaveLength(turnsBefore)
    })

    it('reopens a finished conversation when the scheduler brings it back and Home is pressed', async () => {
      const sessionId = await taughtAndChecked()
      await expect(actions.finishSession(sessionId)).rejects.toThrow('redirect:/home')

      const reopened = await actions.startSession('program-execution', generation())

      expect(reopened).toMatchObject({ status: 'ready', sessionId })
      expect(readSession(db(), sessionId)?.closedAt).toBeNull()
    })

    it('picks a finished conversation back up when the learner writes in it again', async () => {
      const sessionId = await taughtAndChecked()
      // The action redirects to Home once it has closed the session; the redirect is the mock's.
      await expect(actions.finishSession(sessionId)).rejects.toThrow('redirect:/home')
      expect(readSession(db(), sessionId)?.closedAt).not.toBeNull()

      const sent = await actions.sendMessage(sessionId, 'Actually, one more thing.')

      expect(sent.status).toBe('sent')
      // Open again, so Home talks about the conversation the learner is actually in (finding M4).
      expect(readSession(db(), sessionId)?.closedAt).toBeNull()
      expect(readSession(db(), sessionId)?.resumedAt).toBeGreaterThan(now - MILLISECONDS_PER_DAY)
    })
  })

  /*
   * M7 fresh review finding M-4. With a review outstanding, every other concept was refused.
   */
  describe('a review the learner would rather not do now', () => {
    it('does not keep the scheduler’s second choice out of reach', async () => {
      makeDue()
      // The scheduler's own second choice, asked of the domain rather than guessed here.
      const second = selectNextConcept(stateLookupFrom(readConceptStates(db())), Date.now(), { includeReviews: false })
      if (second === null) throw new Error('no second choice')
      expect(second.conceptId).not.toBe('program-execution')

      const started = await actions.startSession(second.conceptId, generation())

      expect(started.status).toBe('ready')
      if (started.status !== 'ready') return
      // Started as what it is: an ordinary sitting, not a review.
      expect(readSession(db(), started.sessionId)?.mode).toBe('teach')
      // And the scheduler still does not accept a concept it chose neither way.
      expect((await actions.startSession('dictionaries', generation())).status).toBe('nothing-to-study')
    })
  })

  describe('after the data has been deleted', () => {
    it('refuses a session opened from a page rendered before the reset', async () => {
      const stale = generation()
      resetEverything(db(), now)
      ensureLearner(db(), now)

      const result = await actions.startSession('program-execution', stale)

      expect(result.status).toBe('stale')
      expect(readAllSessions(db())).toEqual([])
    })

    it('refuses onboarding answers from a page rendered before the reset', async () => {
      const stale = generation()
      resetEverything(db(), now)

      const form = new FormData()
      form.set('goal', 'Something the learner typed an hour ago')
      form.set('generation', String(stale))

      expect(await actions.submitGoal(form)).toEqual({ status: 'stale' })
      expect(readProfile(db())?.goal ?? null).toBeNull()
    })

    it('refuses a diagnostic answer from a page rendered before the reset', async () => {
      const stale = generation()
      resetEverything(db(), now)

      const result = await actions.submitDiagnosticAnswer('print-value', '1', null, stale)

      expect(result.status).toBe('failed')
      expect(countEvidence(db())).toBe(0)
      // And no diagnostic session was started by the attempt.
      expect(db().$client.prepare('SELECT COUNT(*) AS n FROM diagnostic_session').all()).toEqual([{ n: 0 }])
    })

    it('accepts the same answers once the page has been reloaded', async () => {
      resetEverything(db(), now)

      const form = new FormData()
      form.set('goal', 'A fresh start')
      form.set('generation', String(generation()))

      expect(await actions.submitGoal(form)).toEqual({ status: 'saved' })
      expect(readProfile(db())?.goal).toBe('A fresh start')
    })
  })
})
