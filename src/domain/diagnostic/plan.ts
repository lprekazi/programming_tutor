import { getConcept, transitivePrerequisites } from '../curriculum/graph'
import type { ConceptId } from '../curriculum/types'
import type { OnboardingAnswers } from '../onboarding/self-report'
import { startingDifficulty } from '../onboarding/self-report'

import { DIAGNOSTIC_ITEMS, type DiagnosticItem } from './items'

/**
 * Choosing which diagnostic items to ask, and when to stop.
 *
 * Two competing pressures. The diagnostic has to cover enough ground to initialise a profile
 * worth having, and it has to be short enough that a learner finishes it — an abandoned
 * diagnostic produces no profile at all.
 *
 * So it is adaptive, but adaptive in a way that can be explained in a sentence and reproduced
 * exactly. Every decision below is a function of the answers so far. There is no randomness,
 * no model call, and no tie broken by anything other than declaration order.
 *
 * The rule that matters most is the one about what is *not* asked. Skipping an item because
 * its prerequisites have failed means the tutor knows less, not more — and those concepts stay
 * `not-started` rather than being inferred as weak. A diagnostic that guessed would be worse
 * than one that admitted it did not ask.
 */

/** Longest the diagnostic may run. Around fifteen minutes of work. */
export const MAX_ITEMS = 12

/** Shortest it may be, however clear the picture looks. */
export const MIN_ITEMS = 7

/**
 * Consecutive unaided failures on a concept's prerequisites before its items are skipped.
 *
 * Two, not one. A single wrong answer is often a slip, and cutting a learner off from a whole
 * branch of the curriculum on one mistake would be both wrong and demoralising.
 */
export const FAILURES_BEFORE_SKIP = 2

/** One answered item, as the planner sees it. */
export interface AnsweredItem {
  readonly itemId: string
  readonly conceptId: ConceptId
  readonly correct: boolean
}

export interface PlanState {
  readonly answers: readonly AnsweredItem[]
  readonly onboarding: OnboardingAnswers
  /**
   * Items that cannot be asked at the moment, and why they are not simply treated as wrong.
   *
   * Only one kind of item needs a language model to mark it, and when the tutor cannot be
   * reached that item cannot be marked at all. Recording a guess would put invented evidence
   * against a learner because a network call did not come back; leaving the item in the pool
   * would offer it again forever. So it is set aside: nothing is recorded, nothing is
   * inferred, and the concept it would have tested stays unknown.
   */
  readonly unavailableItemIds?: readonly string[]
}

/** Why the diagnostic stopped, or why an item was chosen. Shown to the learner. */
export type PlanDecision =
  | {
      readonly kind: 'ask'
      readonly item: DiagnosticItem
      readonly position: number
      /**
       * True when answering this item will certainly end the diagnostic.
       *
       * "Certainly" is the operative word. Two of the three stopping rules — the item limit,
       * and enough breadth past the minimum — depend only on how many items have been asked
       * and which areas they touched, so they can be decided before the answer is given. The
       * third, running out of items worth asking, depends on whether the answer is right, so
       * it cannot. A false here therefore means "probably not the last", not "definitely not",
       * which is why the interface says *how many are left* rather than counting down to a
       * number it would have to revise.
       */
      readonly isLast: boolean
    }
  | {
      readonly kind: 'finished'
      readonly reason: 'covered-enough' | 'reached-limit' | 'nothing-left'
      readonly asked: number
    }

/** Concepts the learner has failed at least `FAILURES_BEFORE_SKIP` times. */
function failedConcepts(answers: readonly AnsweredItem[]): ReadonlySet<ConceptId> {
  const failures = new Map<ConceptId, number>()
  for (const answer of answers) {
    if (answer.correct) continue
    failures.set(answer.conceptId, (failures.get(answer.conceptId) ?? 0) + 1)
  }

  const failed = new Set<ConceptId>()
  for (const [conceptId, count] of failures) {
    if (count >= FAILURES_BEFORE_SKIP) failed.add(conceptId)
  }
  return failed
}

/**
 * Whether an item is worth asking.
 *
 * Excluded when already answered, when it has been set aside as unaskable, or when the concept
 * it tests rests on something the learner has now clearly failed — asking someone who cannot read a for loop to reason about nested
 * loops tells us nothing we did not already know, and costs them an item.
 */
export function isWorthAsking(item: DiagnosticItem, state: PlanState): boolean {
  if (state.answers.some((answer) => answer.itemId === item.id)) return false
  if (state.unavailableItemIds?.includes(item.id) === true) return false

  const failed = failedConcepts(state.answers)
  if (failed.has(item.conceptId)) return false

  for (const prerequisite of transitivePrerequisites(item.conceptId)) {
    if (failed.has(prerequisite)) return false
  }
  return true
}

/**
 * How well covered the curriculum is by what has been asked so far.
 *
 * Counted in distinct competence areas rather than items, because six questions about loops
 * tell us about loops and nothing else. Coverage is what makes an initial profile worth
 * having.
 */
function areasCovered(answers: readonly AnsweredItem[]): number {
  return new Set(answers.map((answer) => getConcept(answer.conceptId).area)).size
}

/** Areas the diagnostic aims to touch before it is willing to stop early. */
export const TARGET_AREAS = 5

/**
 * Picks the next item, or reports that the diagnostic is done.
 *
 * Selection, in order:
 *
 *  1. Nothing left worth asking → finished. Whatever was not asked stays unknown.
 *  2. At the item limit → finished.
 *  3. Past the minimum, with enough areas covered and no unresolved area → finished.
 *  4. Otherwise ask the item closest in difficulty to where the learner currently looks,
 *     preferring an area not yet touched.
 *
 * Step 4 is the adaptive part: get something wrong and the next item is easier; get it right
 * and it is harder. That keeps the items informative without needing many of them.
 */
export function nextDecision(state: PlanState): PlanDecision {
  const asked = state.answers.length
  const available = DIAGNOSTIC_ITEMS.filter((item) => isWorthAsking(item, state))

  if (available.length === 0) {
    return { kind: 'finished', reason: 'nothing-left', asked }
  }
  if (asked >= MAX_ITEMS) {
    return { kind: 'finished', reason: 'reached-limit', asked }
  }
  if (asked >= MIN_ITEMS && areasCovered(state.answers) >= TARGET_AREAS) {
    return { kind: 'finished', reason: 'covered-enough', asked }
  }

  const target = estimatedLevel(state)
  const touched = new Set(state.answers.map((answer) => getConcept(answer.conceptId).area))

  // Lowest score wins. An untouched area is worth a whole point of difficulty distance, so
  // breadth beats a marginally better-pitched item in an area already sampled.
  const best = available.reduce((chosen, candidate) => {
    const score = (item: DiagnosticItem): number =>
      Math.abs(item.difficulty - target) + (touched.has(getConcept(item.conceptId).area) ? 1 : 0)
    return score(candidate) < score(chosen) ? candidate : chosen
  })

  const areasAfter = new Set(touched).add(getConcept(best.conceptId).area).size
  const askedAfter = asked + 1
  const isLast =
    askedAfter >= MAX_ITEMS || (askedAfter >= MIN_ITEMS && areasAfter >= TARGET_AREAS)

  return { kind: 'ask', item: best, position: askedAfter, isLast }
}

/**
 * Roughly where the learner looks, in difficulty terms.
 *
 * Starts from what they said about themselves and moves with each answer. Crude on purpose —
 * it only has to pick a reasonable next question, and the real estimate is the learner model's
 * job, from evidence, afterwards.
 */
export function estimatedLevel(state: PlanState): number {
  let level = startingDifficulty(state.onboarding)

  for (const answer of state.answers) {
    level += answer.correct ? 0.35 : -0.45
  }
  return Math.min(2, Math.max(-2, level))
}

/**
 * How many items are left, as a range the learner can rely on.
 *
 * The previous version of this returned a single number and was quietly wrong. It was
 * `min(MAX_ITEMS, answered + stillAvailable)`, which with eighteen items in a bank capped at
 * twelve is simply twelve, every time — while a normal run stops at seven as soon as it has
 * enough breadth. The learner was told "1 of about 12" and shown the summary after the
 * seventh, which is exactly the sort of small lie a progress indicator exists not to tell.
 *
 * A single honest number is not available: whether the diagnostic stops at seven depends on
 * which areas the remaining items happen to cover, and whether it stops earlier still depends
 * on answers not yet given. So the range is reported instead. `least` can only rise and `most`
 * can only fall, so the two ends close on each other and neither ever moves the wrong way.
 */
export interface RemainingRange {
  /** The fewest further questions there could be, this one included. */
  readonly least: number
  /** The most there could be. */
  readonly most: number
}

export function remaining(state: PlanState): RemainingRange {
  const asked = state.answers.length
  const available = DIAGNOSTIC_ITEMS.filter((item) => isWorthAsking(item, state)).length

  const most = Math.max(0, Math.min(MAX_ITEMS, asked + available) - asked)

  // The earliest it could stop is at the minimum, or now if the minimum is already passed —
  // and never later than the most it could ask.
  const least = Math.min(most, Math.max(0, MIN_ITEMS - asked))

  return { least, most }
}

/**
 * Concepts the diagnostic asked about.
 *
 * Everything else stays `not-started`. Listed explicitly so the interface can say what was
 * covered, rather than implying the profile is complete.
 */
export function conceptsAsked(answers: readonly AnsweredItem[]): readonly ConceptId[] {
  return [...new Set(answers.map((answer) => answer.conceptId))]
}
