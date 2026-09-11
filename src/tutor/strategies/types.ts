import type { z } from 'zod'

import type { PromptBlock } from '@/llm/provider'

/**
 * What a tutoring strategy is.
 *
 * One strategy is one thing the tutor does: explain, mark an answer, produce a hint. Each
 * declares its own instruction, its own output contract, and what should happen when the
 * model fails to honour it. There is deliberately no inheritance and no base class — a
 * strategy is a plain object, and reading one tells you everything about that call.
 *
 * The important part is the contract. A strategy whose output affects application state must
 * declare a schema *and* the invariants the schema cannot express, *and* what to do when
 * neither holds. Those three together are what let untrusted model output be used at all.
 */

/** A problem with an otherwise schema-valid response. */
export interface InvariantProblem {
  /** Short machine-readable code, for logs and tests. */
  readonly code: string
  /** Stated so it can be handed back to the model in a repair attempt. */
  readonly detail: string
}

export interface StrategyContext {
  /** Concepts the response is allowed to refer to; anything else is rejected. */
  readonly allowedConcepts: ReadonlySet<string>
  readonly allowedMisconceptions: ReadonlySet<string>
}

/**
 * A strategy whose output is prose, streamed to the learner as it arrives.
 *
 * Prose strategies have no schema. Nothing they produce changes learner state — what the
 * learner demonstrated is decided by a separate structured call, not by reading the tutor's
 * own reply back into the model.
 */
export interface ProseStrategy<Input> {
  readonly kind: 'prose'
  readonly id: string
  readonly version: string
  /** One sentence: what this call is for. */
  readonly purpose: string
  readonly streams: true
  buildBlocks(input: Input): readonly PromptBlock[]
}

/**
 * A strategy whose output is machine-readable and affects what the application does.
 */
export interface StructuredStrategy<Input, Output> {
  readonly kind: 'structured'
  readonly id: string
  readonly version: string
  readonly purpose: string
  readonly streams: false
  /** Identifier sent with the schema; must be stable across calls. */
  readonly schemaName: string
  readonly schema: z.ZodType<Output>
  buildBlocks(input: Input): readonly PromptBlock[]
  /**
   * Checks the schema cannot express: valid identifiers, internal consistency, anything
   * whose violation would make the response unusable or misleading.
   *
   * Returns every problem found, so a repair attempt can address them together.
   */
  checkInvariants(output: Output, input: Input, context: StrategyContext): readonly InvariantProblem[]
  /**
   * What to use when the model cannot produce something valid.
   *
   * `null` means there is no safe substitute and the caller must handle failure — which is
   * the honest answer for anything that would otherwise fabricate a judgement about the
   * learner. A fallback is only appropriate where a generic, obviously-generic response is
   * better than nothing.
   */
  safeFallback(input: Input): Output | null
}

export type Strategy<Input, Output> = ProseStrategy<Input> | StructuredStrategy<Input, Output>

/** Identifies the exact prompt that produced a response, for logs and later analysis. */
export interface StrategyVersion {
  readonly strategyId: string
  readonly strategyVersion: string
  readonly policyVersion: string
  readonly curriculumVersion: string
}
