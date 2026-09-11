/**
 * The tutoring strategies, and the registry over them.
 *
 * Nine strategies, each one thing the tutor does. There is no tenth added speculatively:
 * every one here is called by a planned part of the product, and anything the tutor needs to
 * do that is not on this list is a gap to be noticed rather than a case to be absorbed into a
 * general-purpose call.
 */

export type {
  InvariantProblem,
  ProseStrategy,
  Strategy,
  StrategyContext,
  StrategyVersion,
  StructuredStrategy,
} from './types'

export {
  MAX_CODE_TEXT,
  MAX_PROSE_TEXT,
  MAX_SHORT_TEXT,
  looksLikeASolution,
  strategyContext,
  versionOf,
} from './shared'

export { converseStrategy, explainStrategy } from './prose'
export type { ConverseInput, ConverseTurn, ExplainInput, ExplanationDepth } from './prose'

export {
  answerEvaluateStrategy,
  answerEvaluationSchema,
  diagnoseStrategy,
  diagnosisSchema,
  quizGenerateStrategy,
  quizSchema,
} from './assessment'
export type {
  AnswerEvaluateInput,
  AnswerEvaluation,
  Diagnosis,
  DiagnoseInput,
  Quiz,
  QuizGenerateInput,
} from './assessment'

export {
  MAX_HINT_DEPTH,
  codeFeedbackSchema,
  codeFeedbackStrategy,
  codeTaskGenerateStrategy,
  codeTaskSchema,
  hintSchema,
  hintStrategy,
} from './coding'
export type {
  CodeFeedback,
  CodeFeedbackInput,
  CodeTask,
  CodeTaskGenerateInput,
  Hint,
  HintInput,
} from './coding'

export { profileUpdateSchema, profileUpdateStrategy } from './profile'
export type { ProfileUpdate, ProfileUpdateInput } from './profile'

import { answerEvaluateStrategy, diagnoseStrategy, quizGenerateStrategy } from './assessment'
import { codeFeedbackStrategy, codeTaskGenerateStrategy, hintStrategy } from './coding'
import { profileUpdateStrategy } from './profile'
import { converseStrategy, explainStrategy } from './prose'

/**
 * Every strategy, for tests and for anything that needs to enumerate them.
 *
 * Typed loosely on purpose: each strategy has its own input and output types, and a registry
 * that preserved them would need an existential type for no practical gain. Call sites use
 * the strategies directly and keep their types; this exists to iterate over.
 */
export const ALL_STRATEGIES = [
  converseStrategy,
  explainStrategy,
  diagnoseStrategy,
  quizGenerateStrategy,
  answerEvaluateStrategy,
  codeTaskGenerateStrategy,
  codeFeedbackStrategy,
  hintStrategy,
  profileUpdateStrategy,
] as const
