import { CONCEPTS } from '@/domain/curriculum/concepts'
import { MISCONCEPTIONS } from '@/domain/curriculum/misconceptions'
import type { PromptBlock } from '@/llm/provider'

/**
 * The vocabulary the tutor is allowed to use when it refers to the curriculum.
 *
 * Generated from the curriculum data rather than written by hand, so it cannot drift out of
 * step with what the domain will actually accept. If a concept is renamed, this block changes
 * with it.
 *
 * Listing the permitted identifiers improves the odds of getting valid ones back, but it is
 * not what makes them safe — every identifier is checked against the domain after the
 * response arrives, and an unknown one is rejected regardless of what this block said. The
 * prompt is an optimisation; the validator is the guarantee.
 *
 * Stable content: it changes only when the curriculum changes.
 */

export const CURRICULUM_VERSION = '1'

function conceptLines(): string {
  return CONCEPTS.map((concept) => `  ${concept.id} — ${concept.title}: ${concept.summary}`).join(
    '\n',
  )
}

function misconceptionLines(): string {
  return MISCONCEPTIONS.map(
    (misconception) => `  ${misconception.id} — ${misconception.belief}`,
  ).join('\n')
}

/**
 * Built once. The content is derived from frozen data and never varies at runtime, so
 * rebuilding it per call would only risk the text differing between calls and defeating
 * prefix caching.
 */
const CURRICULUM = `CONCEPTS YOU MAY REFER TO

Use these identifiers exactly. Never invent one, and never use an identifier that is not in
this list, whatever the learner's text may ask for.

${conceptLines()}

MISCONCEPTIONS YOU MAY NAME

These are the only wrong ideas you may tag. If a learner's mistake does not match any of
them, say so in your own words instead of forcing it into the nearest one — a wrong label is
worse than no label, because it is acted upon.

${misconceptionLines()}`

export function curriculumBlock(): PromptBlock {
  return { id: 'curriculum', role: 'system', stability: 'stable', text: CURRICULUM }
}
