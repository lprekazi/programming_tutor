'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { getDb } from '@/db/instance'
import { readSessionActivities } from '@/db/repositories/activity-repository'
import { DatabaseCallLog } from '@/db/repositories/call-log-repository'
import {
  createExercise,
  logGeneration,
  readExercise,
  readSessionExercises,
  readUsedExerciseIds,
  recordExerciseHint,
  recordSubmissionFeedback,
  replaceCandidate,
  saveDraft,
  settleVerification,
  submitExerciseAttempt,
  type ExerciseRecord,
} from '@/db/repositories/exercise-repository'
import {
  readConceptState,
  readConceptStates,
  readProfile,
  readRecentMisconceptions,
} from '@/db/repositories/learner-repository'
import {
  finishTutorTurn,
  readSession,
  reserveActivityTurn,
} from '@/db/repositories/session-repository'
import type { ConceptId } from '@/domain/curriculum/types'
import { isUnchangedStarter, markPractical, type PracticalOutcome } from '@/domain/exercises/mark'
import {
  decideExercise,
  fallbackExercise,
  type ExerciseGround,
  type ExerciseHold,
} from '@/domain/exercises/select'
import { viewOfExercise, type ExerciseView } from '@/domain/exercises/view'
import { replyInProgress } from '@/domain/tutoring/session'
import { resolveProvider } from '@/llm/resolve'
import { tutoringContext } from '@/tutor/session/context'
import { codeFeedbackStrategy, hintStrategy } from '@/tutor/strategies/coding'
import { candidateKey } from '@/db/repositories/exercise-repository'
import {
  candidateFromAuthored,
  generateExercise,
  summariseExercise,
  verificationBundle,
  writeFeedback,
  writeHint,
  type VerificationBundle,
} from '@/tutor/session/exercises'

/**
 * Everything a programming exercise does on the server.
 *
 * What is **not** here is as important as what is. No Python runs on this side: the learner's code,
 * the checks and any generated reference solution all run in the browser's Pyodide worker, and
 * what arrives here is a report of the result. Nothing here marks an attempt either — that is
 * `markPractical` in the domain — and nothing a model writes can reach the marking or the
 * evidence.
 */

/** Long enough for any exercise this project sets, short enough that nothing absurd is stored. */
const MAX_CODE_LENGTH = 20_000

/** Output passed to the feedback strategy. The rest is not needed to comment on a result. */
const MAX_FEEDBACK_OUTPUT = 4_000

export type ExerciseResult =
  /** An exercise is on the page, ready to work on. */
  | { readonly status: 'set'; readonly exerciseId: string }
  /**
   * A generated candidate needs checking in the browser before anyone can see it.
   *
   * The bundle is the one place a reference solution leaves the server, and it goes straight to a
   * dedicated verification worker (ADR-0006). It is never rendered and never stored in the page.
   */
  | { readonly status: 'verify'; readonly exerciseId: string; readonly bundle: VerificationBundle }
  | { readonly status: 'held'; readonly because: ExerciseHold }
  | { readonly status: 'unavailable'; readonly message: string }

function learnerContextFor(db: ReturnType<typeof getDb>, conceptId: ConceptId) {
  const profile = readProfile(db)
  return tutoringContext({
    goal: profile?.goal ?? null,
    conceptId,
    states: readConceptStates(db),
    recentMisconceptions: readRecentMisconceptions(db),
  })
}

/**
 * Sets an exercise in a session, if this is a moment for one.
 *
 * Idempotent through the turn, like a question, and an exercise still waiting for verification
 * resumes verification instead of being generated again. Remounting the page never replaces a task.
 *
 * "One thing at a time" means an exercise with **no submission yet** holds off anything new. Once
 * something has been submitted the learner may move on, even if the exercise is not passed —
 * deliberately, since nothing should trap a learner in a task they would rather leave (the M5
 * lesson, finding F-13). The earlier comment here claimed an unfinished exercise was always
 * returned instead; that was never what the code did (M6 review finding F-14).
 */
export async function askExercise(sessionId: string): Promise<ExerciseResult> {
  // See `recordExerciseVerification` for why the bundle carries a candidate key.
  const db = getDb()
  const now = Date.now()

  const session = readSession(db, sessionId)
  if (session === null) return { status: 'unavailable', message: 'That session no longer exists.' }

  if (replyInProgress(session.turns) !== null) {
    return { status: 'unavailable', message: 'The tutor is still replying. Ask again once that has finished.' }
  }

  const exercises = readSessionExercises(db, sessionId)

  // A candidate still being checked: pick verification up where it was left.
  const pending = exercises.find((exercise) => exercise.verification === 'unverified')
  if (pending !== undefined) {
    return { status: 'verify', exerciseId: pending.id, bundle: verificationBundle(pending) }
  }

  const openCheck = readSessionActivities(db, sessionId).some((activity) => activity.attempt === null)
  const openExercise = exercises.some(
    (exercise) => exercise.verification === 'verified' && exercise.submissions.length === 0,
  )

  const decision = decideExercise({
    conceptId: session.conceptId,
    state: readConceptState(db, session.conceptId),
    exchanges: session.turns.filter((turn) => turn.role === 'learner').length,
    exercisesThisSitting: exercises.filter(
      (exercise) => exercise.verification === 'verified' && exercise.createdAt >= session.resumedAt,
    ).length,
    openActivity: openCheck || openExercise,
    usedExerciseIds: readUsedExerciseIds(db),
    recentMisconceptions: readRecentMisconceptions(db),
  })

  if (decision.kind === 'hold') return { status: 'held', because: decision.because }

  const turn = reserveActivityTurn(db, sessionId, now)

  if (decision.kind === 'set') {
    const exercise = createExercise(db, {
      sessionId,
      turnId: turn.turnId,
      at: now,
      ...candidateFromAuthored(decision.exercise, decision.ground),
    })
    return settled(db, exercise, now)
  }

  // Nothing authored left for this concept: write one, and have the browser check it.
  const resolved = resolveProvider()
  if (resolved !== null) {
    const candidate = await generateExercise({
      provider: resolved.provider,
      model: resolved.model,
      conceptId: decision.conceptId,
      learner: learnerContextFor(db, decision.conceptId),
      avoid: exercises.map((exercise) => exercise.brief),
      ground: decision.ground,
      attempt: 1,
      previousProblem: null,
      log: new DatabaseCallLog(db),
      now: () => Date.now(),
    })

    if (candidate !== null) {
      const exercise = createExercise(db, { sessionId, turnId: turn.turnId, at: now, ...candidate })
      return { status: 'verify', exerciseId: exercise.id, bundle: verificationBundle(exercise) }
    }
  }

  // Generation was impossible or produced nothing usable. Something the concept builds on, if any.
  const fallback = fallbackExercise(decision.conceptId, readUsedExerciseIds(db))
  if (fallback !== null) {
    const exercise = createExercise(db, {
      sessionId,
      turnId: turn.turnId,
      at: now,
      ...candidateFromAuthored(fallback.exercise, fallback.ground),
    })
    logGeneration(db, {
      exerciseId: exercise.id,
      attempt: 1,
      outcome: 'fallback',
      reason: resolved === null ? 'no-provider' : 'generation-invalid',
      strategyVersion: null,
      model: resolved?.model ?? null,
      at: now,
    })
    return settled(db, exercise, now)
  }

  finishTutorTurn(db, turn.turnId, 'failed', '', now)
  return {
    status: 'unavailable',
    message:
      resolved === null
        ? 'There is no exercise for this topic that works without a tutor. The conversation above still stands.'
        : 'An exercise could not be prepared just now, so nothing has been set. The conversation above still stands.',
  }
}

/** An exercise is on the page: close its turn with a record for the tutor, and say so. */
function settled(db: ReturnType<typeof getDb>, exercise: ExerciseRecord, now: number): ExerciseResult {
  finishTutorTurn(
    db,
    exercise.turnId,
    'complete',
    summariseExercise({ title: exercise.title, brief: exercise.brief, latest: null, hintsTaken: 0 }),
    now,
  )
  revalidatePath(`/session/${exercise.sessionId}`)
  return { status: 'set', exerciseId: exercise.id }
}

const verdictSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('verified') }).strict(),
  z
    .object({
      status: z.literal('rejected'),
      reason: z.enum(['reference-fails', 'starter-solves', 'timeout']),
    })
    .strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
])

/** Sentences for the regeneration prompt. Written here, never copied from the rejected candidate. */
const REJECTION_SENTENCE: Readonly<Record<'reference-fails' | 'starter-solves' | 'timeout', string>> = {
  'reference-fails': 'its reference solution did not pass its own tests.',
  'starter-solves': 'its starter code already passed every test, so there was nothing to do.',
  timeout: 'running it did not finish in time.',
}

/**
 * Records what the browser found when it checked a generated candidate, and decides what next.
 *
 * Verified: the exercise is set. Rejected: one regeneration, fed the reason; a second rejection
 * falls back to an authored exercise the concept builds on, or reports that nothing could be
 * prepared. Unavailable — Python could not start — is not a verdict about the exercise at
 * all, so it is never set; the authored fallback is used instead, since that needs no checking.
 *
 * The verdict is the browser's report and ADR-0019's exposure applies: a learner who forged one
 * could set themselves a broken exercise. That harms nobody else and is recorded, not prevented.
 */
export async function recordExerciseVerification(
  exerciseId: string,
  candidate: string,
  verdict: unknown,
): Promise<ExerciseResult> {
  const db = getDb()
  const now = Date.now()

  const parsed = verdictSchema.safeParse(verdict)
  if (!parsed.success || typeof candidate !== 'string') {
    return { status: 'unavailable', message: 'That check could not be read.' }
  }

  const exercise = readExercise(db, exerciseId)
  if (exercise === null) return { status: 'unavailable', message: 'That exercise no longer exists.' }
  if (exercise.verification === 'verified') return { status: 'set', exerciseId }
  if (exercise.verification === 'rejected') {
    return { status: 'unavailable', message: 'An exercise could not be prepared just now.' }
  }

  // A verdict about a candidate that is no longer the stored one says nothing about what is stored
  // now. The browser is handed the current candidate to check instead (M6 review finding F-04).
  if (candidateKey(exercise) !== candidate) {
    return { status: 'verify', exerciseId, bundle: verificationBundle(exercise) }
  }

  if (parsed.data.status === 'verified') {
    if (!settleVerification(db, { id: exerciseId, verdict: 'verified', reason: null, at: now, candidate })) {
      const current = readExercise(db, exerciseId)
      return current !== null && current.verification === 'unverified'
        ? { status: 'verify', exerciseId, bundle: verificationBundle(current) }
        : { status: 'unavailable', message: 'An exercise could not be prepared just now.' }
    }
    const accepted = readExercise(db, exerciseId)
    if (accepted === null) return { status: 'unavailable', message: 'That exercise no longer exists.' }
    return settled(db, accepted, now)
  }

  const reason = parsed.data.status === 'rejected' ? parsed.data.reason : null
  logGeneration(db, {
    exerciseId,
    attempt: exercise.generationAttempt,
    outcome: reason === null ? 'unavailable' : 'rejected',
    reason: reason ?? 'python-unavailable',
    strategyVersion: exercise.strategyVersion,
    model: exercise.model,
    at: now,
  })

  const resolved = resolveProvider()
  if (reason !== null && exercise.generationAttempt === 1 && resolved !== null) {
    const ground: ExerciseGround = { kind: 'practice' }
    const regenerated = await generateExercise({
      provider: resolved.provider,
      model: resolved.model,
      conceptId: exercise.conceptId,
      learner: learnerContextFor(db, exercise.conceptId),
      avoid: [exercise.brief],
      ground,
      attempt: 2,
      previousProblem: REJECTION_SENTENCE[reason],
      log: new DatabaseCallLog(db),
      now: () => Date.now(),
    })

    if (regenerated !== null) {
      const replaced = replaceCandidate(db, exerciseId, regenerated, candidate)
      if (replaced !== null) {
        return { status: 'verify', exerciseId, bundle: verificationBundle(replaced) }
      }
      // Another flow replaced it first. Whatever is stored now is what needs checking.
      const current = readExercise(db, exerciseId)
      if (current !== null && current.verification === 'unverified') {
        return { status: 'verify', exerciseId, bundle: verificationBundle(current) }
      }
    }
  }

  const fallback = fallbackExercise(exercise.conceptId, readUsedExerciseIds(db))
  if (fallback !== null) {
    const replaced = replaceCandidate(
      db,
      exerciseId,
      candidateFromAuthored(fallback.exercise, fallback.ground),
      candidate,
    )
    if (replaced !== null) {
      logGeneration(db, {
        exerciseId,
        attempt: exercise.generationAttempt,
        outcome: 'fallback',
        reason: reason ?? 'python-unavailable',
        strategyVersion: null,
        model: null,
        at: now,
      })
      return settled(db, replaced, now)
    }
  }

  settleVerification(db, { id: exerciseId, verdict: 'rejected', reason: reason ?? 'python-unavailable', at: now, candidate })
  /*
   * Completed, not failed. A failed activity turn is reused by the next request for an exercise,
   * which then found the rejected exercise already sitting on it and handed back its old bundle —
   * a wasted model call and the same failure, every time, until the learner sent a message
   * (M6 review finding F-05). A complete turn is finished business; the next request gets a new one.
   * Its text is context for the tutor only, and is never rendered.
   */
  finishTutorTurn(db, exercise.turnId, 'complete', 'You tried to set them a short programming exercise, but none could be prepared.', now)
  revalidatePath(`/session/${exercise.sessionId}`)
  return {
    status: 'unavailable',
    message: 'An exercise could not be prepared just now, so nothing has been set. The conversation above still stands.',
  }
}

/**
 * Keeps the learner's latest code. Not evidence of anything, and never treated as such.
 *
 * `editedAt` is the browser's clock at the moment of the edit, so saves that arrive out of order
 * cannot put an older version back.
 */
export async function saveExerciseDraft(
  exerciseId: string,
  code: string,
  editedAt: number,
): Promise<{ readonly saved: boolean }> {
  if (typeof code !== 'string' || code.length > MAX_CODE_LENGTH || !Number.isFinite(editedAt)) {
    return Promise.resolve({ saved: false })
  }
  return Promise.resolve({ saved: saveDraft(getDb(), { id: exerciseId, code, editedAt }) })
}

export type ExerciseHintResult =
  | { readonly status: 'given'; readonly depth: number; readonly text: string }
  | { readonly status: 'unavailable'; readonly message: string }

/**
 * Hint `depth` for an exercise.
 *
 * An authored exercise answers from its own ladder, with no model — so hints work with no
 * provider configured. A generated one asks the hint strategy, whose output is checked against the
 * exercise's reference solution before it can be stored or shown.
 *
 * Asking for a hint is not evidence and changes nothing about the learner. How many were taken is
 * read when the exercise is submitted, and then only to attenuate a success (ADR-0005).
 */
export async function askExerciseHint(
  exerciseId: string,
  depth: number,
  currentCode: string | null,
): Promise<ExerciseHintResult> {
  const db = getDb()
  const now = Date.now()

  const exercise = readExercise(db, exerciseId)
  if (exercise === null || exercise.verification !== 'verified') {
    return { status: 'unavailable', message: 'That exercise no longer exists.' }
  }
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
    return { status: 'unavailable', message: 'There is no hint at that step.' }
  }

  const existing = exercise.hints.find((hint) => hint.depth === depth)
  if (existing !== undefined) return { status: 'given', depth, text: existing.text }
  if (depth !== exercise.hints.length + 1) {
    return { status: 'unavailable', message: 'Take the earlier hints first.' }
  }

  let text: string | null
  let source: 'authored' | 'model'
  let strategy: { id: string; version: string } | null = null
  let model: string | null = null

  if (exercise.authoredHints !== null) {
    text = exercise.authoredHints[depth - 1] ?? null
    source = 'authored'
  } else {
    const resolved = resolveProvider()
    if (resolved === null) {
      return { status: 'unavailable', message: 'No tutor is configured, so there is no hint to give for this exercise.' }
    }
    text = await writeHint({
      provider: resolved.provider,
      model: resolved.model,
      conceptId: exercise.conceptId,
      learner: learnerContextFor(db, exercise.conceptId),
      brief: exercise.brief,
      learnerCode:
        typeof currentCode === 'string' && currentCode.length <= MAX_CODE_LENGTH ? currentCode : exercise.draftCode,
      depth,
      previousHints: exercise.hints.map((hint) => hint.text),
      referenceSolution: exercise.referenceSolution,
      log: new DatabaseCallLog(db),
      now: () => Date.now(),
    })
    source = 'model'
    strategy = { id: hintStrategy.id, version: hintStrategy.version }
    model = resolved.model
  }

  if (text === null) return { status: 'unavailable', message: 'A hint could not be prepared just now.' }

  const stored = recordExerciseHint(db, {
    exerciseId,
    depth,
    text,
    source,
    strategyId: strategy?.id ?? null,
    strategyVersion: strategy?.version ?? null,
    model,
    at: now,
  })

  if (stored.status === 'refused') {
    return {
      status: 'unavailable',
      message:
        stored.reason === 'finished'
          ? 'This exercise is already done, so there is nothing left to hint at.'
          : 'Take the earlier hints first.',
    }
  }

  revalidatePath(`/session/${exercise.sessionId}`)
  return { status: 'given', depth: stored.hint.depth, text: stored.hint.text }
}

/**
 * What the browser reports about running the checks. Validated strictly: it is the one input from
 * which evidence is derived, and it arrives from the client.
 */
const outcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ran'),
      checks: z
        .array(
          z
            .object({
              outcome: z.enum(['pass', 'fail']),
              error: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/).nullable(),
            })
            .strict(),
        )
        .max(5),
      incomplete: z.boolean(),
      crash: z
        .object({ type: z.string().max(80), message: z.string().max(500) })
        .strict()
        .nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('timeout') }).strict(),
])

export type SubmitExerciseResult =
  | { readonly status: 'recorded'; readonly view: ExerciseView; readonly alreadySubmitted: boolean }
  | { readonly status: 'rejected'; readonly message: string }

/**
 * Submits code: marks the checks' result, records it, and — for the first markable submission
 * only — derives evidence, all before any model is asked anything.
 *
 * Then the tutor's notes, with the result stated to the model as settled and enforced afterwards.
 * If the notes cannot be written the submission, its marking and its evidence stand exactly as
 * they are, and the learner is told plainly that detailed feedback is not available.
 */
export async function submitExercise(
  exerciseId: string,
  code: string,
  reported: unknown,
  output: string,
): Promise<SubmitExerciseResult> {
  const db = getDb()
  const now = Date.now()

  if (typeof code !== 'string' || code.trim().length === 0) {
    return { status: 'rejected', message: 'Write some code before submitting.' }
  }
  if (code.length > MAX_CODE_LENGTH) {
    return { status: 'rejected', message: 'That is far longer than this exercise needs.' }
  }

  const parsed = outcomeSchema.safeParse(reported)
  if (!parsed.success) {
    return { status: 'rejected', message: 'The result of running your code could not be read. Run it again.' }
  }
  const outcome: PracticalOutcome = parsed.data

  const exercise = readExercise(db, exerciseId)
  if (exercise === null || exercise.verification !== 'verified') {
    return { status: 'rejected', message: 'That exercise no longer exists.' }
  }

  if (isUnchangedStarter(code, exercise.starterCode)) {
    return {
      status: 'rejected',
      message: 'This is still the code the exercise started with. Change it before submitting — running it is fine.',
    }
  }

  const marking = markPractical({ outcome, tests: exercise.tests, signals: exercise.signals, code })
  const result = submitExerciseAttempt(db, { exerciseId, code, outcome, marking, at: now })

  if (result.status === 'refused') {
    return {
      status: 'rejected',
      message:
        result.reason === 'already-passed'
          ? 'This exercise is already done.'
          : 'That exercise no longer exists.',
    }
  }

  if (result.created) {
    /*
     * The submission, its marking and its evidence are already committed at this point. Anything
     * that goes wrong from here is about the tutor's notes, and must not read as the submission
     * failing — the learner would be told to try again for something that was recorded, and the
     * notes would be left pending for ever. So a throw becomes "notes unavailable", which is true.
     */
    try {
      await attachFeedback(db, exercise, result.submission.id, code, marking, output)
    } catch {
      recordSubmissionFeedback(db, {
        submissionId: result.submission.id,
        status: 'unavailable',
        feedback: null,
        strategyId: null,
        strategyVersion: null,
        model: null,
      })
    }

    const latest = readExercise(db, exerciseId)
    if (latest !== null) {
      const newest = latest.submissions.at(-1) ?? null
      finishTutorTurn(
        db,
        latest.turnId,
        'complete',
        summariseExercise({
          title: latest.title,
          brief: latest.brief,
          latest: newest,
          hintsTaken: latest.hints.length,
        }),
        now,
      )
    }

    revalidatePath(`/session/${exercise.sessionId}`)
    revalidatePath('/home')
  }

  const fresh = readExercise(db, exerciseId)
  if (fresh === null) return { status: 'rejected', message: 'That exercise no longer exists.' }

  return { status: 'recorded', view: viewOfExercise(fresh, Date.now()), alreadySubmitted: !result.created }
}

async function attachFeedback(
  db: ReturnType<typeof getDb>,
  exercise: ExerciseRecord,
  submissionId: string,
  code: string,
  marking: ReturnType<typeof markPractical>,
  output: string,
): Promise<void> {
  if (marking.kind === 'unmarked') {
    recordSubmissionFeedback(db, {
      submissionId,
      status: 'not-requested',
      feedback: null,
      strategyId: null,
      strategyVersion: null,
      model: null,
    })
    return
  }

  const resolved = resolveProvider()
  if (resolved === null) {
    recordSubmissionFeedback(db, {
      submissionId,
      status: 'unavailable',
      feedback: null,
      strategyId: null,
      strategyVersion: null,
      model: null,
    })
    return
  }

  const stored = readExercise(db, exercise.id)?.submissions.find((submission) => submission.id === submissionId)
  const reported = stored?.outcome as { kind?: string; checks?: { outcome: string }[] } | undefined
  const failedChecks =
    reported?.kind === 'ran'
      ? exercise.tests.filter((_, index) => reported.checks?.[index]?.outcome !== 'pass').map((test) => test.name)
      : []

  const feedback = await writeFeedback({
    provider: resolved.provider,
    model: resolved.model,
    conceptId: exercise.conceptId,
    learner: learnerContextFor(db, exercise.conceptId),
    brief: exercise.brief,
    code,
    output: typeof output === 'string' ? output.slice(0, MAX_FEEDBACK_OUTPUT) : '',
    checkNames: exercise.tests.map((test) => test.name),
    marking,
    failedChecks,
    referenceSolution: exercise.referenceSolution,
    log: new DatabaseCallLog(db),
    now: () => Date.now(),
  })

  recordSubmissionFeedback(db, {
    submissionId,
    status: feedback === null ? 'unavailable' : 'given',
    feedback,
    strategyId: feedback === null ? null : codeFeedbackStrategy.id,
    strategyVersion: feedback === null ? null : codeFeedbackStrategy.version,
    model: feedback === null ? null : resolved.model,
  })
}

/** The exercise as the interface needs it. Used by the page after an action changes one. */
export async function readExerciseView(exerciseId: string): Promise<ExerciseView | null> {
  const exercise = readExercise(getDb(), exerciseId)
  if (exercise === null || exercise.verification !== 'verified') return Promise.resolve(null)
  return Promise.resolve(viewOfExercise(exercise, Date.now()))
}

