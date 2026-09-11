import { z } from 'zod'

import { CONCEPTS } from '@/domain/curriculum/concepts'
import { MISCONCEPTIONS } from '@/domain/curriculum/misconceptions'
import type { ConceptId, MisconceptionId } from '@/domain/curriculum/types'

import { CURRICULUM_VERSION } from '../blocks/curriculum'
import { POLICY_VERSION } from '../blocks/policy'
import type { InvariantProblem, StrategyContext, StrategyVersion } from './types'

/**
 * Schema pieces shared across strategies, and the checks that go with them.
 *
 * Identifiers are constrained twice: as an enum in the schema the provider enforces, and
 * again by the invariant checks after parsing. That is not redundancy for its own sake. The
 * schema is the provider's promise, and the check is ours — the mock provider, a future
 * provider, a cached response or a decoding edge case all reach the same validator, and a
 * concept identifier that does not exist must never reach the domain whatever produced it.
 */

const conceptIds = CONCEPTS.map((concept) => concept.id) as [ConceptId, ...ConceptId[]]
const misconceptionIds = MISCONCEPTIONS.map((misconception) => misconception.id) as [
  MisconceptionId,
  ...MisconceptionId[],
]

export const conceptIdSchema = z.enum(conceptIds)
export const misconceptionIdSchema = z.enum(misconceptionIds)

/**
 * Caps on generated text.
 *
 * Not a cosmetic limit. Unbounded model text ends up rendered in the interface, written to
 * the database, and fed back into a later prompt, so a response that runs away costs money
 * and breaks layout in three places at once. Anything over the cap is a failed response, not
 * something to truncate: silently cutting text mid-sentence changes what it says.
 */
export const MAX_SHORT_TEXT = 400
export const MAX_PROSE_TEXT = 2_000
export const MAX_CODE_TEXT = 4_000

export const shortText = z.string().trim().min(1).max(MAX_SHORT_TEXT)
export const proseText = z.string().trim().min(1).max(MAX_PROSE_TEXT)
export const codeText = z.string().min(1).max(MAX_CODE_TEXT)

/** The context every structured strategy validates against. */
export function strategyContext(): StrategyContext {
  return {
    allowedConcepts: new Set(conceptIds),
    allowedMisconceptions: new Set(misconceptionIds),
  }
}

export function versionOf(strategyId: string, strategyVersion: string): StrategyVersion {
  return {
    strategyId,
    strategyVersion,
    policyVersion: POLICY_VERSION,
    curriculumVersion: CURRICULUM_VERSION,
  }
}

/** Rejects identifiers the domain does not know, whatever produced them. */
export function checkConceptIds(
  ids: readonly string[],
  context: StrategyContext,
  field: string,
): InvariantProblem[] {
  return ids
    .filter((id) => !context.allowedConcepts.has(id))
    .map((id) => ({
      code: 'unknown-concept',
      detail: `${field} contains "${id}", which is not a concept in this curriculum.`,
    }))
}

export function checkMisconceptionIds(
  ids: readonly string[],
  context: StrategyContext,
  field: string,
): InvariantProblem[] {
  return ids
    .filter((id) => !context.allowedMisconceptions.has(id))
    .map((id) => ({
      code: 'unknown-misconception',
      detail: `${field} contains "${id}", which is not a misconception in this catalogue.`,
    }))
}

/** Flags a repeated identifier, which would otherwise inflate how often something is seen. */
export function checkNoDuplicates(ids: readonly string[], field: string): InvariantProblem[] {
  const seen = new Set<string>()
  const duplicated = new Set<string>()

  for (const id of ids) {
    if (seen.has(id)) duplicated.add(id)
    seen.add(id)
  }

  return [...duplicated].map((id) => ({
    code: 'duplicate-identifier',
    detail: `${field} lists "${id}" more than once.`,
  }))
}

/**
 * Looks for a complete solution where one must not appear.
 *
 * A blunt heuristic, and it is described as one. It catches the obvious case — a hint or a
 * piece of feedback that hands over a function definition — and it will miss a solution
 * expressed some other way. It is a backstop behind the policy instruction, not a guarantee,
 * and it is deliberately biased towards rejecting: a false rejection costs one repair
 * attempt, whereas a missed solution costs the learner the exercise.
 */
export function looksLikeASolution(text: string): boolean {
  const definitions = /(^|\n)\s*(def|class)\s+\w+\s*\(/.test(text)
  const manyCodeLines = (text.match(/(^|\n)\s{4,}\S/g) ?? []).length >= 3
  return definitions && manyCodeLines
}

export function checkNoSolution(text: string, field: string): InvariantProblem[] {
  if (!looksLikeASolution(text)) return []
  return [
    {
      code: 'reveals-solution',
      detail: `${field} appears to contain a complete implementation. Describe the next step in words, or show a short fragment, without writing the function the learner is meant to write.`,
    },
  ]
}
