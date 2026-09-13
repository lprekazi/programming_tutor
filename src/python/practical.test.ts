import { describe, expect, it } from 'vitest'

import type { RunResult } from './protocol'
import { runChecks, type CheckRunner } from './practical'

const CHECKS = [
  { name: 'first', code: 'assert f() == 1' },
  { name: 'second', code: 'assert f() == 2' },
]

function runnerReturning(result: RunResult): CheckRunner & { readonly programs: string[] } {
  const programs: string[] = []
  return {
    programs,
    run: (code: string) => {
      programs.push(code)
      return Promise.resolve(result)
    },
  }
}

describe('running the checks', () => {
  it('runs the learner’s code first, then the checks', async () => {
    const runner = runnerReturning({ status: 'ok', stdout: '', stderr: '', truncated: false, durationMs: 1 })

    await runChecks(runner, 'def f():\n    return 1\n', CHECKS)

    const program = runner.programs[0] ?? ''
    expect(program.indexOf('def f()')).toBeLessThan(program.indexOf('assert f() == 1'))
  })

  it('reports each check and strips the harness lines from what the learner sees', async () => {
    const runner = runnerReturning({
      status: 'ok',
      stdout: 'hello\n<<<diagnostic-test:pass:0>>>\n<<<diagnostic-test:fail:1:AssertionError>>>\n',
      stderr: '',
      truncated: false,
      durationMs: 3,
    })

    const run = await runChecks(runner, 'code', CHECKS)

    expect(run).toEqual({
      status: 'reported',
      outcome: {
        kind: 'ran',
        checks: [
          { outcome: 'pass', error: null },
          { outcome: 'fail', error: 'AssertionError' },
        ],
        incomplete: false,
        crash: null,
      },
      output: 'hello',
      traceback: null,
    })
  })

  it('reports a crash, with every check failed and a traceback the learner can read', async () => {
    const runner = runnerReturning({
      status: 'error',
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 2,
      error: {
        type: 'NameError',
        message: "name 'x' is not defined",
        traceback:
          'Traceback (most recent call last):\n  File "/lib/python314.zip/_pyodide/_base.py", line 597, in eval_code_async\n    await CodeRunner(\n  File "main.py", line 1, in <module>\n    print(x)\n          ^\nNameError: name \'x\' is not defined\n',
      },
    })

    const run = await runChecks(runner, 'print(x)', CHECKS)

    if (run.status !== 'reported' || run.outcome.kind !== 'ran') throw new Error('expected a report')
    expect(run.outcome.crash).toEqual({ type: 'NameError', message: "name 'x' is not defined" })
    expect(run.outcome.incomplete).toBe(true)
    expect(run.outcome.checks.every((check) => check.outcome === 'fail')).toBe(true)
    expect(run.traceback).not.toContain('_pyodide')
    expect(run.traceback).toContain('File "main.py", line 1')
  })

  it('does not submit a run whose output was cut off before the checks reported', async () => {
    const runner = runnerReturning({
      status: 'ok',
      stdout: 'debug\n'.repeat(1000),
      stderr: '',
      truncated: true,
      durationMs: 5,
    })

    expect(await runChecks(runner, 'code', CHECKS)).toMatchObject({ status: 'unavailable' })
  })

  it('still marks a run that was cut off only after every check had reported', async () => {
    const runner = runnerReturning({
      status: 'ok',
      stdout: '<<<diagnostic-test:pass:0>>>\n<<<diagnostic-test:pass:1>>>\ntrailing',
      stderr: '',
      truncated: true,
      durationMs: 5,
    })

    expect(await runChecks(runner, 'code', CHECKS)).toMatchObject({ status: 'reported' })
  })

  it('reports a timeout as a timeout', async () => {
    const runner = runnerReturning({ status: 'timeout', stdout: 'tick\n', stderr: '', truncated: false, timeoutMs: 10 })

    const run = await runChecks(runner, 'while True: print("tick")', CHECKS)

    expect(run).toMatchObject({ status: 'reported', outcome: { kind: 'timeout' }, output: 'tick' })
  })

  it('does not turn a stopped run into anything that could be submitted', async () => {
    const runner = runnerReturning({ status: 'stopped', stdout: '', stderr: '', truncated: false })

    expect(await runChecks(runner, 'code', CHECKS)).toEqual({ status: 'stopped' })
  })

  it('does not turn Python being unavailable into a result about the code', async () => {
    const runner = runnerReturning({ status: 'unavailable', message: 'no worker' })

    expect(await runChecks(runner, 'code', CHECKS)).toEqual({ status: 'unavailable', message: 'no worker' })
  })
})
