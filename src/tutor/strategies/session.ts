import { z } from 'zod'

import { getConcept } from '@/domain/curriculum/graph'
import type { ConceptId } from '@/domain/curriculum/types'

import { composePrompt, quoteLearnerText } from '../blocks/compose'
import type { LearnerContext } from '../blocks/learner'
import {
  checkConceptIds,
  checkMisconceptionIds,
  checkNoDuplicates,
  conceptIdSchema,
  misconceptionIdSchema,
  proseText,
} from './shared'
import type { InvariantProblem, StructuredStrategy } from './types'

/**
 * What a conversational exchange appeared to be about.
 *
 * This is the sidecar that runs after a tutoring turn, and the temptation it exists to resist
 * is obvious: the model has just read an exchange, it would happily say "the learner seems to
 * understand loops now", and that would be very easy to write into the learner model.
 *
 * It must not be. A learner who reads an explanation has demonstrated nothing. Neither has one
 * who says "ah, I see" — people say that when they do not. Mastery moves on performance, which
 * means an attempt at something with a right answer, judged by `deriveEvidence`. Conversation
 * is not that, and M4 does not pretend otherwise.
 *
 * So this strategy is deliberately impoverished. Compare it with `profile.update`, which
 * observes a real attempt and still has no numeric field: this one has less again. It cannot
 * express a judgement of the learner at all — no correctness, no quality, no "seems to
 * understand". It reports which concepts came up and whether the learner stated a wrong belief
 * outright. Nothing it returns goes anywhere near `concept_state`; the repository writes it to
 * `session_observation`, and no code path leads from there to an estimate.
 *
 * The schema is `.strict()`, so a response that invents `mastery` or `confidence` fails
 * outright rather than having the field quietly dropped.
 */

export const sessionObservationSchema = z
  .object({
    /**
     * Concepts that genuinely came up, from the catalogue.
     *
     * "Came up", not "were learned". The session's own concept is nearly always among them,
     * and an exchange that wandered usefully into a prerequisite should say so.
     */
    conceptsDiscussed: z.array(conceptIdSchema).min(1).max(4),
    /**
     * Wrong beliefs the learner **stated**, from the catalogue. Usually empty.
     *
     * The bar is deliberately high and is spelled out in the instruction: asking what a list
     * is demonstrates a question, not a misconception. Tagging curiosity as error would put a
     * mark against a learner for the crime of asking, and it would be acted on later.
     */
    misconceptions: z.array(misconceptionIdSchema).max(2),
    /** One sentence of context for a human reading the record later. */
    note: proseText,
  })
  .strict()

export type SessionObservation = z.infer<typeof sessionObservationSchema>

export interface SessionObserveInput {
  readonly learner: LearnerContext
  readonly conceptId: ConceptId
  /** What the learner wrote. */
  readonly learnerMessage: string
  /** What the tutor replied. */
  readonly tutorReply: string
}

const SESSION_OBSERVE_INSTRUCTION = `TASK: note what this exchange was about. Nothing more.

Report:
- which concepts from the list above actually came up. The session's own concept will usually
  be one of them. Use the identifiers given and no others
- whether the learner **stated** a wrong belief that matches one of the catalogued
  misconceptions. Almost always the answer is none
- one sentence of context, for a person reading the record later

On misconceptions, the bar is high and you should expect to clear it rarely. A learner asking
"what is a list?" has asked a question. A learner saying "I do not follow" is telling you they
do not follow. Neither is a misconception. Only tag one when the learner has said something
that is wrong, in a way that matches a catalogued entry. When in doubt, report none — an
unfounded tag goes into a record about a person and gets acted on.

You are not assessing this learner. Whether they understood anything is not yours to judge and
you have no way to express it. Reading an explanation demonstrates nothing, saying "that makes
sense" demonstrates nothing, and you must not report either as though it did.`

export const sessionObserveStrategy: StructuredStrategy<SessionObserveInput, SessionObservation> = {
  kind: 'structured',
  id: 'session.observe',
  version: '1',
  purpose:
    'Note which concepts a conversational exchange touched. It cannot judge the learner and never affects their standing.',
  streams: false,
  schemaName: 'session_observation',
  schema: sessionObservationSchema,
  buildBlocks(input) {
    const concept = getConcept(input.conceptId)

    return composePrompt({
      strategy: SESSION_OBSERVE_INSTRUCTION,
      learner: input.learner,
      task: `SESSION CONCEPT: ${concept.id} — ${concept.title}\n\n${quoteLearnerText('THE LEARNER WROTE', input.learnerMessage)}\n\nYOU REPLIED\n${input.tutorReply}`,
    })
  },
  checkInvariants(output, input, context) {
    const problems: InvariantProblem[] = [
      ...checkConceptIds(output.conceptsDiscussed, context, 'conceptsDiscussed'),
      ...checkNoDuplicates(output.conceptsDiscussed, 'conceptsDiscussed'),
      ...checkMisconceptionIds(output.misconceptions, context, 'misconceptions'),
      ...checkNoDuplicates(output.misconceptions, 'misconceptions'),
    ]

    // The exchange happened inside a session about one concept. An observation that does not
    // mention it is describing some other conversation.
    if (!output.conceptsDiscussed.includes(input.conceptId)) {
      problems.push({
        code: 'session-concept-not-listed',
        detail: `This session is about ${input.conceptId}, so conceptsDiscussed must include it.`,
      })
    }

    return problems
  },
  /**
   * Nothing.
   *
   * There is a safe thing to record when an attempt cannot be interpreted — the attempt
   * happened. There is no equivalent here: if the model could not say what the exchange was
   * about, the honest record is no record. Writing "discussed the session's concept" would be
   * inventing an observation to fill a row, and the row exists to be read later as though
   * someone had actually looked.
   */
  safeFallback() {
    return null
  },
}
