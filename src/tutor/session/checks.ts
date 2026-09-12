import type { ConceptId, MisconceptionId } from '@/domain/curriculum/types'
import { describeGround, type CheckDecision } from '@/domain/assessment/select'
import { shuffleOptions } from '@/domain/assessment/shuffle'
import type { PracticeItem } from '@/domain/assessment/items'
import type { TutorProvider } from '@/llm/provider'

import { quizGenerateStrategy } from '../strategies/assessment'
import type { CallLogSink } from '../logging/call-log'
import { runLoggedStructured } from './tutor'

/**
 * Turning a decision to check understanding into a question that can be stored.
 *
 * Two sources, and the preference between them is deliberate. An authored item is used wherever
 * one exists, because the cost of an unreliable assessment item is a false diagnosis written
 * into a record about a person — and a question that must genuinely probe a *particular*
 * misconception is a hard thing to generate reliably. Generation fills the concepts the bank
 * does not reach.
 *
 * Whichever source it came from, the options are shuffled before storage (see `shuffle.ts`), so
 * the position of the correct answer carries no information and the author does not have to
 * think about it. The shuffled order is what is stored, marked and shown.
 */

export interface PreparedActivity {
  readonly conceptId: ConceptId
  readonly kind: PracticeItem['kind']
  readonly itemId: string | null
  readonly origin: 'authored' | 'generated'
  readonly prompt: string
  readonly code: string | null
  readonly options: readonly string[] | null
  readonly correctIndex: number | null
  readonly optionMisconceptions: readonly (string | null)[] | null
  readonly expectedOutput: string | null
  readonly knownWrongAnswers:
    | readonly { readonly answer: string; readonly misconception: string }[]
    | null
  readonly expectedPoints: string | null
  readonly explanation: string
  readonly selectionGround: string
  readonly probesMisconception: MisconceptionId | null
  readonly strategyId: string | null
  readonly strategyVersion: string | null
  readonly model: string | null
}

/** An authored item, ready to store. `seed` decides the option order; use the turn id. */
export function prepareAuthored(
  decision: Extract<CheckDecision, { kind: 'ask' }>,
  seed: string,
): PreparedActivity {
  const { item, ground } = decision
  const base = {
    conceptId: item.conceptId,
    kind: item.kind,
    itemId: item.id,
    origin: 'authored' as const,
    prompt: item.prompt,
    code: item.code ?? null,
    explanation: item.explanation,
    selectionGround: describeGround(ground),
    probesMisconception: ground.kind === 'probes-misconception' ? ground.misconception : null,
    strategyId: null,
    strategyVersion: null,
    model: null,
  }

  if (item.kind === 'choice') {
    const shuffled = shuffleOptions(
      {
        options: item.options,
        correctIndex: item.correctIndex,
        optionMisconceptions: item.optionMisconceptions,
      },
      seed,
    )

    return {
      ...base,
      options: shuffled.options,
      correctIndex: shuffled.correctIndex,
      optionMisconceptions: shuffled.optionMisconceptions,
      expectedOutput: null,
      knownWrongAnswers: null,
      expectedPoints: null,
    }
  }

  if (item.kind === 'predict-output') {
    return {
      ...base,
      options: null,
      correctIndex: null,
      optionMisconceptions: null,
      expectedOutput: item.expectedOutput,
      knownWrongAnswers: item.knownWrongAnswers.map((wrong) => ({ ...wrong })),
      expectedPoints: null,
    }
  }

  return {
    ...base,
    options: null,
    correctIndex: null,
    optionMisconceptions: null,
    expectedOutput: null,
    knownWrongAnswers: null,
    expectedPoints: item.expectedPoints,
  }
}

export interface GenerateInput {
  readonly provider: TutorProvider
  readonly model: string
  readonly conceptId: ConceptId
  readonly learner: Parameters<typeof quizGenerateStrategy.buildBlocks>[0]['learner']
  /** Questions already asked on this concept, so the model does not repeat one. */
  readonly avoid: readonly string[]
  readonly ground: Extract<CheckDecision, { kind: 'generate' }>['ground']
  readonly seed: string
  readonly log: CallLogSink
  readonly now: () => number
}

/**
 * Generates a multiple-choice question, or reports that it could not.
 *
 * Everything the M2 pipeline enforces applies: the schema, then the invariants the schema
 * cannot express — exactly one correct option by construction, no duplicate options, every
 * named misconception in the closed catalogue, no misconception on the correct option. A
 * question that fails all of that twice is not shown at all, because a broken assessment item
 * is worse than no check.
 *
 * `quiz.generate` has no safe fallback, and that is right: there is no generic question that
 * would be a fair thing to mark somebody on.
 */
export async function prepareGenerated(input: GenerateInput): Promise<PreparedActivity | null> {
  const outcome = await runLoggedStructured(
    input.provider,
    quizGenerateStrategy,
    { learner: input.learner, conceptId: input.conceptId, avoid: input.avoid },
    { model: input.model, log: input.log, now: input.now },
  )

  if (!outcome.ok) return null

  const quiz = outcome.value
  const shuffled = shuffleOptions(
    {
      options: quiz.options,
      correctIndex: quiz.correctIndex,
      optionMisconceptions: quiz.distractorMisconceptions,
    },
    input.seed,
  )

  return {
    conceptId: input.conceptId,
    kind: 'choice',
    itemId: null,
    origin: 'generated',
    prompt: quiz.question,
    code: null,
    options: shuffled.options,
    correctIndex: shuffled.correctIndex,
    optionMisconceptions: shuffled.optionMisconceptions,
    expectedOutput: null,
    knownWrongAnswers: null,
    expectedPoints: null,
    explanation: quiz.explanation,
    selectionGround: describeGround(input.ground),
    probesMisconception:
      input.ground.kind === 'probes-misconception' ? input.ground.misconception : null,
    strategyId: quizGenerateStrategy.id,
    strategyVersion: quizGenerateStrategy.version,
    model: input.model,
  }
}
