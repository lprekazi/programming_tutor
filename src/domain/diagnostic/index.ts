/**
 * The diagnostic: a short mixed assessment that initialises the learner profile.
 *
 * Pure, like the rest of the domain. The item bank is hand-authored data, scoring is
 * deterministic wherever it can be, and selection is a function of the answers so far — no
 * clock, no randomness, no model call. A model is needed for exactly one kind of item, and
 * this layer declines to score it rather than hiding the boundary.
 */

export {
  DIAGNOSTIC_ITEMS,
  DIAGNOSTIC_ITEMS_BY_ID,
  getDiagnosticItem,
  isDeterministic,
} from './items'
export type {
  ChoiceItem,
  CodeItem,
  DiagnosticItem,
  DiagnosticItemKind,
  ExplainItem,
  PredictOutputItem,
} from './items'

export { normaliseAnswer, scoreAnswer } from './score'
export type { ExecutionOutcome, Verdict, VerdictSource } from './score'

export {
  FAILURES_BEFORE_SKIP,
  MAX_ITEMS,
  MIN_ITEMS,
  TARGET_AREAS,
  conceptsAsked,
  estimatedLevel,
  remaining,
  isWorthAsking,
  nextDecision,
} from './plan'
export type { AnsweredItem, PlanDecision, PlanState, RemainingRange } from './plan'

export { presentItem } from './present'
export type { PresentedItem } from './present'

export { buildTestProgram, parseTestReport } from './harness'
export type { HarnessTest, TestReport, TestResult } from './harness'
