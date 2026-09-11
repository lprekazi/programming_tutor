import type { MisconceptionId } from '../curriculum/types'

import type { ChoiceItem, CodeItem, DiagnosticItem, PredictOutputItem } from './items'

/**
 * Scoring a diagnostic answer.
 *
 * Deterministic wherever it can be. A multiple choice has a correct index; an output
 * prediction has an expected string; a practical task has tests that either pass or not. None
 * of those needs a model, and using one would make the result slower, costlier, and less
 * reliable than the arithmetic it replaced.
 *
 * Only a free-text explanation genuinely requires semantic judgement, and that is the one kind
 * this module refuses to score — it returns `needs-judgement` and leaves it to the caller,
 * which keeps the model boundary visible instead of hidden inside a scoring function.
 */

/** Where a verdict came from. Kept distinct, because they are not equally trustworthy. */
export type VerdictSource =
  /** Compared against an author-written answer. */
  | 'deterministic'
  /** Decided by running the learner's code against tests. */
  | 'execution'
  /** Judged by a model. */
  | 'model'

export type Verdict =
  | {
      readonly kind: 'scored'
      readonly correct: boolean
      readonly source: VerdictSource
      /** Misconceptions this answer gives evidence of, from the closed catalogue. */
      readonly misconceptions: readonly MisconceptionId[]
    }
  /** This kind of answer cannot be scored here; a model has to judge it. */
  | { readonly kind: 'needs-judgement' }

/**
 * Normalises an answer before comparing it.
 *
 * Generous about form and strict about content. Trailing whitespace, blank lines, repeated
 * spaces and capitalisation all vary between people typing the same answer, and none of them
 * is what is being assessed. What the answer *says* is compared exactly.
 *
 * Spaces **around commas** are removed too, which is narrower than it looks and matters more.
 * A learner predicting a printed list has correctly worked out `[1, 2, 3]` whether they type
 * it with the spaces or without; marking `[1,2,3]` wrong would record negative evidence for a
 * concept they had just demonstrated. Spaces elsewhere are left alone, so `hello world` and
 * `helloworld` stay different answers — which they are.
 */
export function normaliseAnswer(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*/g, ','),
    )
    .filter((line) => line.length > 0)
    .join('\n')
    .toLowerCase()
}

function scoreChoice(item: ChoiceItem, answer: string): Verdict {
  const chosen = Number.parseInt(answer, 10)
  if (!Number.isInteger(chosen) || chosen < 0 || chosen >= item.options.length) {
    // An out-of-range selection is not a wrong answer, it is a malformed submission. Recording
    // it as incorrect would put evidence against the learner for something they did not do.
    return { kind: 'scored', correct: false, source: 'deterministic', misconceptions: [] }
  }

  const correct = chosen === item.correctIndex
  const misconception = item.optionMisconceptions[chosen]

  return {
    kind: 'scored',
    correct,
    source: 'deterministic',
    // A misconception is only recorded for a wrong choice. The correct option may share a
    // mapping in the data, but acting on a wrong idea cannot be what led them to the right
    // answer.
    misconceptions: !correct && misconception !== undefined && misconception !== null ? [misconception] : [],
  }
}

function scorePredictOutput(item: PredictOutputItem, answer: string): Verdict {
  const given = normaliseAnswer(answer)
  if (given === normaliseAnswer(item.expectedOutput)) {
    return { kind: 'scored', correct: true, source: 'deterministic', misconceptions: [] }
  }

  // Recognised wrong answers say something specific about what the learner believes.
  const recognised = item.knownWrongAnswers.find(
    (candidate) => normaliseAnswer(candidate.answer) === given,
  )

  return {
    kind: 'scored',
    correct: false,
    source: 'deterministic',
    // An unrecognised wrong answer is simply wrong. Guessing at which misconception it shows
    // would be a fabricated diagnosis, and it would be acted on later.
    misconceptions: recognised === undefined ? [] : [recognised.misconception],
  }
}

/**
 * What happened when the learner's code was run against the item's tests.
 *
 * Only two facts, because only two are used. A check that never ran — because the program
 * raised, timed out, or was terminated — is already reported as not passed by the harness, so
 * a separate "did it raise" flag would be a third way of saying the same thing and a fourth
 * thing to keep consistent.
 */
export interface ExecutionOutcome {
  /** True only when the program ran and every test passed. */
  readonly allTestsPassed: boolean
  readonly failedTests: readonly string[]
}

function scoreCode(_item: CodeItem, outcome: ExecutionOutcome): Verdict {
  return {
    kind: 'scored',
    correct: outcome.allTestsPassed,
    source: 'execution',
    // Which misconception a failing implementation shows is not something test names can tell
    // us. A model may be asked separately; nothing is inferred here.
    misconceptions: [],
  }
}

/**
 * Scores an answer, or declines to.
 *
 * `execution` is required for a code item and ignored otherwise.
 */
export function scoreAnswer(
  item: DiagnosticItem,
  answer: string,
  execution?: ExecutionOutcome,
): Verdict {
  switch (item.kind) {
    case 'choice':
      return scoreChoice(item, answer)
    case 'predict-output':
      return scorePredictOutput(item, answer)
    case 'code': {
      if (execution === undefined) {
        throw new Error(`Item ${item.id} is a code task and cannot be scored without a run result.`)
      }
      return scoreCode(item, execution)
    }
    case 'explain':
      return { kind: 'needs-judgement' }
  }
}
