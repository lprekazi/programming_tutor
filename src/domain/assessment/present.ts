import type { ConceptId } from '../curriculum/types'
import type { PracticeItemKind } from './items'

/**
 * What the browser is allowed to know about a question it is about to ask.
 *
 * The same rule the diagnostic follows, and for the same reason: a question whose answer key
 * travels with it is not an assessment. What goes across is the prompt, the code to read, and
 * the options in the order they will be shown. What stays behind is which option is correct,
 * which wrong answers are worth recognising, what a good written answer contains, and the
 * explanation — the explanation too, because it names the right answer.
 *
 * Unlike M3's practical item there is no exception here. Nothing in M5 runs in the browser, so
 * nothing in M5 needs the browser to be told anything it could mark itself with.
 *
 * Asserted over the whole bank in `present.test.ts` rather than at each call site, so a field
 * added to an item later cannot leak by being forgotten.
 */

interface PresentedBase {
  readonly id: string
  readonly conceptId: ConceptId
  readonly prompt: string
  /** Python to read, where the question involves reading code. */
  readonly code: string | null
  /** Why the tutor is asking, in the selector's own words. */
  readonly ground: string
}

export type PresentedActivity =
  | (PresentedBase & { readonly kind: 'choice'; readonly options: readonly string[] })
  | (PresentedBase & { readonly kind: 'predict-output' })
  | (PresentedBase & { readonly kind: 'short-response' })

/** Everything stored about an activity, as the server holds it. */
export interface StoredActivity {
  readonly id: string
  readonly conceptId: ConceptId
  readonly kind: PracticeItemKind
  readonly prompt: string
  readonly code: string | null
  readonly options: readonly string[] | null
  readonly correctIndex: number | null
  readonly optionMisconceptions: readonly (string | null)[] | null
  readonly expectedOutput: string | null
  readonly knownWrongAnswers:
    | readonly { readonly answer: string; readonly misconception: string }[]
    | null
  readonly expectedPoints: string | null
  readonly explanation: string
  readonly selectionGround: string
}

export function presentActivity(activity: StoredActivity): PresentedActivity {
  const base = {
    id: activity.id,
    conceptId: activity.conceptId,
    prompt: activity.prompt,
    code: activity.code,
    ground: activity.selectionGround,
  }

  switch (activity.kind) {
    case 'choice':
      return { ...base, kind: 'choice', options: activity.options ?? [] }
    case 'predict-output':
      return { ...base, kind: 'predict-output' }
    case 'short-response':
      return { ...base, kind: 'short-response' }
  }
}
