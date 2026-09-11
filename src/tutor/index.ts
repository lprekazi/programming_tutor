/**
 * The tutoring layer: how the tutor talks to a language model.
 *
 * It sits between the domain, which decides what should happen, and the provider, which is
 * the only non-deterministic thing in the system. Its job is to make model output safe to
 * act on — a schema, then invariants, then one repair attempt, then a deterministic
 * fallback — and to record enough about each call to reason about it afterwards.
 *
 * What it never does is let model output become learner state. The closest it comes is
 * `profile.update`, whose schema has no field capable of expressing a change to anything.
 */

export { composePrompt, quoteLearnerText, stablePrefix } from './blocks/compose'
export type { PromptParts } from './blocks/compose'
export { CURRICULUM_VERSION, curriculumBlock } from './blocks/curriculum'
export { POLICY_VERSION, policyBlock } from './blocks/policy'
export { UNKNOWN_LEARNER, learnerBlock, summariseConcept } from './blocks/learner'
export type { ConceptSummary, LearnerContext } from './blocks/learner'

export * from './strategies'

export { runStructured } from './validate/run'
export type { RunOptions, StrategyFailureReason, StrategyOutcome } from './validate/run'

export {
  InMemoryCallLog,
  NULL_CALL_LOG,
  buildCallLog,
} from './logging/call-log'
export type { BuildLogInput, CallLogSink, LlmCallLog } from './logging/call-log'
