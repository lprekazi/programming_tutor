import type { MisconceptionId } from '../curriculum/types'
import { describeChecks, type PracticalMarking } from './mark'
import { presentExercise, type PresentedExercise, type StoredExercise } from './present'
import type { CheckOutcome } from './types'

/**
 * Everything the exercise interface is given, assembled in one place.
 *
 * The page and the actions both hand exercises to the browser, and a second assembly path is how
 * a field leaks: somebody adds the reference solution to one of them "just for the hint". So both
 * go through here, and `view.test.ts` asserts over the serialised result.
 */

export const HINT_LADDER_LENGTH = 3

/**
 * How long notes may stay "being written" before the view stops waiting for them.
 *
 * Notes are written inside the submission request, so a pending row older than any request could
 * take belongs to a request that died part-way (a closed server, a crash). Without a limit the
 * learner would be told the notes are coming, forever (M6 review finding F-17).
 */
export const PENDING_NOTES_GIVE_UP_MS = 2 * 60 * 1000

export interface CheckView {
  readonly name: string
  readonly outcome: CheckOutcome
  /** The exception class that failed it, where one was raised. */
  readonly error: string | null
}

export interface FeedbackView {
  readonly summary: string
  readonly observations: readonly { readonly where: string; readonly what: string }[]
  readonly nextStep: string
}

export interface SubmissionView {
  readonly id: string
  readonly ordinal: number
  readonly state: 'passed' | 'failed' | 'crashed' | 'unmarked'
  /** "2 of 3 checks pass", or why nothing was marked. */
  readonly checksLine: string
  /** Empty for an unmarked submission, where no check result is meaningful. */
  readonly checks: readonly CheckView[]
  /** The exception that stopped the program before the checks, where one did. */
  readonly crash: { readonly type: string; readonly message: string } | null
  readonly counted: boolean
  readonly hintsTaken: number
  readonly feedbackStatus: 'pending' | 'given' | 'unavailable' | 'not-requested'
  readonly feedback: FeedbackView | null
}

export interface ExerciseView {
  readonly exercise: PresentedExercise
  /** What the editor opens with: the learner's latest code, or the starter. */
  readonly code: string
  readonly hints: readonly { readonly depth: number; readonly text: string }[]
  readonly hintLadderLength: number
  /** Oldest first. */
  readonly submissions: readonly SubmissionView[]
  /** True once a submission has passed. Nothing further can be submitted. */
  readonly finished: boolean
}

/** The stored record, as far as the view needs to know about it. */
export interface ExerciseSource extends StoredExercise {
  readonly draftCode: string | null
  readonly hints: readonly { readonly depth: number; readonly text: string }[]
  readonly submissions: readonly {
    readonly id: string
    readonly ordinal: number
    readonly state: 'passed' | 'failed' | 'crashed' | 'unmarked'
    readonly passedChecks: number | null
    readonly totalChecks: number
    readonly unmarkedReason: string | null
    readonly misconceptions: readonly MisconceptionId[]
    readonly counted: boolean
    readonly hintsTaken: number
    readonly feedbackStatus: 'pending' | 'given' | 'unavailable' | 'not-requested'
    readonly feedback: unknown
    readonly outcome: unknown
    readonly submittedAt: number
  }[]
}

export function viewOfExercise(source: ExerciseSource, now: number): ExerciseView {
  return {
    exercise: presentExercise(source),
    code: source.draftCode ?? source.starterCode,
    hints: source.hints.map((hint) => ({ depth: hint.depth, text: hint.text })),
    hintLadderLength: HINT_LADDER_LENGTH,
    submissions: source.submissions.map((submission) =>
      viewOfSubmission(source, submission, now),
    ),
    finished: source.submissions.some((submission) => submission.state === 'passed'),
  }
}

function viewOfSubmission(
  source: ExerciseSource,
  submission: ExerciseSource['submissions'][number],
  now: number,
): SubmissionView {
  const marking: PracticalMarking =
    submission.state === 'unmarked'
      ? { kind: 'unmarked', reason: submission.unmarkedReason ?? 'This submission could not be marked.' }
      : {
          kind: 'marked',
          passed: submission.state === 'passed',
          passedChecks: submission.passedChecks ?? 0,
          totalChecks: submission.totalChecks,
          misconceptions: submission.misconceptions,
          state: submission.state,
        }

  const reported = readOutcome(submission.outcome)

  return {
    id: submission.id,
    ordinal: submission.ordinal,
    state: submission.state,
    checksLine: describeChecks(marking),
    checks:
      submission.state === 'unmarked' || reported === null
        ? []
        : source.tests.map((test, index) => ({
            name: test.name,
            outcome: reported.checks[index]?.outcome ?? 'fail',
            error: reported.checks[index]?.error ?? null,
          })),
    crash: reported?.crash ?? null,
    counted: submission.counted,
    hintsTaken: submission.hintsTaken,
    feedbackStatus:
      submission.feedbackStatus === 'pending' && now - submission.submittedAt > PENDING_NOTES_GIVE_UP_MS
        ? 'unavailable'
        : submission.feedbackStatus,
    feedback: submission.feedbackStatus === 'given' ? readFeedback(submission.feedback) : null,
  }
}

/** The stored outcome is JSON the browser reported; read it defensively, field by field. */
function readOutcome(value: unknown): {
  readonly checks: readonly { readonly outcome: CheckOutcome; readonly error: string | null }[]
  readonly crash: { readonly type: string; readonly message: string } | null
} | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { kind?: unknown; checks?: unknown; crash?: unknown }
  if (candidate.kind !== 'ran' || !Array.isArray(candidate.checks)) return null

  const checks = candidate.checks.map((entry: unknown) => {
    const check = entry as { outcome?: unknown; error?: unknown }
    return {
      outcome: check.outcome === 'pass' ? ('pass' as const) : ('fail' as const),
      error: typeof check.error === 'string' ? check.error : null,
    }
  })

  const crashValue = candidate.crash as { type?: unknown; message?: unknown } | null | undefined
  const crash =
    crashValue !== null &&
    crashValue !== undefined &&
    typeof crashValue.type === 'string' &&
    typeof crashValue.message === 'string'
      ? { type: crashValue.type, message: crashValue.message }
      : null

  return { checks, crash }
}

function readFeedback(value: unknown): FeedbackView | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { summary?: unknown; observations?: unknown; nextStep?: unknown }
  if (typeof candidate.summary !== 'string' || typeof candidate.nextStep !== 'string') return null

  const observations = Array.isArray(candidate.observations)
    ? candidate.observations.flatMap((entry: unknown) => {
        const observation = entry as { where?: unknown; what?: unknown }
        return typeof observation.where === 'string' && typeof observation.what === 'string'
          ? [{ where: observation.where, what: observation.what }]
          : []
      })
    : []

  return { summary: candidate.summary, observations, nextStep: candidate.nextStep }
}
