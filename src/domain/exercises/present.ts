import type { ConceptId } from '../curriculum/types'
import type { ExerciseKind, ExerciseTest } from './types'

/**
 * What the browser is given about an exercise.
 *
 * The same rule M3 and M5 follow — an assessment whose answer key travels with it is not an
 * assessment — with one unavoidable difference, stated rather than glossed. The checks have to
 * run against the learner's code, and Python runs only in the browser, so the **check code**
 * goes to the browser. It is not rendered: the learner sees each check's name. Someone with
 * developer tools can read it, exactly as ADR-0019 records for the diagnostic's practical item,
 * and the checks are no more than the behaviour the brief already describes in prose.
 *
 * The **reference solution does not go**. An authored exercise was verified by the test suite
 * and has no need of it in the browser; a generated one needs it once, for verification, through
 * a separate path that never reaches the learner's editor (ADR-0006). Neither do the signal
 * patterns or their witnesses, which are how the marking reads a result and are nothing the
 * learner needs.
 *
 * Asserted over the serialised result in `view.test.ts`, so a field added later cannot leak
 * by being forgotten.
 */

export interface StoredExercise {
  readonly id: string
  readonly conceptId: ConceptId
  readonly kind: ExerciseKind
  readonly origin: 'authored' | 'generated'
  readonly title: string
  readonly brief: string
  readonly starterCode: string
  readonly tests: readonly ExerciseTest[]
  readonly referenceSolution: string
  readonly selectionGround: string
}

export interface PresentedExercise {
  readonly id: string
  readonly conceptId: ConceptId
  readonly kind: ExerciseKind
  readonly origin: 'authored' | 'generated'
  readonly title: string
  readonly brief: string
  readonly starterCode: string
  /** Named checks, with the code needed to run them. The code is never rendered. */
  readonly checks: readonly ExerciseTest[]
  /** Why this exercise, in the selector's own words. */
  readonly ground: string
}

export function presentExercise(stored: StoredExercise): PresentedExercise {
  return {
    id: stored.id,
    conceptId: stored.conceptId,
    kind: stored.kind,
    origin: stored.origin,
    title: stored.title,
    brief: stored.brief,
    starterCode: stored.starterCode,
    checks: stored.tests.map((test) => ({ name: test.name, code: test.code })),
    ground: stored.selectionGround,
  }
}
