/**
 * Checks a generated programming exercise before a learner ever sees it.
 *
 * A model that writes an exercise also writes a reference solution and a set of tests,
 * and it can get them wrong: tests that contradict the task, a solution that fails its
 * own tests, code that does not parse. Running the solution against the tests turns
 * that from something a learner discovers into something the system catches.
 *
 * This runs in the browser, in its own Pyodide worker, for the same reason learner code
 * does: no Python — written by a learner or by a model — executes on the server. Using a
 * separate worker from the learner's keeps generated code out of the namespace the
 * learner is working in.
 */

import { PythonRunner } from './runner'
import type { RunResult } from './protocol'

/** Verification is a background check, so it gets a tighter budget than a learner's run. */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 10_000

export interface VerificationTest {
  readonly name: string
  /** Python that raises when the behaviour under test is wrong. */
  readonly code: string
}

export interface ExerciseBundle {
  readonly referenceSolution: string
  readonly tests: readonly VerificationTest[]
}

export interface TestFailure {
  readonly test: string
  readonly error: string
}

export type VerificationVerdict =
  | { readonly status: 'passed' }
  | { readonly status: 'failed'; readonly failures: readonly TestFailure[]; readonly detail: string }
  /** The program did not finish in time; the worker was terminated. */
  | { readonly status: 'timeout'; readonly timeoutMs: number }
  /** Python could not be started at all, so nothing can be said about the exercise. */
  | { readonly status: 'unavailable'; readonly message: string }

/**
 * Prefix identifying the harness's own result line.
 *
 * A nonce is appended per run because the reference solution is model-written and
 * therefore untrusted: without one, a solution that simply printed the marker followed
 * by an empty failure list would be reported as passing.
 */
const MARKER_PREFIX = '__exercise_verification__'

function createMarker(): string {
  const bytes = new Uint8Array(9)
  crypto.getRandomValues(bytes)
  return `${MARKER_PREFIX}:${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}:`
}

/**
 * Builds the Python program that runs the tests against the reference solution.
 *
 * The tests are passed as JSON data and executed with `exec` rather than being pasted
 * into the source: a test body can contain any indentation, quoting or newlines, and
 * splicing that into a template is how such harnesses usually break. JSON string
 * escaping is a subset of Python's, so the encoded payload is a valid Python literal.
 */
export function buildVerificationProgram(bundle: ExerciseBundle, marker: string): string {
  const payload = JSON.stringify(JSON.stringify({ tests: bundle.tests }))

  return [
    'import json as __vjson',
    '__vfailures = []',
    '',
    '# --- reference solution ---',
    bundle.referenceSolution,
    '',
    '# --- tests ---',
    `__vspec = __vjson.loads(${payload})`,
    'for __vcase in __vspec["tests"]:',
    '    try:',
    '        exec(__vcase["code"], globals())',
    '    except BaseException as __verror:',
    '        __vfailures.append(',
    '            {"test": __vcase["name"], "error": f"{type(__verror).__name__}: {__verror}"}',
    '        )',
    '',
    `print(${JSON.stringify(marker)} + __vjson.dumps({"failures": __vfailures}))`,
    '',
  ].join('\n')
}

/** Reads the harness's result line out of the program's stdout. */
function readVerdictLine(stdout: string, marker: string): readonly TestFailure[] | null {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(marker))
  if (line === undefined) return null

  try {
    const parsed: unknown = JSON.parse(line.slice(marker.length))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { failures } = parsed as { failures?: unknown }
    if (!Array.isArray(failures)) return null

    return failures.map((entry: unknown) => {
      const failure = entry as { test?: unknown; error?: unknown }
      return {
        test: typeof failure.test === 'string' ? failure.test : 'unknown test',
        error: typeof failure.error === 'string' ? failure.error : 'unknown error',
      }
    })
  } catch {
    return null
  }
}

/** Turns a run of the harness program into a verdict about the exercise. */
export function interpretRun(result: RunResult, marker: string): VerificationVerdict {
  switch (result.status) {
    case 'ok': {
      const failures = readVerdictLine(result.stdout, marker)
      if (failures === null) {
        // The program finished without reporting: the harness never reached its final
        // line, so nothing can be concluded except that the exercise is not usable.
        return {
          status: 'failed',
          failures: [],
          detail: 'The verification program finished without reporting a result.',
        }
      }
      return failures.length === 0
        ? { status: 'passed' }
        : { status: 'failed', failures, detail: `${String(failures.length)} test(s) failed.` }
    }
    case 'error':
      // Usually a syntax error or an exception raised at import time in the solution.
      return {
        status: 'failed',
        failures: [],
        detail: `${result.error.type}: ${result.error.message}`,
      }
    case 'timeout':
      return { status: 'timeout', timeoutMs: result.timeoutMs }
    case 'stopped':
      return { status: 'unavailable', message: 'Verification was stopped before it finished.' }
    case 'unavailable':
      return { status: 'unavailable', message: result.message }
  }
}

export interface VerifyOptions {
  readonly timeoutMs?: number
  /** Overridden in tests; by default a dedicated worker is created and then discarded. */
  readonly createRunner?: () => PythonRunner
  /** Overridden in tests so the harness marker is predictable. */
  readonly marker?: string
}

/**
 * Runs a generated exercise's tests against its reference solution.
 *
 * The worker is created for this check and disposed afterwards, so a generated program
 * that hangs costs one terminated worker and nothing else.
 */
export async function verifyExercise(
  bundle: ExerciseBundle,
  options: VerifyOptions = {},
): Promise<VerificationVerdict> {
  const marker = options.marker ?? createMarker()
  const runner = options.createRunner?.() ?? new PythonRunner()

  try {
    const result = await runner.run(buildVerificationProgram(bundle, marker), {
      timeoutMs: options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
    })
    return interpretRun(result, marker)
  } finally {
    runner.dispose()
  }
}
