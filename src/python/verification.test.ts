import { describe, expect, it } from 'vitest'

import type { RunResult } from './protocol'
import { buildVerificationProgram, interpretRun, type ExerciseBundle } from './verification'

const MARKER = '__exercise_verification__:abc123:'

const BUNDLE: ExerciseBundle = {
  referenceSolution: 'def double(n):\n    return n * 2\n',
  tests: [
    { name: 'doubles a positive number', code: 'assert double(3) == 6' },
    { name: 'doubles zero', code: 'assert double(0) == 0' },
  ],
}

function ok(stdout: string): RunResult {
  return { status: 'ok', stdout, stderr: '', truncated: false, durationMs: 5 }
}

describe('buildVerificationProgram', () => {
  it('includes the reference solution and encodes the tests as data', () => {
    const program = buildVerificationProgram(BUNDLE, MARKER)

    expect(program).toContain('def double(n):')
    expect(program).toContain('doubles a positive number')
    // Tests are executed from a parsed payload, never spliced into the source.
    expect(program).toContain('exec(__vcase["code"], globals())')
  })

  it('survives test code containing quotes, backslashes and newlines', () => {
    const awkward: ExerciseBundle = {
      referenceSolution: 'value = "ok"',
      tests: [
        {
          name: 'quotes "and" \\backslashes\\',
          code: 'text = "a \\"quoted\\" string"\nif text is None:\n    raise AssertionError("no")\n',
        },
      ],
    }

    const program = buildVerificationProgram(awkward, MARKER)

    // The payload must be a single-line Python string literal, so an embedded newline
    // has to have been escaped rather than breaking the statement across lines.
    const payloadLine = program.split('\n').find((line) => line.startsWith('__vspec = '))
    expect(payloadLine).toBeDefined()
    expect(payloadLine).toContain('\\n')
    expect(payloadLine).not.toContain('\n')
  })
})

describe('interpretRun', () => {
  it('passes when the harness reports no failures', () => {
    const verdict = interpretRun(ok(`${MARKER}{"failures": []}\n`), MARKER)
    expect(verdict).toEqual({ status: 'passed' })
  })

  it('fails with the reported test failures', () => {
    const stdout = `${MARKER}{"failures": [{"test": "doubles zero", "error": "AssertionError: "}]}\n`

    const verdict = interpretRun(ok(stdout), MARKER)

    expect(verdict.status).toBe('failed')
    if (verdict.status !== 'failed') throw new Error('expected failure')
    expect(verdict.failures).toEqual([{ test: 'doubles zero', error: 'AssertionError: ' }])
  })

  it('fails when the solution raises before the harness reports', () => {
    const verdict = interpretRun(
      {
        status: 'error',
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 2,
        error: { type: 'SyntaxError', message: 'invalid syntax', traceback: '...' },
      },
      MARKER,
    )

    expect(verdict.status).toBe('failed')
    if (verdict.status !== 'failed') throw new Error('expected failure')
    expect(verdict.detail).toContain('SyntaxError')
  })

  it('fails when the program finishes without reporting at all', () => {
    const verdict = interpretRun(ok('some unrelated output\n'), MARKER)

    expect(verdict.status).toBe('failed')
    if (verdict.status !== 'failed') throw new Error('expected failure')
    expect(verdict.detail).toContain('without reporting')
  })

  it('ignores a marker the generated code printed itself', () => {
    // The reference solution is model-written and untrusted. A different marker must not
    // be accepted, which is why the real marker carries a per-run nonce.
    const forged = '__exercise_verification__:0000000000:{"failures": []}\n'

    const verdict = interpretRun(ok(forged), MARKER)

    expect(verdict.status).toBe('failed')
  })

  it('fails rather than passing when the reported payload is malformed', () => {
    expect(interpretRun(ok(`${MARKER}not json\n`), MARKER).status).toBe('failed')
    expect(interpretRun(ok(`${MARKER}{"failures": "nope"}\n`), MARKER).status).toBe('failed')
    expect(interpretRun(ok(`${MARKER}null\n`), MARKER).status).toBe('failed')
  })

  it('reports a timeout distinctly, because it says nothing about correctness', () => {
    const verdict = interpretRun(
      { status: 'timeout', stdout: '', stderr: '', truncated: false, timeoutMs: 10_000 },
      MARKER,
    )

    expect(verdict).toEqual({ status: 'timeout', timeoutMs: 10_000 })
  })

  it('reports an unavailable interpreter separately from a failing exercise', () => {
    const verdict = interpretRun({ status: 'unavailable', message: 'no worker' }, MARKER)

    expect(verdict).toEqual({ status: 'unavailable', message: 'no worker' })
  })
})
