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

/** The same comparison, applied to whole questions. */
function normaliseQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ')
}

export const quizGenerateStrategy: StructuredStrategy<QuizGenerateInput, Quiz> = {
  kind: 'structured',
  id: 'quiz.generate',
  // Bumped in M5 for the repeated-question invariant, so a log entry can be traced to the
  // contract that produced it.
  version: '2',
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
  checkInvariants(output, input, context) {
    const problems: InvariantProblem[] = []

    /*
     * A question the learner has already been asked.
     *
     * The prompt lists what to avoid, and a model may still return one of them — the mock
     * provider does, every time, because a fixture has no opinion about what came before. It is
     * checked rather than trusted because a repeat is not merely tedious: answering the same
     * question twice deposits a second piece of evidence about the same moment of
     * understanding, and the authored path prevents that by construction (`usedItemIds`) while
     * the generated path had nothing standing in the way.
     */
    if (input.avoid.some((asked) => normaliseQuestion(asked) === normaliseQuestion(output.question))) {
      problems.push({
        code: 'repeats-a-question-already-asked',
        detail:
          'This learner has already been asked this question. Write a different one on the same concept.',
      })
    }

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
/**
 * The verdict, as four named outcomes rather than a boolean.
 *
 * M2 recorded a limitation here: `correct: boolean` was the real trust boundary, the one field
 * where a model's opinion became evidence about a person. M5 is the milestone that consumes it
 * in earnest, so it is the milestone to improve it in.
 *
 * The problem with a boolean is not that it is coarse. It is that it leaves a judge with no
 * opinion no way to say so. Asked "correct: true or false?" about an answer that is genuinely
 * unreadable — off topic, one word, contradicting itself — the model must pick one, and
 * whichever it picks becomes a numeric change in a learner's record. `cannot-tell` is the fix:
 * it is an honest answer to an unanswerable question, and the domain turns it into no evidence
 * at all rather than a coin flip.
 *
 * `partially-correct` earns its place separately. Plenty of short answers reach the right
 * conclusion with a piece of the reasoning missing, and a boolean forces that into either a
 * clean success or a failure. Neither is true. The domain treats it as a success, attenuated
 * the way a hinted success is attenuated (ADR-0005) — so it never lowers a band, and it counts
 * for less than a complete answer.
 *
 * What has *not* changed is who decides what the verdict means. The model reports one of four
 * words. `markJudgement` in the domain decides which of them is evidence and how much. There is
 * still no field here through which a number could be supplied.
 */
export const answerEvaluationSchema = z
  .object({
    verdict: z.enum([
      /** Right, with reasoning that supports it. */
      'correct',
      /** Right, but with part of the reasoning missing or unstated. */
      'partially-correct',
      /** Wrong. */
      'incorrect',
      /**
       * Not enough in the answer to judge either way.
       *
       * The honest choice for an answer that is off topic, empty of content, or
       * self-contradictory. It produces no evidence, so it costs the learner nothing.
       */
      'cannot-tell',
    ]),
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

Choose one verdict:

- correct — right, and the reasoning shown supports it
- partially-correct — reaches the right conclusion with part of the reasoning missing or
  unstated. Not a half-mark: use it when they plainly have the idea but have not said all of it
- incorrect — wrong
- cannot-tell — there is not enough in the answer to judge. Use this for an answer that is off
  topic, says nothing substantive, or contradicts itself

cannot-tell is a real option and you should use it when it applies. An answer nobody could
grade produces no record either way, which is the right outcome — far better than a guess that
becomes part of what this application believes about a person. Do not reach for a verdict you
cannot support.

Be strict about substance and forgiving about form: spelling, spacing and phrasing do not
matter; meaning does. An answer that is right for the wrong reason is not correct.

Explain your decision in terms of what their answer actually says. If it is wrong, say what
would happen if they acted on it, or what the code would really do. Never only "that is not
right".

Tag a misconception only when the answer genuinely shows it. An unfounded tag is acted on
later, so a wrong label is worse than no label.

Address the learner as "you". Two or three sentences.`

export const answerEvaluateStrategy: StructuredStrategy<AnswerEvaluateInput, AnswerEvaluation> = {
  kind: 'structured',
  id: 'answer.evaluate',
  // Bumped for the verdict change. The version rides on every call log, so a change in how
  // answers were judged can be traced to the prompt and schema that judged them.
  version: '2',
  purpose:
    'Judge a single learner answer and say why, with the option of declining. Never decides what the judgement does to learner state.',
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
    if (output.verdict === 'correct' && output.misconceptions.length > 0) {
      problems.push({
        code: 'misconception-on-correct-answer',
        detail:
          'The verdict is "correct" but the answer is also tagged with misconceptions. Either it is not correct, or there are no misconceptions to tag.',
      })
    }

    // An answer nobody could read cannot also have shown a specific wrong idea. Allowing both
    // would let an unmarked attempt still deposit a diagnosis.
    if (output.verdict === 'cannot-tell' && output.misconceptions.length > 0) {
      problems.push({
        code: 'misconception-on-unjudgeable-answer',
        detail:
          'The verdict is "cannot-tell", so there is not enough in the answer to identify a misconception in it either. Report no misconceptions, or choose a verdict you can support.',
      })
    }

    // `nearMiss` says they had the idea and slipped. That is a statement about a wrong answer.
    if (output.nearMiss && output.verdict !== 'incorrect' && output.verdict !== 'partially-correct') {
      problems.push({
        code: 'near-miss-on-non-wrong-answer',
        detail:
          'nearMiss describes a wrong answer that was close. It cannot be true for a verdict of "correct" or "cannot-tell".',
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
