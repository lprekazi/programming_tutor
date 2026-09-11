import { z } from 'zod'

import { getConcept } from '@/domain/curriculum/graph'
import type { ConceptId } from '@/domain/curriculum/types'

import { composePrompt, quoteLearnerText } from '../blocks/compose'
import type { LearnerContext } from '../blocks/learner'
import {
  checkMisconceptionIds,
  checkNoDuplicates,
  conceptIdSchema,
  misconceptionIdSchema,
  proseText,
  shortText,
} from './shared'
import type { InvariantProblem, StructuredStrategy } from './types'

/**
 * Strategies that produce questions and judge answers.
 *
 * All three are structured, because all three affect what the application does next. None of
 * them returns anything about the learner's mastery — they describe *this answer*, and the
 * domain decides what that means.
 */

// ---------------------------------------------------------------------------
// quiz.generate
// ---------------------------------------------------------------------------

/**
 * A multiple-choice question whose wrong options are wrong for known reasons.
 *
 * Distractors are tied to catalogued misconceptions rather than being plausible-looking
 * noise. That is the difference between a question that measures something and a question
 * that scores something: when a learner picks option C, the system knows which wrong idea
 * they acted on, and can address it instead of just marking it.
 */
export const quizSchema = z
  .object({
    question: proseText,
    options: z.array(shortText).length(4),
    /** Index into `options`. An index rather than a flag: exactly one correct answer, structurally. */
    correctIndex: z.number().int().min(0).max(3),
    /**
     * For each wrong option, the misconception a learner choosing it is probably acting on.
     * `null` where the option is simply wrong rather than diagnostic.
     */
    distractorMisconceptions: z.array(misconceptionIdSchema.nullable()).length(4),
    /** Why the correct option is correct, shown after answering. */
    explanation: proseText,
  })
  .strict()

export type Quiz = z.infer<typeof quizSchema>

export interface QuizGenerateInput {
  readonly learner: LearnerContext
  readonly conceptId: ConceptId
  /** Questions already asked on this concept, so the model does not repeat one. */
  readonly avoid: readonly string[]
}

const QUIZ_INSTRUCTION = `TASK: write one multiple-choice question on the given concept.

Four options, exactly one correct.

The three wrong options must be wrong for a *reason* — each should be what a learner would
choose if they held a particular wrong idea. Where that idea is one of the misconceptions
listed above, name it for that option. Where an option is just wrong rather than diagnostic,
use null.

Do not write options that are obviously filler, obviously absurd, or different in length or
specificity from the correct one. A learner should not be able to pick the answer by its shape.

Ask about what code does, not about terminology. "What does this print?" beats "What is a
for loop?".

Keep the question to a few lines. Include a short code snippet where it helps.`

/** Options that differ only in whitespace or case are the same option to a learner. */
function normaliseOption(option: string): string {
  return option.trim().toLowerCase().replace(/\s+/g, ' ')
}

export const quizGenerateStrategy: StructuredStrategy<QuizGenerateInput, Quiz> = {
  kind: 'structured',
  id: 'quiz.generate',
  version: '1',
  purpose: 'Write one multiple-choice question whose distractors map to known misconceptions.',
  streams: false,
  schemaName: 'quiz',
  schema: quizSchema,
  buildBlocks(input) {
    const concept = getConcept(input.conceptId)
    const avoid =
      input.avoid.length === 0
        ? ''
        : `\n\nDo not repeat these, which they have already been asked:\n${input.avoid.map((question) => `- ${question}`).join('\n')}`

    return composePrompt({
      strategy: QUIZ_INSTRUCTION,
      learner: input.learner,
      task: `WRITE A QUESTION ON: ${concept.id} — ${concept.title}\n${concept.summary}${avoid}`,
    })
  },
  checkInvariants(output, _input, context) {
    const problems: InvariantProblem[] = []

    const normalised = output.options.map(normaliseOption)
    const unique = new Set(normalised)
    if (unique.size !== normalised.length) {
      problems.push({
        code: 'duplicate-options',
        detail:
          'Two or more options are the same once whitespace and capitalisation are ignored. Every option must be distinct.',
      })
    }

    // The correct option must not be flagged as diagnostic of a misconception: acting on a
    // wrong idea cannot be what leads a learner to the right answer.
    if (output.distractorMisconceptions[output.correctIndex] !== null) {
      problems.push({
        code: 'misconception-on-correct-option',
        detail: `Option ${String(output.correctIndex)} is the correct answer, so it must have null for its misconception.`,
      })
    }

    const named = output.distractorMisconceptions.filter((id) => id !== null)
    problems.push(...checkMisconceptionIds(named, context, 'distractorMisconceptions'))

    return problems
  },
  // There is no safe generic question. A fabricated one would be asked of a real learner and
  // its answer recorded as evidence about them, so failure has to surface.
  safeFallback: () => null,
}

// ---------------------------------------------------------------------------
// answer.evaluate
// ---------------------------------------------------------------------------

/**
 * A judgement about one answer — and only about that answer.
 *
 * There is no field here for mastery, confidence in the learner, or what they should do next.
 * The model reports what it saw; the domain decides what it means.
 */
export const answerEvaluationSchema = z
  .object({
    correct: z.boolean(),
    /**
     * Why, in terms of what their answer actually says or does. Shown to the learner, so it
     * addresses them directly.
     */
    explanation: proseText,
    /** Wrong ideas this answer shows evidence of. Empty when none apply. */
    misconceptions: z.array(misconceptionIdSchema).max(3),
    /**
     * Whether the answer is close enough that the learner clearly has the idea and slipped,
     * rather than not having the idea. Recorded as context for feedback; it does not change
     * how the answer is scored.
     */
    nearMiss: z.boolean(),
  })
  .strict()

export type AnswerEvaluation = z.infer<typeof answerEvaluationSchema>

export interface AnswerEvaluateInput {
  readonly learner: LearnerContext
  readonly conceptId: ConceptId
  readonly question: string
  /** What a correct answer looks like, where the caller knows. */
  readonly expected: string | null
  readonly learnerAnswer: string
}

const ANSWER_EVALUATE_INSTRUCTION = `TASK: judge one answer.

Decide whether it is correct. Be strict about substance and forgiving about form — spelling,
spacing and phrasing do not matter; meaning does. An answer that is right for the wrong reason
is not correct.

Explain your decision in terms of what their answer actually says. If it is wrong, say what
would happen if they acted on it, or what the code would really do. Never only "that is not
right".

Tag a misconception only when the answer genuinely shows it. An unfounded tag is acted on
later, so a wrong label is worse than no label.

Address the learner as "you". Two or three sentences.`

export const answerEvaluateStrategy: StructuredStrategy<AnswerEvaluateInput, AnswerEvaluation> = {
  kind: 'structured',
  id: 'answer.evaluate',
  version: '1',
  purpose: 'Judge a single learner answer and say why, without judging the learner.',
  streams: false,
  schemaName: 'answer_evaluation',
  schema: answerEvaluationSchema,
  buildBlocks(input) {
    const concept = getConcept(input.conceptId)
    const expected =
      input.expected === null ? '' : `\n\nA correct answer looks like: ${input.expected}`

    return composePrompt({
      strategy: ANSWER_EVALUATE_INSTRUCTION,
      learner: input.learner,
      task: `CONCEPT: ${concept.id} — ${concept.title}\n\nQUESTION ASKED:\n${input.question}${expected}\n\n${quoteLearnerText('THEIR ANSWER', input.learnerAnswer)}`,
    })
  },
  checkInvariants(output, _input, context) {
    const problems: InvariantProblem[] = [
      ...checkMisconceptionIds(output.misconceptions, context, 'misconceptions'),
      ...checkNoDuplicates(output.misconceptions, 'misconceptions'),
    ]

    // A correct answer that also demonstrates a wrong idea is contradictory as recorded
    // evidence: the same attempt would count both for and against the same concept.
    if (output.correct && output.misconceptions.length > 0) {
      problems.push({
        code: 'misconception-on-correct-answer',
        detail:
          'The answer is marked correct but also tagged with misconceptions. Either it is wrong, or there are no misconceptions to tag.',
      })
    }

    return problems
  },
  // No fallback. Guessing at correctness would write invented evidence into the learner's
  // record, which is the one thing the model is never allowed to do.
  safeFallback: () => null,
}

// ---------------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------------

/**
 * A closer look at a mistake, when the ordinary evaluation is not enough.
 *
 * Called when a learner has got something wrong more than once, or in a way that suggests a
 * misunderstanding rather than a slip. It produces a hypothesis and a question that would
 * test it — not a verdict.
 */
export const diagnosisSchema = z
  .object({
    /** What the learner appears to believe, stated as they would state it. */
    likelyBelief: proseText,
    /** Catalogued misconceptions consistent with the evidence. */
    candidates: z.array(misconceptionIdSchema).max(3),
    /**
     * A question whose answer would distinguish between the hypothesis and the alternative.
     * Asking it is how the guess gets tested rather than assumed.
     */
    checkingQuestion: proseText,
    /** How well the evidence supports the hypothesis. Coarse on purpose. */
    strength: z.enum(['weak', 'moderate', 'strong']),
  })
  .strict()

export type Diagnosis = z.infer<typeof diagnosisSchema>

export interface DiagnoseInput {
  readonly learner: LearnerContext
  readonly conceptId: ConceptId
  /** The attempts that prompted this, oldest first. */
  readonly attempts: readonly { readonly question: string; readonly answer: string }[]
}

const DIAGNOSE_INSTRUCTION = `TASK: work out what this learner might be misunderstanding.

Look across the attempts for a pattern. One wrong answer is usually a slip; the same shape of
error twice is usually an idea.

State what they appear to believe, in the form they would state it — a belief that makes
their answers make sense, not a description of their errors.

Then write one question whose answer would tell you whether you are right. It should have
different answers depending on which belief they hold. That question is the point of this
task: you are forming a hypothesis to test, not reaching a conclusion.

Be honest about strength. "weak" is the correct answer when the evidence is thin, and saying
so is more useful than a confident guess that gets acted on.`

export const diagnoseStrategy: StructuredStrategy<DiagnoseInput, Diagnosis> = {
  kind: 'structured',
  id: 'diagnose',
  version: '1',
  purpose: 'Form a testable hypothesis about a repeated mistake, and a question that would test it.',
  streams: false,
  schemaName: 'diagnosis',
  schema: diagnosisSchema,
  buildBlocks(input) {
    const concept = getConcept(input.conceptId)
    const attempts = input.attempts
      .map(
        (attempt, index) =>
          `Attempt ${String(index + 1)}\n  Question: ${attempt.question}\n  ${quoteLearnerText('Their answer', attempt.answer)}`,
      )
      .join('\n\n')

    return composePrompt({
      strategy: DIAGNOSE_INSTRUCTION,
      learner: input.learner,
      task: `CONCEPT: ${concept.id} — ${concept.title}\n\nATTEMPTS TO EXAMINE\n\n${attempts}`,
    })
  },
  checkInvariants(output, _input, context) {
    return [
      ...checkMisconceptionIds(output.candidates, context, 'candidates'),
      ...checkNoDuplicates(output.candidates, 'candidates'),
    ]
  },
  // A diagnosis is a hypothesis about a specific person's thinking. There is no generic one,
  // and inventing one would put words in their mouth.
  safeFallback: () => null,
}

export { conceptIdSchema }
