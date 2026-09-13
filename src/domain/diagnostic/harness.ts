/**
 * Running a learner's solution against an item's tests.
 *
 * Two pure functions, because the interesting part is not the execution — that is the Python
 * worker's job — but the program that gets executed and the reading of what comes back. Both
 * are string handling, both have edge cases that matter, and both are worth testing without a
 * browser anywhere near them.
 *
 * The shape of the generated program:
 *
 *   1. the learner's code, exactly as they wrote it and first, so a syntax error in it reads
 *      as a syntax error in their code rather than in machinery they never saw;
 *   2. a loop over the tests, each executed separately inside its own guard, each printing a
 *      single marker line saying what happened.
 *
 * The tests are passed as a JSON payload and run with `exec`, exactly as exercise verification
 * runs them (`src/python/verification.ts`). They used to be pasted into the program indented one
 * level — and indenting every line of a test also indents the lines *inside* a triple-quoted
 * string in it, which changes the string. An exercise could then pass verification and mark its
 * own reference solution as failing (M6 review finding F-07). One way of running a test, for
 * both, removes the possibility.
 *
 * A test that raises anything at all counts as failed — including a bare `assert`, which is
 * the usual case. `BaseException` rather than `Exception` so that a test provoking, say, a
 * `RecursionError` is reported rather than killing the run silently.
 *
 * The marker for a failure carries the exception's class name, because a guarded test hides
 * the traceback the learner would otherwise have seen. "Three checks failed" and "three checks
 * failed with ZeroDivisionError" are very different amounts of help, and the second costs one
 * extra word on a line that is being printed anyway.
 */

/**
 * Prefix for the harness's own output lines.
 *
 * Distinctive enough that learner output will not collide with it by accident. A learner who
 * prints it deliberately can miscount their own diagnostic, which is a strange thing to want
 * and harms nobody else.
 */
const MARKER = '<<<diagnostic-test'

export interface HarnessTest {
  readonly name: string
  readonly code: string
}

export function buildTestProgram(learnerCode: string, tests: readonly HarnessTest[]): string {
  // JSON string escaping is a subset of Python's, so the doubly-encoded payload is a valid Python
  // string literal whatever quotes, backslashes or newlines a test contains.
  const payload = JSON.stringify(JSON.stringify(tests.map((test) => test.code)))

  return [
    learnerCode,
    '',
    'import json as _diagnostic_json',
    `for _diagnostic_index, _diagnostic_code in enumerate(_diagnostic_json.loads(${payload})):`,
    '    try:',
    '        exec(_diagnostic_code, globals())',
    // The exception's class name is concatenated in Python rather than interpolated here, so
    // nothing about the exception itself can change the shape of the marker line.
    '    except BaseException as _diagnostic_failure:',
    `        print(${JSON.stringify(`${MARKER}:fail:`)} + str(_diagnostic_index) + ":" + type(_diagnostic_failure).__name__ + ">>>")`,
    '    else:',
    `        print(${JSON.stringify(`${MARKER}:pass:`)} + str(_diagnostic_index) + ">>>")`,
    '',
  ].join('\n')
}

export interface TestResult {
  readonly name: string
  readonly passed: boolean
  /**
   * The exception class that failed the check, where one was raised. Null when the check
   * passed, and null when it never reported at all — nothing was observed to name.
   */
  readonly error: string | null
}

export interface TestReport {
  /** One entry per test, in the order the tests were declared. */
  readonly results: readonly TestResult[]
  /** True only when every test declared a pass. */
  readonly allTestsPassed: boolean
  readonly failedTests: readonly string[]
  /** True when the program stopped before every test reported. */
  readonly incomplete: boolean
  /** The learner's own output, with the harness's marker lines removed. */
  readonly visibleOutput: string
}

/**
 * A marker at the **end** of a line, with anything before it.
 *
 * Pyodide passes output on only when it sees a newline, so a learner who prints with `end=" "`
 * leaves text that runs straight into the next marker: `3 2 1 <<<diagnostic-test:pass:0>>>`. The
 * pattern used to require the marker to be the whole line, so that check read as never reported
 * — a failure — and correct code was marked wrong (M6 review finding F-01). The text before the
 * marker is the learner's own output and is kept as such.
 *
 * Still anchored at the end, so a marker followed by more text is not read as a result.
 */
const MARKER_PATTERN = /^(.*?)<<<diagnostic-test:(pass|fail):(\d+)(?::([A-Za-z_][A-Za-z0-9_]*))?>>>$/

/**
 * Reads what the run produced.
 *
 * A test with no marker is **not** a pass. The program may have stopped partway — an exception
 * in the learner's code, a timeout, the worker terminated — and in every one of those cases the
 * test did not demonstrate anything. Missing means failed.
 */
export function parseTestReport(stdout: string, tests: readonly HarnessTest[]): TestReport {
  const seen = new Map<number, { passed: boolean; error: string | null }>()
  const visible: string[] = []

  for (const line of stdout.split('\n')) {
    const match = MARKER_PATTERN.exec(line.trimEnd())
    if (match === null) {
      visible.push(line)
      continue
    }
    const before = match[1] ?? ''
    if (before.length > 0) visible.push(before)
    seen.set(Number(match[3]), { passed: match[2] === 'pass', error: match[4] ?? null })
  }

  const results: readonly TestResult[] = tests.map((test, index) => {
    const reported = seen.get(index)
    return {
      name: test.name,
      passed: reported?.passed === true,
      error: reported?.error ?? null,
    }
  })

  return {
    results,
    allTestsPassed: results.length > 0 && results.every((result) => result.passed),
    failedTests: results.filter((result) => !result.passed).map((result) => result.name),
    incomplete: seen.size < tests.length,
    visibleOutput: visible.join('\n').trimEnd(),
  }
}
