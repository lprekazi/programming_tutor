'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { getDb } from '@/db/instance'
import {
  completeDiagnostic,
  decideNext,
  openDiagnostic,
  skipItem,
  submitAnswer,
} from '@/db/repositories/diagnostic-repository'
import {
  readConceptStates,
  saveConfidence,
  saveExperience,
  saveGoal,
  reopenOnboardingAt,
  resetLearner,
} from '@/db/repositories/learner-repository'
import {
  appendLearnerTurn,
  closeSession,
  openSession,
  readSession,
  readSessionByTurn,
  readSessionForConcept,
  recordCancellation,
  reopenSession,
  reserveTutorTurn,
} from '@/db/repositories/session-repository'
import { isConceptId } from '@/domain/curriculum/graph'
import { MAX_MESSAGE_LENGTH, unfinishedTutorTurn } from '@/domain/tutoring/session'
import { describeSelection, selectNextConcept, stateLookupFrom } from '@/domain/scheduling/select'
import { converseStrategy, explainStrategy } from '@/tutor/strategies/prose'
import type { Area, ConceptId, MisconceptionId } from '@/domain/curriculum/types'
import type { Confidence } from '@/domain/onboarding/self-report'
import { getDiagnosticItem, isDeterministic } from '@/domain/diagnostic/items'
import { scoreAnswer, type ExecutionOutcome, type VerdictSource } from '@/domain/diagnostic/score'
import { resolveProvider } from '@/llm/resolve'
import { unmarkableItemIds } from '@/tutor/diagnostic-readiness'
import { UNKNOWN_LEARNER } from '@/tutor/blocks/learner'
import { answerEvaluateStrategy } from '@/tutor/strategies/assessment'
import { runStructured } from '@/tutor/validate/run'

import { RESET_CONFIRMATION } from './reset/confirmation'

/**
 * Everything the first-run journey writes.
 *
 * Scoring happens here, on the server, not in the browser. A multiple choice and an output
 * prediction are compared against the author's answer; a practical task is judged from its test
 * results; only a free-text explanation asks a model, and only because nothing else can read
 * it.
 *
 * No action in this file touches an ability estimate. They record an *answer*, and
 * `recordAttempt` hands it to the domain, which decides what it means. There is no parameter
 * anywhere here through which a mastery value could be supplied.
 */

/**
 * One text field from a form.
 *
 * A form entry is a string or a file, and a file coerced with `String` becomes the useless
 * `[object File]`. Anything that is not a string is simply absent rather than silently turned
 * into nonsense that would then be stored.
 */
function fieldOf(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

const AREAS = new Set<string>([
  'fundamentals',
  'variables-and-types',
  'expressions',
  'conditionals',
  'loops',
  'functions',
  'collections',
  'debugging',
  'decomposition',
  'object-oriented',
])

const EXPERIENCE_LEVELS = new Set<string>([
  'new-to-programming',
  'other-language',
  'some-python',
  'regular-python',
])

const CONFIDENCE_LEVELS = new Set<string>(['none', 'some', 'comfortable', 'confident'])

/**
 * What an onboarding step did.
 *
 * Returned rather than swallowed. The browser's `required` attribute catches an empty field
 * but not one holding three spaces, and a step that silently declines to advance leaves the
 * learner pressing Continue and watching nothing happen — which is indistinguishable, from
 * where they are sitting, from the application being broken.
 */
export type StepResult =
  | { readonly status: 'idle' }
  | { readonly status: 'saved' }
  | { readonly status: 'invalid'; readonly message: string }
  /** Onboarding is already finished — a stale form in another tab. Nothing was written. */
  | { readonly status: 'already-done' }

export async function submitGoal(formData: FormData): Promise<StepResult> {
  const goal = fieldOf(formData, 'goal').trim()
  const interests = formData
    .getAll('interests')
    .filter((value): value is string => typeof value === 'string' && AREAS.has(value)) as Area[]

  if (goal.length === 0) {
    return {
      status: 'invalid',
      message: 'Write something first — a rough sentence is enough.',
    }
  }

  const written = saveGoal(getDb(), Date.now(), { goal: goal.slice(0, 500), interests })
  revalidatePath('/welcome')
  return written === 'saved' ? { status: 'saved' } : { status: 'already-done' }
}

export async function submitExperience(formData: FormData): Promise<StepResult> {
  const experience = fieldOf(formData, 'experience')
  if (!EXPERIENCE_LEVELS.has(experience)) {
    return { status: 'invalid', message: 'Choose one of the four before continuing.' }
  }

  const written = saveExperience(getDb(), Date.now(), experience)
  revalidatePath('/welcome')
  return written === 'saved' ? { status: 'saved' } : { status: 'already-done' }
}

/**
 * Steps back to an earlier question so an answer can be changed.
 *
 * Onboarding is three questions and takes under a minute, but a learner who picks the wrong
 * experience level and cannot undo it has one route out — deleting everything — which is a
 * ridiculous price for a mis-click. The answers themselves are untouched: the forms are
 * prefilled from what was stored, so stepping back shows what they said rather than a blank.
 */
export async function goBackTo(step: 'goal' | 'experience'): Promise<void> {
  reopenOnboardingAt(getDb(), Date.now(), step)
  revalidatePath('/welcome')
}

export async function submitConfidence(formData: FormData): Promise<StepResult> {
  const confidence: Partial<Record<Area, Confidence>> = {}

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('confidence.')) continue

    const area = key.slice('confidence.'.length)
    if (typeof value !== 'string') continue
    if (!AREAS.has(area) || !CONFIDENCE_LEVELS.has(value)) continue

    confidence[area as Area] = value as Confidence
  }

  const written = saveConfidence(getDb(), Date.now(), confidence)
  revalidatePath('/welcome')
  revalidatePath('/diagnostic')

  if (written === 'saved') return { status: 'saved' }
  // Refused because onboarding is already finished, or because answers already exist. Either
  // way nothing was overwritten, which is the point.
  return { status: 'already-done' }
}

/**
 * What the browser reports after running a practical item.
 *
 * Trusted for this item's verdict and nothing else, because Python runs only in the browser and
 * there is nowhere else the result could come from. The trade-off is recorded in ADR-0019.
 *
 * "Nothing else" is enforced rather than assumed: the report is checked for internal
 * consistency before it is used, it can only ever mark the item currently being asked, and no
 * field in it can express an ability estimate.
 */
export interface ExecutionReport {
  readonly allTestsPassed: boolean
  readonly failedTests: readonly string[]
  readonly output: string
}

/** A report that contradicts itself came from something other than the harness. */
function isCoherent(execution: ExecutionReport): boolean {
  return !execution.allTestsPassed || execution.failedTests.length === 0
}

interface Judged {
  readonly correct: boolean
  readonly conceptId: ConceptId
  /** How the answer was marked, so the learner can be told rather than left to assume. */
  readonly verdictSource: VerdictSource
  /** The expected answer, where there is one to show. Null for a written explanation. */
  readonly correctAnswer: string | null
  readonly explanation: string
}

export type AnswerResult =
  | ({ readonly status: 'recorded' } & Judged)
  /** Already answered. Nothing was recorded a second time. */
  | ({ readonly status: 'already-answered' } & Judged)
  /** A model was needed and could not be reached. Nothing was recorded. */
  | { readonly status: 'cannot-judge'; readonly message: string }
  /**
   * This is not the question the diagnostic is asking. Nothing was recorded.
   *
   * Reached by a stale tab, a replayed request, or a hand-crafted one. Without the check, any
   * item in the bank could be answered at any time — including after the diagnostic was
   * finished — and the planner, which is consulted when the page renders, would never see it.
   */
  | { readonly status: 'not-current' }
  /** Something failed on the way. Nothing was recorded, and the learner is told so. */
  | { readonly status: 'failed'; readonly message: string }

/**
 * Records one diagnostic answer.
 *
 * The repository refuses a repeat, so a double-click, a refresh mid-request or a component
 * firing twice cannot produce two pieces of evidence from one answer.
 */
export async function submitDiagnosticAnswer(
  itemId: string,
  answer: string,
  execution: ExecutionReport | null,
): Promise<AnswerResult> {
  const db = getDb()
  const now = Date.now()
  const item = getDiagnosticItem(itemId)
  const progress = openDiagnostic(db, now)

  if (execution !== null && !isCoherent(execution)) {
    return {
      status: 'failed',
      message: 'That run could not be read, so nothing has been recorded. Run the checks again.',
    }
  }

  const outcome: ExecutionOutcome | undefined =
    execution === null
      ? undefined
      : { allTestsPassed: execution.allTestsPassed, failedTests: execution.failedTests }

  // Checked before anything expensive happens. A repeat submission changes nothing, so there
  // is no reason to pay for a model call to re-judge an answer that is already stored.
  const previous = progress.answers.find((entry) => entry.itemId === itemId)
  if (previous !== undefined) {
    return {
      status: 'already-answered',
      correct: previous.correct,
      conceptId: previous.conceptId,
      verdictSource: markingOf(item),
      correctAnswer: expectedAnswerOf(item),
      explanation: 'explanation' in item ? item.explanation : '',
    }
  }

  // Checked on the way in, not only when the page rendered. `decideNext` is the single
  // authority on what may be answered, and this is where a write consults it.
  const decision = decideNext(db, progress, unmarkableItemIds())
  if (decision.kind !== 'ask' || decision.item.id !== itemId) return { status: 'not-current' }

  const verdict = scoreAnswer(item, answer, outcome)

  let correct: boolean
  let misconceptions: readonly MisconceptionId[] = []
  let source: VerdictSource
  let explanation: string

  if (verdict.kind === 'scored') {
    correct = verdict.correct
    misconceptions = verdict.misconceptions
    source = verdict.source
    explanation = 'explanation' in item ? item.explanation : ''
  } else {
    // Only a free-text explanation reaches here, and only because nothing else can read it.
    const judged = await judgeExplanation(item.prompt, answer, itemId)
    if (judged === null) {
      // Honest failure. Recording a guess would put fabricated evidence against a learner
      // because a network call did not come back.
      return {
        status: 'cannot-judge',
        message:
          'The tutor could not read that answer just now, so nothing has been recorded for it. You can carry on — this topic will simply stay unassessed.',
      }
    }
    correct = judged.correct
    misconceptions = judged.misconceptions
    source = 'model'
    explanation = judged.explanation
  }

  const result = submitAnswer(db, {
    sessionId: progress.sessionId,
    itemId,
    answer,
    correct,
    verdictSource: source,
    misconceptions,
    executionOutput: execution?.output,
    failedTests: execution?.failedTests,
    at: now,
  })

  return {
    status: result.recorded ? 'recorded' : 'already-answered',
    correct: result.correct,
    conceptId: result.conceptId,
    verdictSource: source,
    correctAnswer: expectedAnswerOf(item),
    explanation,
  }
}

/** How an item's answers are marked. Fixed by the kind of item, so it can be recovered. */
function markingOf(item: ReturnType<typeof getDiagnosticItem>): VerdictSource {
  if (item.kind === 'explain') return 'model'
  if (item.kind === 'code') return 'execution'
  return 'deterministic'
}

/**
 * The answer the learner was aiming at, where showing it is useful.
 *
 * A written explanation has no single right form of words, so nothing is claimed to be *the*
 * answer; the judgement's own reasoning is shown instead.
 */
function expectedAnswerOf(item: ReturnType<typeof getDiagnosticItem>): string | null {
  switch (item.kind) {
    case 'choice':
      return item.options[item.correctIndex] ?? null
    case 'predict-output':
      return item.expectedOutput
    case 'code':
    case 'explain':
      return null
  }
}

/**
 * Asks a model to judge a free-text answer.
 *
 * Returns null when the tutor cannot be reached or its response could not be used. The caller
 * records nothing in that case — the concept stays unassessed rather than being guessed at.
 */
async function judgeExplanation(
  question: string,
  answer: string,
  itemId: string,
): Promise<{ correct: boolean; misconceptions: readonly MisconceptionId[]; explanation: string } | null> {
  const resolved = resolveProvider()
  if (resolved === null) return null

  const item = getDiagnosticItem(itemId)
  const outcome = await runStructured(resolved.provider, answerEvaluateStrategy, {
    learner: UNKNOWN_LEARNER,
    conceptId: item.conceptId,
    question,
    expected: 'expectedPoints' in item ? item.expectedPoints : null,
    learnerAnswer: answer,
  })

  if (!outcome.ok) return null

  return {
    correct: outcome.value.correct,
    misconceptions: outcome.value.misconceptions,
    explanation: outcome.value.explanation,
  }
}

/**
 * Sets aside a question that could not be marked.
 *
 * Nothing is recorded against the learner — not a wrong answer, not a guess. The question
 * simply stops being offered, and the end-of-diagnostic summary says it was left out.
 */
export async function skipDiagnosticItem(itemId: string): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const progress = openDiagnostic(db, now)
  const decision = decideNext(db, progress, unmarkableItemIds())

  // Only the question actually being asked, and only one that cannot be marked without help
  // that is unavailable. Otherwise a replayed request could set aside every markable item and
  // reduce the diagnostic to nothing.
  if (decision.kind !== 'ask' || decision.item.id !== itemId) return
  if (isDeterministic(decision.item) && !unmarkableItemIds().includes(itemId)) return

  skipItem(db, progress.sessionId, itemId)
}

/** Marks the diagnostic finished. Safe to call more than once. */
export async function finishDiagnostic(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const progress = openDiagnostic(db, now)
  const decision = decideNext(db, progress, unmarkableItemIds())

  if (decision.kind !== 'finished') return

  completeDiagnostic(db, progress.sessionId, decision.reason, now)
  revalidatePath('/')
  revalidatePath('/diagnostic')
  revalidatePath('/home')
  redirect('/home')
}

export type ResetResult =
  | { readonly status: 'idle' }
  /** What was typed did not match. Nothing was deleted. */
  | { readonly status: 'mismatch' }

/**
 * Deletes the learner's entire history.
 *
 * The typed confirmation is checked here rather than only in the browser, so the action cannot
 * destroy anything on the strength of a check that a page could have skipped.
 */
export async function resetEverything(formData: FormData): Promise<ResetResult> {
  const typed = fieldOf(formData, 'confirmation').trim().toLowerCase()
  if (typed !== RESET_CONFIRMATION) return { status: 'mismatch' }

  resetLearner(getDb())
  revalidatePath('/')
  revalidatePath('/welcome')
  revalidatePath('/diagnostic')
  revalidatePath('/home')
  redirect('/')
}

// ---------------------------------------------------------------------------
// Tutoring sessions
// ---------------------------------------------------------------------------

export type StartResult =
  | { readonly status: 'ready'; readonly sessionId: string }
  /** The scheduler has nothing to recommend. */
  | { readonly status: 'nothing-to-study' }

/**
 * Opens the session for a concept and makes sure it has an opening turn to stream.
 *
 * Idempotent twice over. The session is unique on `(learner, concept)`, so pressing Start
 * twice finds the same conversation; and the opening turn is reserved at ordinal zero, so a
 * second press finds the same row rather than reserving another. Neither depends on the
 * browser behaving.
 */
export async function startSession(conceptId: string): Promise<StartResult> {
  const db = getDb()
  const now = Date.now()

  if (!isConceptId(conceptId)) return { status: 'nothing-to-study' }

  const selection = selectNextConcept(stateLookupFrom(readConceptStates(db)), now)
  const existing = readSessionForConcept(db, conceptId)

  // A concept can be studied when the scheduler currently recommends it, or when there is
  // already a conversation about it to continue. Anything else is a stale link or a guess at
  // a URL, and starting teaching on the strength of one would step around the scheduler.
  if (existing === null && selection?.conceptId !== conceptId) {
    return { status: 'nothing-to-study' }
  }

  const reason = existing?.openedReason ?? (selection === null ? '' : describeSelection(selection))
  const session = openSession(db, conceptId, reason, now)
  reopenSession(db, session.id, now)

  // Reserved here so the session page has a turn to stream the moment it loads. Idempotent:
  // a second press finds the same row rather than reserving another.
  const opening = session.turns.find((turn) => turn.ordinal === 0)
  if (opening === undefined || opening.status !== 'complete') {
    reserveTutorTurn(db, session.id, openingProvenance(), now)
  }

  revalidatePath('/home')
  revalidatePath(`/session/${session.id}`)
  return { status: 'ready', sessionId: session.id }
}

function openingProvenance() {
  return {
    strategyId: explainStrategy.id,
    strategyVersion: explainStrategy.version,
    model: resolveProvider()?.model ?? 'unavailable',
  }
}

export type SendResult =
  | { readonly status: 'sent'; readonly learnerTurnId: string; readonly tutorTurnId: string }
  /** Nothing was stored. The learner's text is still in the box where they left it. */
  | { readonly status: 'rejected'; readonly message: string }

/**
 * Stores what the learner wrote and reserves the tutor's reply.
 *
 * The learner's words are committed *before* any model call is attempted, which is what makes
 * a provider failure survivable: their message is in the conversation, the tutor's turn is
 * sitting there marked failed, and retrying re-streams into the same row.
 */
export async function sendMessage(sessionId: string, text: string): Promise<SendResult> {
  const db = getDb()
  const now = Date.now()
  const trimmed = text.trim()

  if (trimmed.length === 0) {
    return { status: 'rejected', message: 'Write something first.' }
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return {
      status: 'rejected',
      message: `That is longer than ${String(MAX_MESSAGE_LENGTH)} characters. Shorten it, or ask about one thing at a time.`,
    }
  }

  const session = readSession(db, sessionId)
  if (session === null) return { status: 'rejected', message: 'That session no longer exists.' }

  /*
   * An unfinished tutor turn is closed off rather than used to refuse the learner.
   *
   * Refusing was a dead end: a reply whose cancellation never reached the server sits at
   * `pending` for ever, and the learner could then never send anything again.
   *
   * Only a turn that was still waiting becomes a cancellation. A turn that *failed* stays
   * failed: telling a learner they stopped a reply the tutor dropped is a small lie, and the
   * two endings are kept apart everywhere else precisely because they mean different things.
   */
  const unfinished = unfinishedTutorTurn(session.turns)
  if (unfinished !== null && (unfinished.status === 'pending' || unfinished.status === 'streaming')) {
    recordCancellation(db, unfinished.id, unfinished.text, now)
  }

  const appended = appendLearnerTurn(db, sessionId, trimmed, now)
  if (!appended.stored) {
    // Another message reached this position first — two tabs, or a click that beat the render.
    // Said out loud rather than reporting a send that did not happen.
    return {
      status: 'rejected',
      message: 'Something else was sent first. Reload the page to see where the conversation is.',
    }
  }
  const tutorTurn = reserveTutorTurn(
    db,
    sessionId,
    {
      strategyId: converseStrategy.id,
      strategyVersion: converseStrategy.version,
      model: resolveProvider()?.model ?? 'unavailable',
    },
    now,
  )

  return { status: 'sent', learnerTurnId: appended.turn.id, tutorTurnId: tutorTurn.turnId }
}

/**
 * Records that the learner stopped a reply.
 *
 * Said explicitly rather than inferred from the connection dropping. A client aborting its
 * fetch does not reliably reach a streaming route handler as an abort, and when it does not,
 * the request runs to the end and stores the reply as though it had been read — so Stop
 * appeared to work and then the full text returned on the next reload.
 *
 * The text the learner actually saw is what gets stored, and `finishTutorTurn` refuses to let
 * the request that is still finishing overwrite it.
 */
export async function cancelTutorTurn(turnId: string, textSoFar: string): Promise<void> {
  const db = getDb()
  const session = readSessionByTurn(db, turnId)
  if (session === null) return

  // Named by id, not by position: a stale client would otherwise cancel whichever turn happens
  // to be last rather than the one it was actually streaming.
  const turn = session.turns.find((candidate) => candidate.id === turnId)
  if (turn === undefined || turn.role !== 'tutor' || turn.status === 'complete') return

  // Capped at the same limit the domain puts on a learner message. The text is the client's
  // account of what it displayed, which is the only source for it — but it is stored, rendered
  // through `TutorProse`, and excluded from the conversation the model is sent, so the worst a
  // forged value achieves is a wrong note in the learner's own transcript.
  recordCancellation(db, turnId, textSoFar.slice(0, MAX_MESSAGE_LENGTH * 10), Date.now())
}

/**
 * Prepares an interrupted tutor turn to be streamed again.
 *
 * Returns the same turn id every time, because the row already exists. That is the whole
 * defence against a retry appending a second copy of the reply.
 */
export async function retryTutorTurn(sessionId: string): Promise<{ readonly turnId: string } | null> {
  const db = getDb()
  const session = readSession(db, sessionId)
  if (session === null) return null

  const last = unfinishedTutorTurn(session.turns)
  if (last === null) return null

  const isOpening = last.ordinal === 0
  return {
    turnId: reserveTutorTurn(
      db,
      sessionId,
      isOpening
        ? openingProvenance()
        : {
            strategyId: converseStrategy.id,
            strategyVersion: converseStrategy.version,
            model: resolveProvider()?.model ?? 'unavailable',
          },
      Date.now(),
    ).turnId,
  }
}

/** Marks the session finished for now. The conversation is kept and can be reopened. */
export async function finishSession(sessionId: string): Promise<void> {
  closeSession(getDb(), sessionId, Date.now())
  revalidatePath('/home')
  redirect('/home')
}
