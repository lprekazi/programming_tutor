import type { MisconceptionId } from '../curriculum/types'
import type { CheckOutcome, ExerciseTest, MisconceptionSignal } from './types'

/**
 * Marking a practical attempt from what running it produced.
 *
 * Deterministic, and authoritative. When the checks can say whether the code works, they are
 * what decides it; a model reading the code afterwards may explain, diagnose and suggest, but
 * it is never asked whether passing code is correct and it cannot overturn a result.
 *
 * The execution itself happens in the browser (ADR-0019), so what arrives here is a *report* of
 * a run. This module decides what the report is worth.
 */

/** One check, as the harness reported it. */
export interface ReportedCheck {
  readonly outcome: CheckOutcome
  /** The exception class that failed it, where one was raised. */
  readonly error: string | null
}

/** What the browser says happened when the submitted code was run against the checks. */
export type PracticalOutcome =
  | {
      readonly kind: 'ran'
      /** One per check, in declared order. A check that never reported is a fail. */
      readonly checks: readonly ReportedCheck[]
      /** True when the program stopped before every check reported. */
      readonly incomplete: boolean
      /** An exception that escaped the learner's own code before the checks could run. */
      readonly crash: { readonly type: string; readonly message: string } | null
    }
  /**
   * The run did not finish inside its budget.
   *
   * Almost always a loop that never ends — but not provably so, and the difference matters:
   * this is recorded as unmarked rather than as a failure. See `markPractical`.
   */
  | { readonly kind: 'timeout' }

export type PracticalMarking =
  | {
      readonly kind: 'marked'
      /** Every check passed, and nothing crashed or went missing. */
      readonly passed: boolean
      readonly passedChecks: number
      readonly totalChecks: number
      /** Only from a signal whose whole pattern matched. Empty for almost every attempt. */
      readonly misconceptions: readonly MisconceptionId[]
      readonly state: 'passed' | 'failed' | 'crashed'
    }
  | { readonly kind: 'unmarked'; readonly reason: string }

/**
 * What an attempt was worth.
 *
 * **Pass or fail, not a fraction.** "2 of 3 checks" is shown to the learner because it is useful
 * to them, but the evidence is binary. The checks are not equal in weight — one might be the
 * ordinary case and another a boundary nobody should get wrong — and turning a count into a
 * graded outcome would let a trivially passing check stand in for a critical failing one. The
 * brief allowed pass/fail where partial credit could not be defended, and here it cannot.
 *
 * **A timeout is unmarked.** An endless loop is a real mistake, but a run can also fail to finish
 * for reasons that have nothing to do with the learner, and nothing in a timeout distinguishes
 * the two. Recording it as a failure would convert a possible infrastructure fault into evidence
 * about a person; recording nothing costs only a measurement.
 *
 * **A crash is a failure.** A syntax error or an exception at the top level of submitted code is
 * what the learner submitted, and it does not work. It is not treated as a diagnosis of anything.
 */
export function markPractical(input: {
  readonly outcome: PracticalOutcome
  readonly tests: readonly ExerciseTest[]
  readonly signals: readonly MisconceptionSignal[]
  readonly code: string
}): PracticalMarking {
  const { outcome, tests } = input

  if (outcome.kind === 'timeout') {
    return {
      kind: 'unmarked',
      reason:
        'Your code did not finish in time, so nothing has been recorded for this submission. If it has a loop, check that the loop can end.',
    }
  }

  if (outcome.checks.length !== tests.length || tests.length === 0) {
    // A report that does not line up with the exercise was not produced by running it. Nothing
    // about the learner can be read from it.
    return {
      kind: 'unmarked',
      reason: 'The result of running your code could not be read, so nothing has been recorded.',
    }
  }

  const passedChecks = outcome.checks.filter((check) => check.outcome === 'pass').length
  const crashed = outcome.crash !== null
  const passed = !crashed && !outcome.incomplete && passedChecks === tests.length

  return {
    kind: 'marked',
    passed,
    passedChecks,
    totalChecks: tests.length,
    misconceptions: passed ? [] : matchingSignals(input),
    state: passed ? 'passed' : crashed ? 'crashed' : 'failed',
  }
}

/**
 * The misconceptions whose whole pattern this attempt produced.
 *
 * Deliberately narrow. Every condition below removes a way for a pattern to be produced by
 * something other than the belief it names:
 *
 *   - the program completed and every check reported, so no check failed merely by never running;
 *   - every failure was an `AssertionError`, so the code *ran* each check and got a wrong answer,
 *     rather than raising something unrelated;
 *   - the pattern matches exactly, check for check;
 *   - the code contains the construct the belief puts there, and nothing that rules it out.
 *
 * A single matched signal is an observation of one attempt, recorded as such. It is not a label.
 */
function matchingSignals(input: {
  readonly outcome: PracticalOutcome
  readonly signals: readonly MisconceptionSignal[]
  readonly code: string
}): readonly MisconceptionId[] {
  const { outcome } = input
  if (outcome.kind !== 'ran' || outcome.crash !== null || outcome.incomplete) return []

  const failuresAreAssertions = outcome.checks.every(
    (check) => check.outcome === 'pass' || check.error === 'AssertionError',
  )
  if (!failuresAreAssertions) return []

  const matched = input.signals.filter(
    (signal) =>
      signal.pattern.length === outcome.checks.length &&
      signal.pattern.every((expected, index) => outcome.checks[index]?.outcome === expected) &&
      codeHolds(signal, input.code),
  )

  return [...new Set(matched.map((signal) => signal.misconception))]
}

/**
 * Whether the code contains what the belief puts there, and nothing that rules it out.
 *
 * The expressions are authored data, compiled here. A signal whose expression does not compile
 * matches nothing — never everything.
 */
export function codeHolds(signal: MisconceptionSignal, code: string): boolean {
  try {
    if (!new RegExp(signal.codeShows, 'm').test(code)) return false
    return signal.codeLacks === undefined || !new RegExp(signal.codeLacks, 'm').test(code)
  } catch {
    return false
  }
}

/** Whitespace and comment lines removed, so a reformatted starter still reads as unchanged. */
function essence(code: string): string {
  return code
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('')
    .replace(/\s+/g, '')
}

/**
 * Whether a submission is just the starter code, perhaps re-spaced or with a comment added.
 *
 * Submitting it is not an attempt. For a repair exercise the starter is wrong on purpose — in five
 * authored exercises it produces a misconception signal's exact pattern — so pressing Submit on it
 * recorded a counted failure *and* a misconception about code the learner never wrote (M6 review
 * finding F-02). It is refused before anything is recorded.
 */
export function isUnchangedStarter(code: string, starterCode: string): boolean {
  return essence(code) === essence(starterCode)
}

/** The line a learner reads about their checks. Counts, not percentages. */
export function describeChecks(marking: PracticalMarking): string {
  if (marking.kind === 'unmarked') return marking.reason

  if (marking.state === 'crashed') {
    return 'Your code stopped with an error before the checks could run, so none of them passed.'
  }
  if (marking.passed) {
    return marking.totalChecks === 1 ? 'The check passes.' : `All ${String(marking.totalChecks)} checks pass.`
  }
  return `${String(marking.passedChecks)} of ${String(marking.totalChecks)} checks pass.`
}
