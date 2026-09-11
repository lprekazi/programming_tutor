import { getConcept } from '@/domain/curriculum/graph'
import type { ConceptId } from '@/domain/curriculum/types'

import { composePrompt, quoteLearnerText } from '../blocks/compose'
import type { LearnerContext } from '../blocks/learner'
import type { ProseStrategy } from './types'

/**
 * The two strategies that produce prose for the learner to read.
 *
 * Neither has a schema, and neither changes anything. What the learner demonstrated is
 * decided by a separate structured call over their actual answer — never by reading the
 * tutor's own reply back into a model and asking it what just happened.
 *
 * That separation is also why these can stream. Streaming prose is worth it: a learner
 * waiting on an explanation sees it forming rather than staring at a spinner. Streaming
 * structured output is not, because a half-arrived JSON object cannot be validated, and
 * validating it is the entire point.
 */

// ---------------------------------------------------------------------------
// converse
// ---------------------------------------------------------------------------

export interface ConverseTurn {
  readonly role: 'learner' | 'tutor'
  readonly text: string
}

export interface ConverseInput {
  readonly learner: LearnerContext
  /** Earlier turns, oldest first. */
  readonly history: readonly ConverseTurn[]
  /** What the learner has just said. */
  readonly message: string
  /** What they are working on, if anything, so the tutor does not solve it for them. */
  readonly activeTask: string | null
}

const CONVERSE_INSTRUCTION = `TASK: reply to the learner in this conversation.

Answer what they asked. Keep it short — a few sentences unless they asked for something that
genuinely needs more.

If they are stuck on a task they are currently attempting, help them think, do not finish it
for them. A question, a nudge towards the part they have not considered, or an explanation of
the idea they are missing. Not the code.

If their message is too vague to answer well, ask one specific question rather than guessing
at three possible meanings.

Reply in plain prose. No headings, no bullet lists unless you are genuinely enumerating
something, no preamble about what you are about to do.`

export const converseStrategy: ProseStrategy<ConverseInput> = {
  kind: 'prose',
  id: 'converse',
  version: '1',
  purpose: 'Reply to something the learner has said, in the context of what they are doing.',
  streams: true,
  buildBlocks(input) {
    const transcript =
      input.history.length === 0
        ? 'This is the start of the conversation.'
        : input.history
            .map((turn) =>
              // Earlier turns from the learner are learner text too. Quoting only the newest
              // message would leave every previous one as an unfenced injection point.
              turn.role === 'learner'
                ? quoteLearnerText('Learner said', turn.text)
                : `You: ${turn.text}`,
            )
            .join('\n\n')

    const task =
      input.activeTask === null
        ? ''
        : `\n\nThey are currently working on this task, so do not write its solution:\n${input.activeTask}`

    return composePrompt({
      strategy: CONVERSE_INSTRUCTION,
      learner: input.learner,
      task: `CONVERSATION SO FAR\n${transcript}${task}\n\n${quoteLearnerText('The learner has just written', input.message)}`,
    })
  },
}

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

/**
 * How much ground an explanation should cover.
 *
 * Chosen by the caller from what the learner has demonstrated, not by the model from its own
 * impression of them.
 */
export type ExplanationDepth =
  /** They have not met this before. */
  | 'introduce'
  /** They have the idea but something specific is not landing. */
  | 'clarify'
  /** They mostly have it; pin down the edge that is catching them. */
  | 'deepen'

export interface ExplainInput {
  readonly learner: LearnerContext
  readonly conceptId: ConceptId
  readonly depth: ExplanationDepth
  /** What specifically to address, if the caller knows. */
  readonly focus: string | null
}

const DEPTH_INSTRUCTIONS: Readonly<Record<ExplanationDepth, string>> = {
  introduce:
    'They have not worked on this before. Start from a concrete example they can picture, then name the idea. Do not assume any related vocabulary.',
  clarify:
    'They have met this and something is not landing. Do not re-teach it from scratch — find the specific step that is likely tripping them and address that.',
  deepen:
    'They mostly have this. Go to the edge case or the subtlety that separates a working understanding from a solid one.',
}

const EXPLAIN_INSTRUCTION = `TASK: explain one concept to this learner.

Lead with a small, concrete Python example — something short enough to read in one glance —
and then say what it shows. Example before rule, always.

Stay on the one concept you were asked about. Mentioning a neighbouring idea in passing is
fine; teaching it as well is not.

Finish with one short question that would show whether they have understood. Ask it; do not
answer it.

Plain prose and short code fragments. No headings, no numbered curriculum, no summary of what
you just said.`

export const explainStrategy: ProseStrategy<ExplainInput> = {
  kind: 'prose',
  id: 'explain',
  version: '1',
  purpose: 'Explain one concept, pitched at what the learner has demonstrated.',
  streams: true,
  buildBlocks(input) {
    const concept = getConcept(input.conceptId)
    const focus = input.focus === null ? '' : `\n\nAddress this in particular: ${input.focus}`

    return composePrompt({
      strategy: `${EXPLAIN_INSTRUCTION}\n\n${DEPTH_INSTRUCTIONS[input.depth]}`,
      learner: input.learner,
      task: `EXPLAIN: ${concept.id} — ${concept.title}\n${concept.summary}${focus}`,
    })
  },
}
