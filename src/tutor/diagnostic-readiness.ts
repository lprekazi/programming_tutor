import { DIAGNOSTIC_ITEMS, isDeterministic } from '@/domain/diagnostic/items'
import { resolveProvider } from '@/llm/resolve'

/**
 * Which diagnostic items cannot be marked right now.
 *
 * Almost the whole bank is scored without a model: a choice has a correct option, an output
 * prediction has an expected string, the practical task has tests. Only a written explanation
 * needs reading, and when no tutor is configured or reachable there is nothing that can read
 * it.
 *
 * Asking it anyway would leave the learner writing a paragraph that goes nowhere, so it is
 * taken out of the pool before it is offered. The diagnostic still runs, still adapts, and
 * still produces a profile — it simply covers a little less, and says so.
 *
 * Deliberately evaluated per request rather than cached: a key added, or a provider that comes
 * back, should take effect on the next question rather than on the next restart.
 */
export function unmarkableItemIds(): readonly string[] {
  if (resolveProvider() !== null) return []
  return DIAGNOSTIC_ITEMS.filter((item) => !isDeterministic(item)).map((item) => item.id)
}

/** Whether a tutor can be reached at all. Used to explain a reduced diagnostic honestly. */
export function tutorIsReachable(): boolean {
  return resolveProvider() !== null
}
