import { dependentsOf, getConcept, transitivePrerequisites } from '../curriculum/graph'
import type { ConceptId, MisconceptionId } from '../curriculum/types'
import { bandOf, evidenceStrengthOf, type ConceptState } from '../learner-model/state'
import {
  itemsProbing,
  practiceItemsFor,
  type PracticeItem,
} from './items'

/**
 * When to check understanding, and with what.
 *
 * The instruction for this milestone was that the tutor should "occasionally check
 * understanding within the same learning flow" and should not "ask questions merely to populate
 * data". Both halves are decisions this file makes, deterministically, before any model is
 * involved — so the reason a question was asked can be recorded, shown, and argued with.
 *
 * The decision is made from what the learner model already holds: their band on this concept,
 * how much evidence is behind it, which wrong ideas have been seen recently, and what has
 * already been asked in this session. No model is consulted about any of that, because a model
 * asked "should I test them now?" is being asked to reason about a learner state it can only
 * guess at.
 */

/** How many exchanges of teaching before a check is worth interrupting for. */
const TURNS_BEFORE_FIRST_CHECK = 1

/** How many checks one session should hold before it becomes a quiz. */
export const MAX_CHECKS_PER_SESSION = 4

/** Why this activity, in the selector's own terms. Stored with the activity. */
export type SelectionGround =
  /**
   * A wrong idea was seen recently on this concept and this item is designed to expose it.
   *
   * The strongest reason there is: a learner coming back to a misconception gets an activity
   * that actually probes it rather than a general question about the topic.
   */
  | {
      readonly kind: 'probes-misconception'
      readonly misconception: MisconceptionId
      /**
       * Set when the question is about a different concept from the one being taught.
       *
       * Coming back to something that went wrong earlier is a reasonable thing for a tutor to
       * do mid-lesson, but only if it says so. Without this the learner was shown a question on
       * unrelated material under a reason that never mentioned the change of subject.
       */
      readonly about?: ConceptId | undefined
    }
  /** Nothing has been demonstrated here yet, so anything at all is informative. */
  | { readonly kind: 'no-evidence-yet' }
  /** Attempted and going wrong; a check tells us whether the explanation landed. */
  | { readonly kind: 'shaky' }
  /** Underway, and another answer would settle which way it is going. */
  | { readonly kind: 'unsettled' }

export type CheckDecision =
  | { readonly kind: 'ask'; readonly item: PracticeItem; readonly ground: SelectionGround }
  /**
   * Ask a generated question instead, because the bank has nothing left for this concept.
   *
   * Generation is the fallback rather than the default: an authored item is more reliable, and
   * the cost of an unreliable assessment item is a false diagnosis in a record about a person.
   */
  | { readonly kind: 'generate'; readonly conceptId: ConceptId; readonly ground: SelectionGround }
  /** Not now. Teaching is what this moment is for. */
  | { readonly kind: 'hold'; readonly because: HoldReason }

export type HoldReason =
  /** The conversation has barely started. */
  | 'too-early'
  /** Enough has been asked in this session already. */
  | 'enough-for-now'
  /** The learner answered something a moment ago; two in a row is an interrogation. */
  | 'just-asked'
  /** Secure, with strong evidence. There is nothing a question here would tell anybody. */
  | 'nothing-to-learn'

export interface CheckContext {
  readonly conceptId: ConceptId
  readonly state: ConceptState
  /** Misconceptions observed recently, most recent first. From real attempts, not conversation. */
  readonly recentMisconceptions: readonly MisconceptionId[]
  /** Practice item ids already used, ever. A repeat teaches only that it is a repeat. */
  readonly usedItemIds: readonly string[]
  /**
   * Concepts this learner has been assessed on at all.
   *
   * A probe may reach outside the current concept, but only into material they have actually
   * met: an item on something never taught produces negative evidence for a concept the
   * learner was never introduced to.
   */
  readonly assessed: readonly ConceptId[]
  /** How many teaching exchanges have happened in this session. */
  readonly exchanges: number
  /** How many checks this session has already contained. */
  readonly checksSoFar: number
  /** True when the previous thing in the session was itself a check. */
  readonly lastWasCheck: boolean
}

/**
 * Whether to interrupt the teaching with a question, and which one.
 *
 * The holds come first and are deliberately generous. A tutor that checks understanding after
 * every paragraph is not checking understanding, it is administering a test, and the brief is
 * explicit that this must not feel like switching into a separate quiz application.
 */
export function decideCheck(context: CheckContext): CheckDecision {
  if (context.exchanges < TURNS_BEFORE_FIRST_CHECK) return { kind: 'hold', because: 'too-early' }
  if (context.lastWasCheck) return { kind: 'hold', because: 'just-asked' }
  if (context.checksSoFar >= MAX_CHECKS_PER_SESSION) {
    return { kind: 'hold', because: 'enough-for-now' }
  }

  // Nothing a question would tell anybody. Asking anyway would be asking to populate data,
  // which the brief rules out and which wastes the learner's time.
  if (bandOf(context.state) === 'secure' && evidenceStrengthOf(context.state) === 'strong') {
    return { kind: 'hold', because: 'nothing-to-learn' }
  }

  const ground = groundFor(context)
  const unused = (item: PracticeItem): boolean => !context.usedItemIds.includes(item.id)

  // A misconception probe first, and only one that has not been used. This is what makes
  // "a learner returning to a weak misconception receives an activity that actually probes
  // that misconception" true rather than aspirational.
  if (ground.kind === 'probes-misconception') {
    const probe = itemsProbing(ground.misconception).find(
      (item) => item.conceptId === context.conceptId && unused(item),
    )
    if (probe !== undefined) return { kind: 'ask', item: probe, ground }

    /*
     * A probe on another concept is still a probe — but two things have to be true, and neither
     * was checked.
     *
     * Any item probing the misconception used to be accepted, so a session on how a program runs
     * could ask about rebinding `self` inside a method, under the reason "checking one specific
     * thing: whether the idea behind an earlier wrong answer is still there", with the evidence
     * landing on a concept the learner had never been taught and the reason never mentioning the
     * change of subject.
     *
     * Now: the material has to be something they have met (a neighbour of what they are working
     * on, or something they have already been assessed on), and the ground carries the topic so
     * the question can say what it is about.
     */
    const elsewhere = itemsProbing(ground.misconception).find(
      (item) => unused(item) && reachable(context, item.conceptId),
    )
    if (elsewhere !== undefined) {
      return { kind: 'ask', item: elsewhere, ground: { ...ground, about: elsewhere.conceptId } }
    }
  }

  const available = practiceItemsFor(context.conceptId).filter(unused)
  if (available.length === 0) return { kind: 'generate', conceptId: context.conceptId, ground }

  // Pitched nearest to where the learner looks on this concept, which for a concept with no
  // evidence is its own baseline difficulty.
  const target =
    context.state.evidenceCount === 0
      ? getConcept(context.conceptId).baselineDifficulty
      : context.state.theta

  const best = available.reduce((chosen, candidate) =>
    Math.abs(candidate.difficulty - target) < Math.abs(chosen.difficulty - target)
      ? candidate
      : chosen,
  )

  return { kind: 'ask', item: best, ground }
}

/**
 * Why a check is being asked at all.
 *
 * A recent misconception on this concept outranks everything else: it is the one case where the
 * tutor has a specific hypothesis to test rather than a general wish to know more.
 */
function groundFor(context: CheckContext): SelectionGround {
  // Probeable means there is an item for it that this learner has not already seen. Claiming
  // to probe a misconception and then asking a general question would make the stored reason a
  // fiction, and the reason is shown to the learner.
  const probeable = context.recentMisconceptions.find((misconception) =>
    itemsProbing(misconception).some(
      (item) =>
        !context.usedItemIds.includes(item.id) && reachable(context, item.conceptId),
    ),
  )

  if (probeable !== undefined) return { kind: 'probes-misconception', misconception: probeable }

  const band = bandOf(context.state)
  if (band === 'not-started') return { kind: 'no-evidence-yet' }
  if (band === 'needs-review') return { kind: 'shaky' }
  return { kind: 'unsettled' }
}

/**
 * Whether a question about `other` is a fair thing to ask this learner now.
 *
 * Either it is near what they are working on — the same area, something it is built on, or
 * something built on it, all of them the curriculum's own statements rather than a judgement —
 * or they have already been assessed on it, which is how a wrong answer from the diagnostic gets
 * followed up in a later session. Anything else is material they have not met.
 */
function reachable(context: CheckContext, other: ConceptId): boolean {
  const conceptId = context.conceptId
  if (conceptId === other) return true
  if (getConcept(conceptId).area === getConcept(other).area) return true
  if (transitivePrerequisites(conceptId).has(other)) return true
  if (dependentsOf(conceptId).some((concept) => concept.id === other)) return true

  return context.assessed.includes(other)
}

/** The ground in words, for the activity's stored reason and for the learner. */
export function describeGround(ground: SelectionGround): string {
  switch (ground.kind) {
    case 'probes-misconception':
      return ground.about === undefined
        ? 'Checking one specific thing: whether the idea behind an earlier wrong answer is still there.'
        : `Coming back to ${getConcept(ground.about).title.toLowerCase()}, where an answer went wrong earlier, to see whether the idea behind it is still there.`
    case 'no-evidence-yet':
      return 'A first check on this, since nothing has been tried here yet.'
    case 'shaky':
      return 'A check on this, because it has been going wrong.'
    case 'unsettled':
      return 'A check on this, because one more answer would settle which way it is going.'
  }
}
