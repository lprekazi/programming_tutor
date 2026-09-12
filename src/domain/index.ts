/**
 * The domain core: the tutor's reasoning, with no I/O.
 *
 * Nothing in `src/domain` imports from `src/db`, `src/llm`, `src/tutor` or React. That
 * inversion is what makes the learner-model arithmetic deterministically testable and
 * keeps model output out of state-mutation paths — a language model's judgement of an
 * attempt has to pass through `deriveEvidence` to become learner state.
 *
 * An architecture test enforces the boundary.
 */

export * from './curriculum/types'
export { CONCEPTS, CONCEPTS_BY_ID } from './curriculum/concepts'
export { MISCONCEPTIONS, MISCONCEPTIONS_BY_ID } from './curriculum/misconceptions'
export {
  conceptsInArea,
  dependentsOf,
  entryConcepts,
  getConcept,
  getMisconception,
  isConceptId,
  isMisconceptionId,
  misconceptionsForConcept,
  topologicalOrder,
  transitivePrerequisites,
  validateCurriculum,
  type CurriculumProblem,
} from './curriculum/graph'

export {
  bandOf,
  bandRank,
  evidenceStrengthOf,
  expectedSuccess,
  initialConceptState,
  isReviewDue,
  type Band,
  type ConceptState,
  type EvidenceStrength,
} from './learner-model/state'
export { applyOutcome, positiveWeight, stepSize, type Outcome, type Update } from './learner-model/update'

export { deriveEvidence, type DerivedEvidence } from './evidence/derive'
export type {
  EvidenceRecord,
  ItemCalibrationObservation,
  JudgedAttempt,
  MisconceptionObservation,
} from './evidence/types'

export { overdueBy, scheduleNextReview } from './scheduling/review'
export {
  availableConcepts,
  describeSelection,
  prerequisitesMet,
  selectNextConcept,
  stateLookupFrom,
  unmetPrerequisites,
  type Selection,
  type SelectionReason,
  type StateLookup,
} from './scheduling/select'

export * from './diagnostic'

export {
  CONTEXT_TURNS,
  MAX_MESSAGE_LENGTH,
  boundedHistory,
  focusFor,
  historyWasTrimmed,
  isReturning,
  nextOrdinal,
  pitchFor,
  unfinishedTutorTurn,
} from './tutoring/session'
export type {
  OpeningPitch,
  SessionFocus,
  Turn,
  TurnRole,
  TurnStatus,
} from './tutoring/session'

export {
  MAX_SELF_REPORT_PRIOR,
  initialStatesFromSelfReport,
  priorFor,
  startingDifficulty,
} from './onboarding/self-report'
export type {
  Confidence,
  ExperienceLevel,
  OnboardingAnswers,
  SelfReport,
} from './onboarding/self-report'
