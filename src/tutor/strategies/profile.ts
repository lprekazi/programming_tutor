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
 * The strategy that comes closest to the line, and therefore the one drawn most carefully.
 *
 * After an attempt, something has to decide what it showed. The model is good at reading an
 * answer and saying "this demonstrates loops, and shows the range-endpoint confusion". It is
 * not the right thing to decide what that does to the learner's standing, because that
 * decision has to be consistent, reproducible, and attributable — and a model's judgement is
 * none of those.
 *
 * So the split is: the model observes, the domain decides.
 *
 * The schema below has no field for an ability estimate, a mastery percentage, a review
 * interval, or a change to any of them. That is not an oversight to be filled in later. The
 * schema is `.strict()`, so a response that invents such a field fails validation outright
 * rather than having it quietly ignored — a stricter guarantee than trusting a prompt
 * instruction to be followed, and one that holds even if the instruction is ignored.
 *
 * Everything this returns is an *observation about one attempt*. `deriveEvidence` in the
 * domain turns observations into numbers, and it is the only thing that can.
 */

export const profileUpdateSchema = z
  .object({
    /**
     * Concepts this attempt gave evidence about — whether the evidence was good or bad.
     *
     * Not "concepts the learner now knows". Whether an attempt counts for or against is
     * decided from the outcome, in the domain.
     */
    /**
     * At least one, always.
     *
     * An empty list looked valid and meant "this attempt bore on nothing" — a caller mapping
     * it onto evidence would write nothing at all. That is a channel: the attempt happened,
     * and model output would have decided it counted for nothing. The activity was about a
     * concept by construction, so there is always at least one honest answer.
     */
    demonstratedConcepts: z.array(conceptIdSchema).min(1).max(4),
    /** Wrong ideas this attempt shows evidence of, from the catalogue. */
    misconceptions: z.array(misconceptionIdSchema).max(3),
    /**
     * A qualitative read of the attempt, on a coarse scale.
     *
     * Coarse on purpose: these are the distinctions a model can make reliably from one
     * answer. Anything finer would be false precision that the domain would then act on.
     */
    judgement: z.enum([
      /** Right, and the reasoning behind it was sound. */
      'sound',
      /** Right, but the reasoning shown does not support it. */
      'right-for-wrong-reason',
      /** Wrong, but by a slip rather than a misunderstanding. */
      'slip',
      /** Wrong in a way that points at a misunderstanding. */
      'misunderstanding',
      /** Not enough in the attempt to tell. */
      'unclear',
    ]),
    /**
     * What in the attempt supports that judgement — quoted or described.
     *
     * Required. It is what makes the judgement checkable by a human reading the record later,
     * rather than a verdict with nothing behind it.
     */
    evidence: proseText,
  })
  .strict()

export type ProfileUpdate = z.infer<typeof profileUpdateSchema>

export interface ProfileUpdateInput {
  readonly learner: LearnerContext
  /** The concept the activity was about. */
  readonly conceptId: ConceptId
  readonly activityDescription: string
  readonly learnerResponse: string
  /** Whether the attempt was correct, already decided elsewhere. */
  readonly wasCorrect: boolean
  /** How many hints were taken before answering. */
  readonly hintDepth: number
}

const PROFILE_UPDATE_INSTRUCTION = `TASK: record what this one attempt showed.

You are observing, not marking and not grading. Whether the attempt was correct has already
been decided and is given to you.

Report:
- which concepts the attempt gave evidence about. Evidence can be positive or negative; you
  are naming what it bears on, not what they have mastered. Use the identifiers listed above
  and no others
- which catalogued misconceptions the attempt shows evidence of, if any. None is a perfectly
  good answer, and is far better than a tag that does not fit
- a qualitative read of the attempt
- what in the attempt supports that read — quote or describe the specific part

Be conservative. This becomes part of a record about a person, and a wrong observation is
acted on later.

You do not decide how much this changes their standing, and you have no way to express it.
Do not attempt to. Report what you saw.`

export const profileUpdateStrategy: StructuredStrategy<ProfileUpdateInput, ProfileUpdate> = {
  kind: 'structured',
  id: 'profile.update',
  version: '1',
  purpose: 'Observe what one attempt showed. It never decides what that does to learner state.',
  streams: false,
  schemaName: 'profile_observation',
  schema: profileUpdateSchema,
  buildBlocks(input) {
    const concept = getConcept(input.conceptId)
    const support =
      input.hintDepth === 0
        ? 'They answered without taking any hints.'
        : `They took ${String(input.hintDepth)} hint${input.hintDepth === 1 ? '' : 's'} before answering.`

    return composePrompt({
      strategy: PROFILE_UPDATE_INSTRUCTION,
      learner: input.learner,
      task: `CONCEPT: ${concept.id} — ${concept.title}\n\nTHE ACTIVITY\n${input.activityDescription}\n\n${quoteLearnerText('THEIR RESPONSE', input.learnerResponse)}\n\nOUTCOME (already decided; do not revisit it)\nThis attempt was ${input.wasCorrect ? 'correct' : 'not correct'}. ${support}`,
    })
  },
  checkInvariants(output, input, context) {
    const problems: InvariantProblem[] = [
      ...checkConceptIds(output.demonstratedConcepts, context, 'demonstratedConcepts'),
      ...checkNoDuplicates(output.demonstratedConcepts, 'demonstratedConcepts'),
      ...checkMisconceptionIds(output.misconceptions, context, 'misconceptions'),
      ...checkNoDuplicates(output.misconceptions, 'misconceptions'),
    ]

    // The observation has to be about the activity that was actually set. Without this, an
    // attempt on loops could deposit evidence against object-oriented programming.
    if (!output.demonstratedConcepts.includes(input.conceptId)) {
      problems.push({
        code: 'concept-not-covered',
        detail: `The activity was about ${input.conceptId}, so demonstratedConcepts must include it.`,
      })
    }

    // The outcome was decided before this call and handed in. An observation that contradicts
    // it is reporting on something other than what happened.
    //
    // Both wrong-answer judgements are blocked for a correct attempt, not only
    // "misunderstanding": "slip" is documented as *wrong* by a slip, so it contradicts a
    // correct outcome just as plainly.
    if (input.wasCorrect && (output.judgement === 'misunderstanding' || output.judgement === 'slip')) {
      problems.push({
        code: 'judgement-contradicts-outcome',
        detail: `The attempt was correct, so the judgement cannot be "${output.judgement}". Use "sound" or "right-for-wrong-reason".`,
      })
    }
    if (!input.wasCorrect && output.judgement === 'sound') {
      problems.push({
        code: 'judgement-contradicts-outcome',
        detail:
          'The attempt was not correct, so the judgement cannot be "sound". Use "slip", "misunderstanding" or "unclear".',
      })
    }

    // This is the observation that actually feeds misconceptions into the learner's record, so
    // it needs the same consistency check `answer.evaluate` applies: a correct attempt tagged
    // with a wrong idea would count for and against the same concept at once.
    if (input.wasCorrect && output.misconceptions.length > 0) {
      problems.push({
        code: 'misconception-on-correct-attempt',
        detail:
          'The attempt was correct, so it cannot also be tagged with misconceptions. If the reasoning was unsound, use the judgement "right-for-wrong-reason" and explain it in the evidence.',
      })
    }

    return problems
  },
  /**
   * The one strategy with a real fallback.
   *
   * When the model cannot produce a usable observation, the attempt still happened and the
   * domain still needs to record it — the learner answered, and that is evidence regardless
   * of whether anything could be said about *why*. So the fallback records the minimum that
   * is certainly true: the activity was about this concept, no misconceptions were
   * identified, and nothing could be concluded beyond the outcome.
   *
   * This invents nothing. "unclear" with no misconceptions is the honest description of an
   * attempt nobody managed to interpret, and the numeric update the domain derives from the
   * outcome is unaffected either way.
   */
  safeFallback(input) {
    return {
      demonstratedConcepts: [input.conceptId],
      misconceptions: [],
      judgement: 'unclear',
      evidence: 'The tutor could not interpret this attempt, so nothing was concluded from it beyond whether it was correct.',
    }
  },
}
