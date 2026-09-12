import type { ConceptId } from '../curriculum/types'
import type { Band, ConceptState } from '../learner-model/state'
import { bandOf, evidenceStrengthOf } from '../learner-model/state'

/**
 * The shape of a tutoring conversation, and the decisions that can be made about it without
 * a database, a clock or a model.
 *
 * Two things live here because both are rules rather than plumbing, and both are easy to get
 * quietly wrong: how much of a conversation to send back to the model, and how to pitch the
 * opening turn. Keeping them pure means they can be tested exhaustively, and it keeps the
 * decision about *what the tutor is told* out of the layer that happens to make the call.
 */

/**
 * The longest message the learner can send in one go.
 *
 * Not a technical limit — it is well inside anything the provider would refuse. It is there
 * because a message this long is almost always several questions at once, which gets a worse
 * answer than asking them one at a time, and because an unbounded box is an unbounded prompt.
 */
export const MAX_MESSAGE_LENGTH = 2000

export type TurnRole = 'tutor' | 'learner'

export type TurnStatus =
  /** Created, nothing has arrived yet. */
  | 'pending'
  /** Text is arriving. */
  | 'streaming'
  /** Finished normally. */
  | 'complete'
  /** The learner stopped it. Whatever had arrived is kept. */
  | 'cancelled'
  /** Something went wrong. Whatever had arrived is kept, and it can be retried. */
  | 'failed'

export interface Turn {
  readonly id: string
  readonly ordinal: number
  readonly role: TurnRole
  readonly text: string
  readonly status: TurnStatus
}

/**
 * How many past turns are sent back to the model.
 *
 * Every turn is kept in the database for ever; this is only about what rides on each request.
 * Resending an unbounded transcript would grow the cost of every turn without bound and, long
 * before that became expensive, would start pushing the policy and curriculum blocks out of
 * whatever the model can actually attend to.
 *
 * Eight is four exchanges. Enough to follow a thread of reasoning and to know what "it" refers
 * to; not so much that a conversation from last week steers today's answer. The concept, the
 * learner's standing and their goal all ride separately and do not decay, so the things that
 * genuinely need to persist are not what this window is carrying.
 *
 * Deliberately not a summarisation scheme. Summarising is worth doing when the alternative is
 * losing something that matters, and at this length nothing does.
 */
export const CONTEXT_TURNS = 8

/**
 * The turns worth sending, oldest first.
 *
 * Only completed turns. A pending turn has no text, and a cancelled or failed one was never
 * read to the end — treating either as something the tutor said would have it referring back
 * to half a sentence the learner may never have seen.
 */
export function boundedHistory(turns: readonly Turn[], limit: number = CONTEXT_TURNS): readonly Turn[] {
  const usable = turns
    .filter((turn) => turn.status === 'complete' && turn.text.trim().length > 0)
    .sort((a, b) => a.ordinal - b.ordinal)

  return limit <= 0 ? [] : usable.slice(-limit)
}

/** True when the window above left something out, so the tutor can be told the thread is longer. */
export function historyWasTrimmed(
  turns: readonly Turn[],
  limit: number = CONTEXT_TURNS,
): boolean {
  return turns.filter((turn) => turn.status === 'complete' && turn.text.trim().length > 0).length > limit
}

/**
 * The next free position in the conversation.
 *
 * Derived from the highest ordinal rather than from the count, so a gap — which a failed
 * insert could leave — never causes a collision with a turn that already exists.
 */
export function nextOrdinal(turns: readonly Turn[]): number {
  return turns.reduce((highest, turn) => Math.max(highest, turn.ordinal + 1), 0)
}

/** The most recent turn awaiting or carrying tutor text, if the conversation ends on one. */
export function unfinishedTutorTurn(turns: readonly Turn[]): Turn | null {
  const last = [...turns].sort((a, b) => a.ordinal - b.ordinal).at(-1)
  if (last === undefined || last.role !== 'tutor') return null
  return last.status === 'complete' ? null : last
}

/**
 * How to pitch the opening turn.
 *
 * The requirement is that a learner meeting a concept for the first time and a learner coming
 * back to one they got wrong do not receive the same opening. Both facts are already in the
 * learner model, so this is a mapping rather than a judgement — which matters, because a model
 * asked to decide how much the learner knows would be deciding it from its own impression.
 */
export type OpeningPitch =
  /** Nothing demonstrated here yet. Start from an example. */
  | 'introduce'
  /** Attempted, and going wrong somewhere specific. */
  | 'clarify'
  /** Largely there. Go to the edge that separates working from solid. */
  | 'deepen'

export function pitchFor(state: ConceptState): OpeningPitch {
  const band: Band = bandOf(state)

  switch (band) {
    case 'not-started':
      return 'introduce'
    case 'needs-review':
      return 'clarify'
    case 'developing':
      // Developing on one or two answers is much closer to new than to solid, and opening at
      // the subtlety would be pitched over the head of someone who has answered twice.
      return evidenceStrengthOf(state) === 'limited' ? 'introduce' : 'clarify'
    case 'secure':
      return 'deepen'
  }
}

/**
 * Whether this opening is a first meeting or a return.
 *
 * Separate from the pitch because they answer different questions: the pitch decides how deep
 * to go, this decides whether to greet the concept as new. A learner can be returning to
 * something and still need it introduced again.
 */
export function isReturning(state: ConceptState): boolean {
  return state.evidenceCount > 0
}

/** Concept and standing, resolved once so callers do not each re-derive them. */
export interface SessionFocus {
  readonly conceptId: ConceptId
  readonly pitch: OpeningPitch
  readonly returning: boolean
}

export function focusFor(state: ConceptState): SessionFocus {
  return {
    conceptId: state.conceptId,
    pitch: pitchFor(state),
    returning: isReturning(state),
  }
}
