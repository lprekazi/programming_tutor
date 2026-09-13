import { describe, expect, it } from 'vitest'

import { buildTestProgram, parseTestReport } from './harness'
import { getDiagnosticItem } from './items'

/**
 * The generated program and the reading of its output.
 *
 * The interesting cases here are all failures: a program that stops partway, a test that never
 * reports, a learner whose own output happens to look like the harness's. Every one of them
 * has to end with "not demonstrated" rather than with a pass, because a pass is what gets
 * written into the learner's profile.
 */

const TESTS = [
  { name: 'adds', code: 'assert add(1, 2) == 3' },
  { name: 'handles zero', code: 'assert add(0, 0) == 0' },
]

describe('buildTestProgram', () => {
  it('puts the learner code first, unchanged', () => {
    const learner = 'def add(a, b):\n    return a + b'
    expect(buildTestProgram(learner, TESTS).startsWith(learner)).toBe(true)
  })

  it('guards every test separately, so one failure does not hide the rest', () => {
    const program = buildTestProgram('x = 1', TESTS)
    // One guard, inside a loop over the tests: each runs, and reports, on its own.
    expect(program).toContain('for _diagnostic_index, _diagnostic_code in enumerate(')
    expect(program).toContain('exec(_diagnostic_code, globals())')
  })

  it('carries each test as data, unchanged, so a string inside a test keeps its lines', () => {
    const multiline = 'assert longest_line("""ab\nabcd""") == "abcd"'
    const program = buildTestProgram('x = 1', [{ name: 'multi-line string', code: multiline }])

    // Not re-indented: the payload decodes to exactly the test that was written.
    const payloadLine = program.split('\n').find((line) => line.startsWith('for _diagnostic_index')) ?? ''
    const encoded = /loads\((".*")\)\):$/.exec(payloadLine)?.[1] ?? '""'
    expect(JSON.parse(JSON.parse(encoded) as string)).toEqual([multiline])
  })

  it('catches BaseException, so a recursion or memory failure is reported not swallowed', () => {
    expect(buildTestProgram('x = 1', TESTS)).toContain('except BaseException as ')
  })

  it('reports the exception class, because guarding the test hides the traceback', () => {
    expect(buildTestProgram('x = 1', TESTS)).toContain('__name__')
  })
})

describe('parseTestReport', () => {
  function run(lines: readonly string[]) {
    return parseTestReport(lines.join('\n'), TESTS)
  }

  it('reads a clean pass', () => {
    const report = run(['<<<diagnostic-test:pass:0>>>', '<<<diagnostic-test:pass:1>>>'])

    expect(report.allTestsPassed).toBe(true)
    expect(report.failedTests).toEqual([])
    expect(report.incomplete).toBe(false)
  })

  it('names the failing tests', () => {
    const report = run(['<<<diagnostic-test:fail:0:AssertionError>>>', '<<<diagnostic-test:pass:1>>>'])

    expect(report.allTestsPassed).toBe(false)
    expect(report.failedTests).toEqual(['adds'])
  })

  it('carries what went wrong, so a failing check can say more than "failed"', () => {
    const report = run([
      '<<<diagnostic-test:fail:0:ZeroDivisionError>>>',
      '<<<diagnostic-test:pass:1>>>',
    ])

    expect(report.results[0]?.error).toBe('ZeroDivisionError')
    // A check that passed has nothing to report, and neither does one that never ran.
    expect(report.results[1]?.error).toBeNull()
  })

  it('claims nothing about a check that never reported', () => {
    const report = run(['<<<diagnostic-test:pass:1>>>'])

    expect(report.results[0]).toEqual({ name: 'adds', passed: false, error: null })
  })

  it('treats a test that never reported as failed, not as passed', () => {
    // The shape of a program that stopped before the second block was reached.
    const report = run(['<<<diagnostic-test:pass:0>>>'])

    expect(report.results[1]?.passed).toBe(false)
    expect(report.allTestsPassed).toBe(false)
    expect(report.incomplete).toBe(true)
  })

  it('reports nothing at all as a complete failure', () => {
    const report = run(['Traceback (most recent call last):'])

    expect(report.allTestsPassed).toBe(false)
    expect(report.failedTests).toEqual(['adds', 'handles zero'])
  })

  it('never reports a pass when there are no tests to pass', () => {
    expect(parseTestReport('', []).allTestsPassed).toBe(false)
  })

  it('keeps the learner output and removes only the marker lines', () => {
    const report = run([
      'thinking...',
      '<<<diagnostic-test:pass:0>>>',
      'done',
      '<<<diagnostic-test:pass:1>>>',
    ])

    expect(report.visibleOutput).toBe('thinking...\ndone')
  })

  it('reads a marker that output without a newline ran into, and keeps that output', () => {
    // Captured from CPython for a correct function that prints with end=" " (M6 review F-01).
    const report = parseTestReport(
      '3 2 1 <<<diagnostic-test:pass:0>>>\n1 <<<diagnostic-test:pass:1>>>\n',
      TESTS,
    )

    expect(report.allTestsPassed).toBe(true)
    expect(report.incomplete).toBe(false)
    // The report trims only the very end of the output, as it always has.
    expect(report.visibleOutput).toBe('3 2 1 \n1')
  })

  it('ignores a near-miss line rather than reading it as a result', () => {
    const report = run(['<<<diagnostic-test:pass:0>>> and more', '<<<diagnostic-test:pass:1>>>'])

    expect(report.results[0]?.passed).toBe(false)
    expect(report.visibleOutput).toContain('and more')
  })
})

describe('the bank’s own practical item', () => {
  const item = getDiagnosticItem('code-count-evens')

  it('produces a program whose tests all report for a correct solution', () => {
    if (item.kind !== 'code') throw new Error('expected a code item')

    const solution = 'def count_evens(numbers):\n    return len([n for n in numbers if n % 2 == 0])'
    const program = buildTestProgram(solution, item.tests)

    // Not executed here — that needs a browser. What is checked is that every declared test
    // reaches the generated program exactly once, so none can be silently dropped.
    const payloadLine = program.split('\n').find((line) => line.startsWith('for _diagnostic_index')) ?? ''
    const encoded = /loads\((".*")\)\):$/.exec(payloadLine)?.[1] ?? '""'
    expect(JSON.parse(JSON.parse(encoded) as string)).toEqual(item.tests.map((test) => test.code))
  })
})
