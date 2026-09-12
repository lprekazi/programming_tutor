/**
 * Evaluated activities: the part of a tutoring session that produces evidence.
 *
 * Everything here is pure. When to check understanding, which question to ask, how the options
 * are ordered, whether an answer is right, and whether a verdict counts as evidence at all —
 * all decided without a database, a clock, a network call or a model. The layers above supply
 * the learner state and store the result.
 *
 * The boundary that matters: a model may *read* a written answer, but this layer decides what
 * reading it means. `markJudgement` is where a verdict of "cannot tell" becomes no evidence
 * rather than a guess, and that decision is the domain's.
 */

export {
  PRACTICE_ITEMS,
  PRACTICE_ITEMS_BY_ID,
  getPracticeItem,
  itemsProbing,
  practiceItemsFor,
} from './items'
export type {
  PracticeChoiceItem,
  PracticeItem,
  PracticeItemKind,
  PracticePredictItem,
  PracticeShortItem,
} from './items'

export { shuffleOptions } from './shuffle'
export type { OptionSet, ShuffledOptions } from './shuffle'

export { composeFeedback, markChoice, markJudgement, markPrediction } from './score'
export type { Marking, MarkingSource } from './score'

export { MAX_CHECKS_PER_SESSION, decideCheck, describeGround } from './select'
export type { CheckContext, CheckDecision, HoldReason, SelectionGround } from './select'

export { presentActivity } from './present'
export type { PresentedActivity, StoredActivity } from './present'
