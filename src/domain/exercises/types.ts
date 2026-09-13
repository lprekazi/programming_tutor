import type { ConceptId, MisconceptionId } from '../curriculum/types'

/**
 * Programming exercises: what one is, before any of it is stored, shown or run.
 *
 * An exercise is a small piece of Python the learner writes or repairs, checked by running named
 * checks against it in the browser. Everything that decides whether an attempt counts, and what
 * it counts as, is declared here as data — so it can be verified in a real interpreter before a
 * learner ever meets it, rather than trusted.
 */

/** Write something from a stub, or repair something that is already there and wrong. */
export type ExerciseKind = 'write' | 'fix'

/** One named check. Python that raises when the behaviour it describes is wrong. */
export interface ExerciseTest {
  /** What this check is about, in words the learner is shown. */
  readonly name: string
  readonly code: string
}

/** How one check came out, as the harness reported it. */
export type CheckOutcome = 'pass' | 'fail'

/**
 * A pattern of results specific enough to name a wrong idea.
 *
 * The brief is explicit that a misconception must not be inferred merely because code fails, a
 * check fails or a syntax error occurs — all of those have many causes. What *can* be specific is
 * a whole pattern: this check failing while those pass is what a particular wrong belief
 * produces, and a different wrong belief produces a different pattern.
 *
 * Each signal carries a **witness**: a program written as somebody holding that belief would
 * write it, which must produce exactly this pattern when run. The witness is what makes the
 * pattern a demonstrated fact about the checks rather than an author's hope, and it is run in a
 * real interpreter as part of the test suite.
 */
export interface MisconceptionSignal {
  readonly misconception: MisconceptionId
  /** One outcome per check, in the order the checks are declared. Must match exactly. */
  readonly pattern: readonly CheckOutcome[]
  /**
   * The construct the belief puts in the code, as a regular expression over the submission
   * (multi-line mode). **Required.**
   *
   * A pattern of results alone is not specific: the M6 review ran ordinary slips — a `return`
   * indented into the loop, `total += 1`, a hard-coded answer — through the checks and each
   * produced the same pattern as a misconception it had nothing to do with. What *is* specific is
   * the pattern together with the thing the belief makes somebody write: `range(n)` for thinking
   * range includes its end, an assignment to the total that ignores the total, a bare
   * `text.upper()` for thinking a string changes in place.
   */
  readonly codeShows: string
  /** A construct whose presence rules the belief out, where there is one. */
  readonly codeLacks?: string | undefined
  /** A program holding the belief. Must produce `pattern` and match `codeShows`. */
  readonly witness: string
  /**
   * Programs that do **not** hold the belief but plausibly fail in a similar way — including the
   * ones the review found. The signal must not fire on any of them, which is checked with the
   * real rule in a real interpreter.
   */
  readonly counterexamples: readonly string[]
}

export interface AuthoredExercise {
  readonly id: string
  readonly kind: ExerciseKind
  /** The concept this exercise is evidence about. */
  readonly conceptId: ConceptId
  /** What it assumes has already been met. Declared, and checked to be real concepts. */
  readonly prerequisites: readonly ConceptId[]
  /** On the ability scale. A declared prior, never revised from answers (ADR-0004). */
  readonly difficulty: number
  readonly title: string
  /** What to do, addressed to the learner. */
  readonly brief: string
  /** What the editor opens with. Must not already pass every check. */
  readonly starterCode: string
  /** Two to five checks. */
  readonly tests: readonly ExerciseTest[]
  /**
   * A solution that passes every check.
   *
   * For verification only. Never sent to the browser for an authored exercise — it has no need
   * to go there, since authored exercises are verified by the test suite rather than on demand.
   */
  readonly referenceSolution: string
  /** Patterns specific enough to name a wrong idea. Empty for most exercises, deliberately. */
  readonly signals: readonly MisconceptionSignal[]
  /**
   * Three hints, in order of how much they give away.
   *
   * 1 points at what to think about; 2 names the operation or the region; 3 describes the steps.
   * None of them contains the solution, which is asserted against the reference solution itself.
   */
  readonly hints: readonly [string, string, string]
}
