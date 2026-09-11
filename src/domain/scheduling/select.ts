import { CONCEPTS } from '../curriculum/concepts'
import { getConcept } from '../curriculum/graph'
import type { Concept, ConceptId } from '../curriculum/types'
import { SETTLED_UNCERTAINTY } from '../learner-model/parameters'
import {
  bandOf,
  bandRank,
  initialConceptState,
  isReviewDue,
  masteryMargin,
  type Band,
  type ConceptState,
} from '../learner-model/state'
import { overdueBy } from './review'

/**
 * Choosing what the learner should work on next.
 *
 * The rule the whole thing rests on: a concept is only offered once its prerequisites have
 * actually been demonstrated. Everything else is a priority ordering over the concepts
 * that are reachable.
 *
 * The decision is returned with its reason, not just its answer, because the learner is
 * shown *why* this was chosen. A tutor that cannot explain its own choice is a black box,
 * and the reason has to be the real one — it is derived here, not written afterwards.
 */

/** Prerequisites count as met once the learner is past the weak band. */
const PREREQUISITE_MIN_BAND: Band = 'developing'

export type SelectionReason =
  /** Due for revisiting. */
  | { readonly kind: 'review-due'; readonly overdueMs: number }
  /** Attempted and currently weak. */
  | { readonly kind: 'weak' }
  /** Underway, and the estimate is still unsettled. */
  | { readonly kind: 'in-progress'; readonly uncertainty: number }
  /** Not started, and now reachable. */
  | { readonly kind: 'new' }
  /** Underway and as settled as it will get, but still short of secure. */
  | { readonly kind: 'consolidating' }

export interface Selection {
  readonly conceptId: ConceptId
  readonly reason: SelectionReason
}

/** The learner's state for every concept, defaulting to untouched. */
export type StateLookup = (conceptId: ConceptId) => ConceptState

/** Builds a lookup from whatever states have been stored so far. */
export function stateLookupFrom(states: readonly ConceptState[]): StateLookup {
  const byId = new Map(states.map((state) => [state.conceptId, state]))
  return (conceptId) => byId.get(conceptId) ?? initialConceptState(conceptId)
}

/** Whether every prerequisite of `concept` has been demonstrated well enough to move on. */
export function prerequisitesMet(concept: Concept, lookup: StateLookup): boolean {
  return concept.prerequisites.every(
    (id) => bandRank(bandOf(lookup(id))) >= bandRank(PREREQUISITE_MIN_BAND),
  )
}

/** Prerequisites of `conceptId` that are not yet met, in declaration order. */
export function unmetPrerequisites(conceptId: ConceptId, lookup: StateLookup): readonly ConceptId[] {
  return getConcept(conceptId).prerequisites.filter(
    (id) => bandRank(bandOf(lookup(id))) < bandRank(PREREQUISITE_MIN_BAND),
  )
}

/** Concepts the learner could work on right now. */
export function availableConcepts(lookup: StateLookup): readonly Concept[] {
  return CONCEPTS.filter((concept) => prerequisitesMet(concept, lookup))
}

/**
 * Picks the next concept, or `null` when everything reachable is secure and nothing is due.
 *
 * Priority, highest first:
 *
 *  1. **Due for review.** Spaced retrieval beats pressing on, and a concept that has gone
 *     stale is the most perishable thing on the list. Most overdue wins.
 *  2. **Weak.** Something attempted and not going well is worth more than something new;
 *     leaving it behind is how gaps compound. Lowest estimate wins.
 *  3. **In progress.** Among concepts underway, the least settled estimate is the one
 *     another attempt tells us most about.
 *  4. **New.** Otherwise move the frontier, easiest first, so the step from what the
 *     learner has shown is as small as the graph allows.
 *
 * Ties inside a tier break on the curriculum's declaration order, so the same state always
 * produces the same choice.
 */
export function selectNextConcept(lookup: StateLookup, now: number): Selection | null {
  const available = availableConcepts(lookup)

  // Dueness is decided by `isReviewDue`, the same predicate the interface uses, so a
  // concept shown as "due now" can never be silently skipped here.
  const dueForReview = available
    .filter((concept) => isReviewDue(lookup(concept.id), now))
    .map((concept) => ({ concept, overdueMs: overdueBy(lookup(concept.id), now) }))
  if (dueForReview.length > 0) {
    const best = pickBy(dueForReview, (candidate) => -candidate.overdueMs)
    return { conceptId: best.concept.id, reason: { kind: 'review-due', overdueMs: best.overdueMs } }
  }

  const weak = available.filter((concept) => bandOf(lookup(concept.id)) === 'needs-review')
  if (weak.length > 0) {
    const best = pickBy(weak, (concept) => lookup(concept.id).theta)
    return { conceptId: best.id, reason: { kind: 'weak' } }
  }

  const developing = available.filter((concept) => bandOf(lookup(concept.id)) === 'developing')

  // Only while another attempt would still tell us something. Once uncertainty has bottomed
  // out, repeating the concept adds no information — and without this the tier is a sink: a
  // learner who leans on hints never reaches `secure`, so they would be held on their first
  // concept for ever.
  const unsettled = developing.filter((concept) => lookup(concept.id).uncertainty > SETTLED_UNCERTAINTY)
  if (unsettled.length > 0) {
    const best = pickBy(unsettled, (concept) => -lookup(concept.id).uncertainty)
    return {
      conceptId: best.id,
      reason: { kind: 'in-progress', uncertainty: lookup(best.id).uncertainty },
    }
  }

  const fresh = available.filter((concept) => bandOf(lookup(concept.id)) === 'not-started')
  if (fresh.length > 0) {
    const best = pickBy(fresh, (concept) => concept.baselineDifficulty)
    return { conceptId: best.id, reason: { kind: 'new' } }
  }

  // Settled, but short of secure — typically because every success so far has needed help.
  // Offered last so it never blocks new material, but offered, so the learner is not left
  // with nothing while a concept remains unfinished.
  if (developing.length > 0) {
    const best = pickBy(developing, (concept) => masteryMargin(lookup(concept.id)))
    return { conceptId: best.id, reason: { kind: 'consolidating' } }
  }

  return null
}

/** Smallest score wins; the first of equal scores wins, so ordering is stable. */
function pickBy<T>(items: readonly T[], score: (item: T) => number): T {
  let best = items[0]
  if (best === undefined) throw new Error('pickBy requires a non-empty list.')
  let bestScore = score(best)

  for (const item of items.slice(1)) {
    const current = score(item)
    if (current < bestScore) {
      best = item
      bestScore = current
    }
  }
  return best
}

/**
 * The sentence shown behind "Why this?".
 *
 * Derived from the reason the scheduler actually acted on, so it cannot drift away from
 * the real decision.
 */
export function describeSelection(selection: Selection): string {
  const title = getConcept(selection.conceptId).title.toLowerCase()

  switch (selection.reason.kind) {
    case 'review-due': {
      const days = Math.floor(selection.reason.overdueMs / 86_400_000)
      const when = days >= 1 ? `${String(days)} day${days === 1 ? '' : 's'} ago` : 'earlier today'
      return `Coming back to ${title}, which was due for review ${when}. Recalling something after a gap is what makes it stick.`
    }
    case 'weak':
      // Deliberately not "the hardest topic you have tried": the scheduler picks the lowest
      // estimate among concepts currently *available*, which is a narrower claim.
      return `Working on ${title}, which is the weakest of the topics open to you at the moment.`
    case 'in-progress':
      return `Continuing with ${title}. You have made a start, but there is not yet enough to be confident either way.`
    case 'new':
      return `Starting ${title}. Everything it depends on is in place.`
    case 'consolidating':
      return `Returning to ${title}. You can get there, but not yet on your own, so it is worth another go.`
  }
}
