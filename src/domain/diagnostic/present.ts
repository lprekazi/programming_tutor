import type { DiagnosticItem } from './items'

/**
 * What the browser is allowed to know about an item it is about to ask.
 *
 * Everything that decides whether an answer is right stays on the server: the correct option
 * index, the expected output, the points a written answer should make, the wrong answers worth
 * recognising. A diagnostic whose answer key travels with the question is not a diagnostic.
 *
 * The practical item is the one deliberate exception, and it is not really an exception. Its
 * tests have to reach the browser because that is where Python runs — learner code is never
 * sent to a server-side interpreter — and in any case the tests *are* the specification. The
 * learner is told what `count_evens` must do; being able to read the three assertions that
 * check it gives away nothing they were not already told, and no reference solution exists to
 * give away.
 *
 * The honest consequence is recorded rather than hidden: because the practical item is marked
 * from a result the browser reports, someone willing to open developer tools could report a
 * pass they did not earn. For one person diagnosing themselves on their own machine that is a
 * self-inflicted wound, not a threat, and the alternative — executing arbitrary Python on the
 * server — is ruled out.
 */

interface PresentedBase {
  readonly id: string
  readonly prompt: string
  /** Python to read, where the question involves reading code. */
  readonly code: string | null
}

export type PresentedItem =
  | (PresentedBase & { readonly kind: 'choice'; readonly options: readonly string[] })
  | (PresentedBase & { readonly kind: 'predict-output' })
  | (PresentedBase & { readonly kind: 'explain' })
  | (PresentedBase & {
      readonly kind: 'code'
      readonly starterCode: string
      readonly tests: readonly { readonly name: string; readonly code: string }[]
    })

export function presentItem(item: DiagnosticItem): PresentedItem {
  const base = { id: item.id, prompt: item.prompt, code: item.code ?? null }

  switch (item.kind) {
    case 'choice':
      return { ...base, kind: 'choice', options: item.options }
    case 'predict-output':
      return { ...base, kind: 'predict-output', code: item.code }
    case 'explain':
      return { ...base, kind: 'explain' }
    case 'code':
      return { ...base, kind: 'code', starterCode: item.starterCode, tests: item.tests }
  }
}
