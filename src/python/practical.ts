/**
 * Running a learner's code against an exercise's checks, in the browser.
 *
 * Execution is the worker's job and marking is the domain's. This file sits between them: it
 * builds the program (learner code first, then one guarded block per check — ADR-0019), runs it,
 * and turns what came back into the `PracticalOutcome` the server marks, plus what the learner
 * should see.
 *
 * Two outcomes never become a report at all. **Stopped** means the learner pressed Stop, and
 * **unavailable** means Python could not run: neither says anything about their code, so neither
 * is submitted.
 */

import { buildTestProgram, parseTestReport } from '@/domain/diagnostic/harness'
import type { PracticalOutcome } from '@/domain/exercises/mark'
import { learnerTraceback } from '@/domain/exercises/traceback'
import type { ExerciseTest } from '@/domain/exercises/types'

import type { OutputStream, RunResult } from './protocol'

/** The part of a runner this needs, so tests can substitute one without a worker. */
export interface CheckRunner {
  run(
    code: string,
    options?: { readonly timeoutMs?: number; readonly onOutput?: (stream: OutputStream, text: string) => void },
  ): Promise<RunResult>
}

export type CheckRun =
  | {
      readonly status: 'reported'
      readonly outcome: PracticalOutcome
      /** The learner's own output, with the harness's marker lines removed. */
      readonly output: string
      /** A traceback trimmed to the learner's frames, where their code raised. */
      readonly traceback: string | null
    }
  | { readonly status: 'stopped' }
  | { readonly status: 'unavailable'; readonly message: string }

export async function runChecks(
  runner: CheckRunner,
  code: string,
  checks: readonly ExerciseTest[],
  options: { readonly timeoutMs?: number } = {},
): Promise<CheckRun> {
  const result = await runner.run(buildTestProgram(code, checks), options)

  /*
   * Output beyond the runner's cap is discarded, and the checks' marker lines come last, so a
   * program that printed too much loses them — and a check with no marker reads as failed. Correct
   * code with leftover debugging prints would be marked wrong (M6 review finding F-06). Nothing about
   * the code can be read from such a run, so it is not submitted.
   */
  if (result.status !== 'unavailable' && result.status !== 'stopped' && result.truncated) {
    const report = parseTestReport(result.stdout, checks)
    if (report.incomplete) {
      return {
        status: 'unavailable',
        message:
          'Your code printed so much that the results of the checks could not be read. Remove the extra prints and submit again.',
      }
    }
  }

  switch (result.status) {
    case 'ok': {
      const report = parseTestReport(result.stdout, checks)
      return {
        status: 'reported',
        outcome: {
          kind: 'ran',
          checks: report.results.map((check) => ({
            outcome: check.passed ? 'pass' : 'fail',
            error: check.error,
          })),
          incomplete: report.incomplete,
          crash: null,
        },
        output: report.visibleOutput,
        traceback: null,
      }
    }
    case 'error': {
      // Raised at the top level of the learner's code, before a single check could run.
      const report = parseTestReport(result.stdout, checks)
      return {
        status: 'reported',
        outcome: {
          kind: 'ran',
          checks: report.results.map((check) => ({
            outcome: check.passed ? 'pass' : 'fail',
            error: check.error,
          })),
          incomplete: true,
          crash: { type: result.error.type.slice(0, 80), message: result.error.message.slice(0, 500) },
        },
        output: report.visibleOutput,
        traceback: learnerTraceback(result.error.traceback),
      }
    }
    case 'timeout':
      return {
        status: 'reported',
        outcome: { kind: 'timeout' },
        output: parseTestReport(result.stdout, checks).visibleOutput,
        traceback: null,
      }
    case 'stopped':
      return { status: 'stopped' }
    case 'unavailable':
      return { status: 'unavailable', message: result.message }
  }
}
