import { getConcept } from '@/domain/curriculum/graph'
import type { ConceptId, MisconceptionId } from '@/domain/curriculum/types'
import { bandOf, evidenceStrengthOf, type Band, type ConceptState } from '@/domain/learner-model/state'
import type { PromptBlock } from '@/llm/provider'

import { quoteLearnerText } from './compose'

/**
 * What the tutor is told about the learner.
 *
 * Deliberately coarse. The model is given bands and words, never the ability estimate, the
 * uncertainty or any other internal number.
 *
 * Two reasons. The numbers would not help — "developing, with limited evidence" is as much
 * as a model can act on, and `theta: 0.317` invites it to reason about a precision the
 * estimate does not have. And passing them back would blur the line the whole design rests
 * on: the model is shown a summary of what the learner has demonstrated, and has no channel
 * through which to argue with it.
 *
 * This is the first dynamic block, so everything above it stays byte-identical between calls.
 */

/** A learner's standing on one concept, as the model sees it. */
export interface ConceptSummary {
  readonly conceptId: ConceptId
  readonly title: string
  readonly band: Band
  readonly evidence: 'none' | 'limited' | 'moderate' | 'strong'
  /** True when recent successes here have needed hints. */
  readonly neededSupport: boolean
}

export interface LearnerContext {
  /** What the learner said they want from this, in their own words. */
  readonly goal: string | null
  /** The concept being worked on, if this call concerns one. */
  readonly focus: ConceptSummary | null
  /** Prerequisites and near neighbours, for pitching an explanation. */
  readonly related: readonly ConceptSummary[]
  /** Misconceptions seen recently, most recent first. */
  readonly recentMisconceptions: readonly MisconceptionId[]
}

/** How much support counts as "has been leaning on hints". */
const SUPPORT_THRESHOLD = 0.34

export function summariseConcept(state: ConceptState): ConceptSummary {
  return {
    conceptId: state.conceptId,
    title: getConcept(state.conceptId).title,
    band: bandOf(state),
    evidence: evidenceStrengthOf(state),
    neededSupport: state.supportSignal >= SUPPORT_THRESHOLD,
  }
}

const BAND_WORDS: Readonly<Record<Band, string>> = {
  'not-started': 'not started',
  'needs-review': 'weak, needs work',
  developing: 'developing',
  secure: 'secure',
}

function describe(summary: ConceptSummary): string {
  const support = summary.neededSupport ? ', has been reaching it with help' : ''
  return `  ${summary.conceptId} (${summary.title}): ${BAND_WORDS[summary.band]}, ${summary.evidence} evidence${support}`
}

export function learnerBlock(context: LearnerContext): PromptBlock {
  const parts: string[] = ['ABOUT THIS LEARNER']

  // Quoted, not interpolated. The goal is the learner's own text, it is set once and then
  // rides on every call for every strategy, and this block sits above the task block — so a
  // forged heading here would outrank everything quoted later.
  parts.push(
    context.goal === null
      ? 'They have not said what they want from this yet.'
      : quoteLearnerText('In their words, what they want from this', context.goal),
  )

  if (context.focus !== null) {
    parts.push(`\nWorking on now:\n${describe(context.focus)}`)
  }

  if (context.related.length > 0) {
    parts.push(`\nWhere they stand on related material:\n${context.related.map(describe).join('\n')}`)
  }

  if (context.recentMisconceptions.length > 0) {
    parts.push(
      `\nWrong ideas seen recently, most recent first: ${context.recentMisconceptions.join(', ')}`,
    )
  }

  parts.push(
    '\nThese are estimates from what the learner has done, not facts about them. Treat them' +
      ' as a guide to pitching your response. Do not repeat them back or discuss them unless' +
      ' the learner asks.',
  )

  return { id: 'learner', role: 'user', stability: 'dynamic', text: parts.join('\n') }
}

/** An empty context, for calls made before anything is known about the learner. */
export const UNKNOWN_LEARNER: LearnerContext = {
  goal: null,
  focus: null,
  related: [],
  recentMisconceptions: [],
}
