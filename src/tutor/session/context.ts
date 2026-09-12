import { getConcept } from '@/domain/curriculum/graph'
import type { ConceptId, MisconceptionId } from '@/domain/curriculum/types'
import type { ConceptState } from '@/domain/learner-model/state'
import { boundedHistory, historyWasTrimmed, type Turn } from '@/domain/tutoring/session'

import { summariseConcept, type LearnerContext } from '../blocks/learner'
import type { ConverseTurn } from '../strategies/prose'

/**
 * What the tutor is told, and — more importantly — what it is not.
 *
 * The instruction for this milestone was to pass context relevant to the current teaching
 * decision rather than dumping the learner's profile into the prompt. Those are genuinely
 * different: thirty-three concept bands would be thirty-three lines of noise on every call,
 * most of them about material the learner is not looking at, and a model given all of it will
 * dutifully reason about all of it.
 *
 * So the context is: the concept in front of them, its immediate prerequisites, and any wrong
 * ideas seen recently. Everything else stays in the database, where it belongs.
 */

/** How many past misconceptions are worth mentioning. Older ones have probably been addressed. */
const RECENT_MISCONCEPTIONS = 3

export interface ContextInput {
  readonly goal: string | null
  readonly conceptId: ConceptId
  /** Every concept state, from which the relevant few are selected. */
  readonly states: readonly ConceptState[]
  /** Misconceptions seen recently, most recent first. */
  readonly recentMisconceptions: readonly MisconceptionId[]
}

/**
 * The learner block for a tutoring call.
 *
 * `related` is the concept's direct prerequisites and nothing further out. They are what
 * decides whether an explanation can lean on something or has to build it — a learner shaky on
 * variables needs a different account of loop accumulation than one who is solid on them. The
 * rest of the curriculum has no bearing on the sentence the tutor is about to write.
 */
export function tutoringContext(input: ContextInput): LearnerContext {
  const byId = new Map(input.states.map((state) => [state.conceptId, state]))
  const focusState = byId.get(input.conceptId)

  const related = getConcept(input.conceptId).prerequisites.flatMap((id) => {
    const state = byId.get(id)
    return state === undefined ? [] : [summariseConcept(state)]
  })

  return {
    goal: input.goal,
    focus: focusState === undefined ? null : summariseConcept(focusState),
    related,
    recentMisconceptions: input.recentMisconceptions.slice(0, RECENT_MISCONCEPTIONS),
  }
}

/**
 * The conversation as the `converse` strategy takes it.
 *
 * Bounded by `boundedHistory`, and where turns were left out the tutor is told so rather than
 * being handed a thread that silently begins in the middle. Being told "there is more earlier"
 * is the difference between a tutor that knows it has forgotten something and one that
 * confidently treats the fourth exchange as the first.
 */
export interface BoundedConversation {
  readonly history: readonly ConverseTurn[]
  readonly trimmed: boolean
}

export function conversationFor(turns: readonly Turn[]): BoundedConversation {
  return {
    history: boundedHistory(turns).map((turn) => ({
      /*
       * An evaluated check is something the tutor did, so it enters the history as a tutor
       * turn. Its text is a compact record of the exchange — the question, the learner's
       * answer and whether it was right — written by `summariseCheck` when the answer is
       * recorded, and used only here.
       *
       * The interface never renders it: the page builds a check from `session_activity`, which
       * holds the options, the feedback and the marking. This is the model's view, and the
       * reason it exists is that a follow-up written without knowing the learner had just got
       * something wrong is a follow-up that ignores the most useful thing in the session.
       */
      role: turn.role === 'learner' ? 'learner' : 'tutor',
      text: turn.text,
    })),
    trimmed: historyWasTrimmed(turns),
  }
}

/**
 * The one-paragraph record of a check, for the tutor's context.
 *
 * Deliberately flat prose rather than a structured payload: it is going into a prompt, and a
 * sentence is what a model reads best. The learner's own words are *not* included verbatim —
 * they are quoted separately wherever they matter, and an unquoted copy riding inside a
 * tutor-attributed turn would be an injection point.
 */
export function summariseCheck(input: {
  readonly prompt: string
  readonly marked: boolean
  readonly correct: boolean
  readonly partial: boolean
  readonly misconceptions: readonly string[]
}): string {
  const outcome = !input.marked
    ? 'Their answer could not be marked, so nothing was concluded from it.'
    : input.correct
      ? input.partial
        ? 'They got it right, with part of the reasoning unstated.'
        : 'They got it right.'
      : 'They got it wrong.'

  const named =
    input.misconceptions.length === 0
      ? ''
      : ` What it showed: ${input.misconceptions.join(', ')}.`

  return `You checked their understanding with this question:
${input.prompt}

${outcome}${named}`
}

/**
 * The one-line note added when the thread has been trimmed.
 *
 * Kept separate from the history so it cannot be mistaken for something either party said.
 */
export function trimmedNote(conceptId: ConceptId): string {
  return `Earlier turns in this conversation about ${getConcept(conceptId).title} are not shown. If the learner refers to something you cannot see, say so and ask them to remind you rather than guessing.`
}
