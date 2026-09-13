import { candidateKey, type ExerciseCandidate } from '@/db/repositories/exercise-repository'
import { getConcept } from '@/domain/curriculum/graph'
import type { ConceptId } from '@/domain/curriculum/types'
import { EXERCISE_BANK_VERSION } from '@/domain/exercises/bank'
import type { PracticalMarking } from '@/domain/exercises/mark'
import { describeExerciseGround, type ExerciseGround } from '@/domain/exercises/select'
import type { AuthoredExercise, ExerciseTest } from '@/domain/exercises/types'
import type { TutorProvider } from '@/llm/provider'

import type { LearnerContext } from '../blocks/learner'
import type { CallLogSink } from '../logging/call-log'
import {
  codeFeedbackStrategy,
  codeTaskGenerateStrategy,
  hintStrategy,
  type CodeFeedback,
} from '../strategies/coding'
import { runLoggedStructured } from './tutor'

/**
 * Turning a decision to set an exercise into something that can be stored, and the three places
 * a model is involved once it has been set.
 *
 * None of these functions marks anything. Marking is `markPractical`, in the domain, over what
 * running the code produced; everything here either prepares a task, writes a hint, or writes
 * notes on a result that has already been decided.
 */

export function candidateFromAuthored(exercise: AuthoredExercise, ground: ExerciseGround): ExerciseCandidate {
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
    selectionGround: describeExerciseGround(ground),
    // Authored exercises are verified by the test suite in a real interpreter, not on demand.
    verification: 'verified',
    generationAttempt: 0,
    strategyId: null,
    strategyVersion: null,
    model: null,
  }
}

/** How far a generated exercise's declared difficulty moves it from the concept's own. */
const DECLARED_OFFSET: Readonly<Record<'easier' | 'typical' | 'harder', number>> = {
  easier: -0.4,
  typical: 0,
  harder: 0.4,
}

export interface GenerateExerciseInput {
  readonly provider: TutorProvider
  readonly model: string
  readonly conceptId: ConceptId
  readonly learner: LearnerContext
  readonly avoid: readonly string[]
  readonly ground: ExerciseGround
  /** 1 for the first attempt, 2 for the one regeneration. */
  readonly attempt: 1 | 2
  /** Why the previous candidate was rejected, fed back so the second attempt does not repeat it. */
  readonly previousProblem: string | null
  readonly log: CallLogSink
  readonly now: () => number
}

/**
 * Asks for an exercise, returning an **unverified** candidate or null.
 *
 * Schema-valid is not enough to set it: the candidate still has to pass verification in the
 * browser before a learner sees it (ADR-0006). Null means the model could not produce anything
 * that even passed the invariants, after its one repair.
 */
export async function generateExercise(input: GenerateExerciseInput): Promise<ExerciseCandidate | null> {
  const outcome = await runLoggedStructured(
    input.provider,
    codeTaskGenerateStrategy,
    {
      learner: input.learner,
      conceptId: input.conceptId,
      avoid: input.avoid,
      previousProblem: input.previousProblem,
    },
    { model: input.model, log: input.log, now: input.now },
  )

  if (!outcome.ok) return null
  const task = outcome.value

  return {
    conceptId: input.conceptId,
    kind: 'write',
    origin: 'generated',
    exerciseId: null,
    bankVersion: null,
    title: task.title,
    brief: task.brief,
    starterCode: task.starterCode,
    tests: task.tests,
    referenceSolution: task.referenceSolution,
    // A generated exercise names no misconceptions: a signal is only trustworthy with a witness
    // that has been run, and the model does not write those.
    signals: [],
    authoredHints: null,
    difficulty: getConcept(input.conceptId).baselineDifficulty + DECLARED_OFFSET[task.declaredDifficulty],
    selectionGround: describeExerciseGround(input.ground),
    verification: 'unverified',
    generationAttempt: input.attempt,
    strategyId: codeTaskGenerateStrategy.id,
    strategyVersion: codeTaskGenerateStrategy.version,
    model: input.model,
  }
}

/** What the browser needs to verify a candidate, and nothing else. Never rendered. */
export interface VerificationBundle {
  /** Which candidate this is. The verdict has to name it back. */
  readonly candidate: string
  readonly referenceSolution: string
  readonly starterCode: string
  readonly tests: readonly ExerciseTest[]
}

export function verificationBundle(candidate: {
  readonly referenceSolution: string
  readonly starterCode: string
  readonly tests: readonly ExerciseTest[]
}): VerificationBundle {
  return {
    candidate: candidateKey(candidate),
    referenceSolution: candidate.referenceSolution,
    starterCode: candidate.starterCode,
    tests: candidate.tests.map((test) => ({ name: test.name, code: test.code })),
  }
}

export interface ModelHintInput {
  readonly provider: TutorProvider
  readonly model: string
  readonly conceptId: ConceptId
  readonly learner: LearnerContext
  readonly brief: string
  readonly learnerCode: string | null
  readonly depth: number
  readonly previousHints: readonly string[]
  readonly referenceSolution: string
  readonly log: CallLogSink
  readonly now: () => number
}

/**
 * A hint for a generated exercise, which has no authored ladder.
 *
 * The reference solution goes into the strategy's *input* so the leak check can compare against
 * it, and never into the prompt.
 */
export async function writeHint(input: ModelHintInput): Promise<string | null> {
  const outcome = await runLoggedStructured(
    input.provider,
    hintStrategy,
    {
      learner: input.learner,
      conceptId: input.conceptId,
      brief: input.brief,
      learnerAttempt: input.learnerCode,
      depth: input.depth,
      previousHints: input.previousHints,
      referenceSolution: input.referenceSolution,
    },
    { model: input.model, log: input.log, now: input.now },
  )

  return outcome.ok ? outcome.value.text : null
}

export interface FeedbackInput {
  readonly provider: TutorProvider
  readonly model: string
  readonly conceptId: ConceptId
  readonly learner: LearnerContext
  readonly brief: string
  readonly code: string
  readonly output: string
  readonly checkNames: readonly string[]
  readonly marking: Extract<PracticalMarking, { kind: 'marked' }>
  readonly failedChecks: readonly string[]
  readonly referenceSolution: string
  readonly log: CallLogSink
  readonly now: () => number
}

/**
 * The tutor's notes on a submission whose result is already decided.
 *
 * The result goes in as authoritative and the strategy's invariants enforce it: notes on passing
 * code may not call it wrong or diagnose a misconception, and notes on failing code may not say it
 * works. Null when the notes could not be written — which leaves the result exactly as it was.
 */
export async function writeFeedback(input: FeedbackInput): Promise<CodeFeedback | null> {
  const outcome = await runLoggedStructured(
    input.provider,
    codeFeedbackStrategy,
    {
      learner: input.learner,
      conceptId: input.conceptId,
      brief: input.brief,
      learnerCode: input.code,
      executionOutput: input.output,
      failedTests: input.failedChecks,
      result: input.marking.state,
      referenceSolution: input.referenceSolution,
    },
    { model: input.model, log: input.log, now: input.now },
  )

  return outcome.ok ? outcome.value : null
}

/**
 * The record of an exercise for the tutor's context, written into the exercise's turn.
 *
 * Flat prose, like `summariseCheck`, and for the same reason the learner's code is not included:
 * an unquoted copy of learner-written text inside a tutor-attributed turn is an injection point.
 */
export function summariseExercise(input: {
  readonly title: string
  readonly brief: string
  readonly latest: {
    readonly state: 'passed' | 'failed' | 'crashed' | 'unmarked'
    readonly passedChecks: number | null
    readonly totalChecks: number
  } | null
  readonly hintsTaken: number
}): string {
  const result =
    input.latest === null
      ? 'They have not submitted it yet.'
      : input.latest.state === 'passed'
        ? 'Their latest submission passed every check.'
        : input.latest.state === 'crashed'
          ? 'Their latest submission stopped with an error before the checks could run.'
          : input.latest.state === 'unmarked'
            ? 'Their latest submission could not be marked.'
            : `Their latest submission passed ${String(input.latest.passedChecks ?? 0)} of ${String(input.latest.totalChecks)} checks.`

  const hints =
    input.hintsTaken === 0 ? '' : ` They took ${String(input.hintsTaken)} hint${input.hintsTaken === 1 ? '' : 's'}.`

  return `You set them a short programming exercise, "${input.title}":
${input.brief}

${result}${hints}`
}
