import { describe, expect, it } from 'vitest'

import { getAuthoredExercise } from './bank'
import { describeChecks, isUnchangedStarter, markPractical, type PracticalOutcome, type ReportedCheck } from './mark'
import { revealsReference } from './leak'

/**
 * Marking a practical attempt, and the narrow conditions under which it names a wrong idea.
 *
 * The rule the brief set, and the one most likely to be broken by accident: a misconception is
 * never inferred merely because code fails, a check fails or an error occurs. Most of these tests
 * are about attempts that fail *without* producing a diagnosis.
 */

function exercise(id: string) {
  const found = getAuthoredExercise(id)
  if (found === null) throw new Error(`no exercise ${id}`)
  return found
}

function ran(checks: readonly ReportedCheck[], extra: Partial<Extract<PracticalOutcome, { kind: 'ran' }>> = {}): PracticalOutcome {
  return { kind: 'ran', checks, incomplete: false, crash: null, ...extra }
}

const pass: ReportedCheck = { outcome: 'pass', error: null }
const assertFail: ReportedCheck = { outcome: 'fail', error: 'AssertionError' }

function mark(id: string, outcome: PracticalOutcome, code = '') {
  const { tests, signals } = exercise(id)
  return markPractical({ outcome, tests, signals, code })
}

describe('whether it passed', () => {
  it('passes only when every check passed and nothing crashed', () => {
    const marking = mark('x-loop-sum-to', ran([pass, pass, pass]))

    expect(marking).toMatchObject({ kind: 'marked', passed: true, state: 'passed', passedChecks: 3 })
    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([])
  })

  it('fails when any check failed, and counts the ones that passed', () => {
    const marking = mark('x-while-countdown', ran([assertFail, assertFail, pass]))

    expect(marking).toMatchObject({ kind: 'marked', passed: false, passedChecks: 1, totalChecks: 3 })
  })

  it('fails a crash, and says it crashed rather than that the checks failed', () => {
    const marking = mark(
      'x-scope-greeting',
      ran([{ outcome: 'fail', error: null }, { outcome: 'fail', error: null }], {
        incomplete: true,
        crash: { type: 'NameError', message: "name 'greeting' is not defined" },
      }),
    )

    expect(marking).toMatchObject({ kind: 'marked', passed: false, state: 'crashed' })
    expect(describeChecks(marking)).toContain('stopped with an error')
  })

  it('never passes an attempt whose checks did not all report', () => {
    // Every reported check passed, but one never ran. Missing is not passing.
    const marking = mark('x-loop-sum-to', ran([pass, pass, pass], { incomplete: true }))

    expect(marking.kind === 'marked' && marking.passed).toBe(false)
  })

  it('does not treat a timeout as a failure, because it cannot tell why', () => {
    const marking = mark('x-while-countdown', { kind: 'timeout' })

    expect(marking.kind).toBe('unmarked')
  })

  it('does not mark a report that does not line up with the exercise', () => {
    // Two results for a three-check exercise was not produced by running it.
    expect(mark('x-loop-sum-to', ran([pass, pass])).kind).toBe('unmarked')
  })
})

describe('naming a wrong idea', () => {
  const sumWith = (loopLine: string, bodyLine: string) =>
    `def total_to(n):\n    total = 0\n    ${loopLine}\n        ${bodyLine}\n    return total\n`

  it('names one when the whole pattern matches and the code holds the belief', () => {
    // range(n) instead of range(1, n + 1): short by n, and total_to(1) comes out as 0.
    const marking = mark(
      'x-loop-sum-to',
      ran([assertFail, assertFail, pass]),
      sumWith('for number in range(n):', 'total = total + number'),
    )

    expect(marking.kind === 'marked' && marking.misconceptions).toEqual(['range-endpoint-inclusive'])
  })

  it('tells two different wrong ideas apart by their patterns', () => {
    const overwritten = mark(
      'x-loop-sum-to',
      ran([assertFail, pass, pass]),
      sumWith('for number in range(1, n + 1):', 'total = number'),
    )

    expect(overwritten.kind === 'marked' && overwritten.misconceptions).toEqual([
      'accumulator-overwritten',
    ])
  })

  /*
   * M6 review finding F-03. The results alone matched, on code that holds neither belief: a return
   * indented into the loop, and a sum that includes n but is never stored. Both used to be recorded
   * as misconceptions the learner did not have.
   */
  it('names nothing when the results match but the code does not hold the belief', () => {
    const returnsEarly = mark(
      'x-loop-sum-to',
      ran([assertFail, pass, pass]),
      'def total_to(n):\n    total = 0\n    for number in range(1, n + 1):\n        total = total + number\n        return total\n    return total\n',
    )
    const neverStored = mark(
      'x-loop-sum-to',
      ran([assertFail, assertFail, pass]),
      sumWith('for number in range(1, n + 1):', 'total + number'),
    )

    expect(returnsEarly.kind === 'marked' && returnsEarly.misconceptions).toEqual([])
    expect(neverStored.kind === 'marked' && neverStored.misconceptions).toEqual([])
  })

  it('names nothing for a failure that matches no pattern', () => {
    // Failing everything is a failure, not a diagnosis.
    const marking = mark('x-loop-sum-to', ran([assertFail, assertFail, assertFail]))

    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([])
  })

  it('names nothing when a failure was an exception rather than a wrong answer', () => {
    // The right shape of pattern, but the code raised TypeError rather than getting an answer
    // wrong. That is not what the belief produces.
    const marking = mark('x-loop-sum-to', ran([{ outcome: 'fail', error: 'TypeError' }, assertFail, pass]))

    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([])
  })

  it('names nothing when the program crashed, whatever the checks say', () => {
    const marking = mark(
      'x-loop-sum-to',
      ran([assertFail, assertFail, pass], { crash: { type: 'SyntaxError', message: 'invalid syntax' } }),
    )

    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([])
  })

  it('names nothing when not every check reported', () => {
    const marking = mark('x-loop-sum-to', ran([assertFail, assertFail, pass], { incomplete: true }))

    expect(marking.kind === 'marked' && marking.misconceptions).toEqual([])
  })

  it('requires the code to contain what the belief would put there, where a signal says so', () => {
    const allFail = ran([assertFail, assertFail, assertFail, assertFail])

    // Printing instead of returning, and returning nothing at all, fail the same checks. The
    // starter's own print at the bottom of the file is not a print inside the function.
    const printing = mark('x-return-not-print', allFail, 'def larger(a, b):\n    print(a)\n')
    const silent = mark('x-return-not-print', allFail, 'def larger(a, b):\n    a > b\n\nprint(larger(3, 7))\n')

    expect(printing.kind === 'marked' && printing.misconceptions).toEqual(['print-instead-of-return'])
    expect(silent.kind === 'marked' && silent.misconceptions).toEqual([])
  })

  it('never names a wrong idea for a passing attempt', () => {
    expect(mark('x-list-with-extra', ran([pass, pass, pass]))).toMatchObject({ misconceptions: [] })
  })
})

describe('the starter code, submitted unchanged', () => {
  /*
   * M6 review finding F-02: pressing Submit on a repair exercise's starter recorded a counted
   * failure and, for five exercises, a misconception about code the learner never wrote.
   */
  it('is recognised however it has been re-spaced or commented', () => {
    const starter = exercise('x-average-bug').starterCode

    expect(isUnchangedStarter(starter, starter)).toBe(true)
    expect(isUnchangedStarter(`# my attempt\n${starter.replace(/    /g, '  ')}\n\n`, starter)).toBe(true)
  })

  it('is not confused with a real change', () => {
    const starter = exercise('x-average-bug').starterCode

    expect(isUnchangedStarter(starter.replace('total = number', 'total = total + number'), starter)).toBe(false)
  })
})

describe('what the learner is told about the checks', () => {
  it('counts rather than scoring', () => {
    const marking = mark('x-while-countdown', ran([assertFail, pass, pass]))

    expect(describeChecks(marking)).toBe('2 of 3 checks pass.')
    expect(describeChecks(marking)).not.toMatch(/%/)
  })

  it('says all of them passed when they did', () => {
    expect(describeChecks(mark('x-while-countdown', ran([pass, pass, pass])))).toBe('All 3 checks pass.')
  })
})

describe('the leak check', () => {
  const reference = exercise('x-loop-sum-to').referenceSolution

  it('catches the solution with its definition line removed', () => {
    const body = reference.split('\n').slice(1).join('\n')

    expect(revealsReference(body, reference)).toBe(true)
  })

  it('catches the solution run together into a sentence', () => {
    expect(
      revealsReference(
        'Try this: total = 0 then for number in range(1, n + 1): and total = total + number, then return total',
        reference,
      ),
    ).toBe(true)
  })

  it('allows a single illustrative fragment', () => {
    expect(revealsReference('The new total is total = total + number.', reference)).toBe(false)
  })

  it('is not fooled by spacing, or by leaving off the return', () => {
    // The review's bypasses (F-09).
    expect(revealsReference('list(range(0, n+1, 2))', exercise('x-range-evens').referenceSolution)).toBe(true)
    expect(revealsReference('text.upper()+"!"', exercise('x-string-shout').referenceSolution)).toBe(true)
  })

  it('does not treat the name of a variable in prose as a leak', () => {
    expect(revealsReference('Think about what total should hold at the end.', reference)).toBe(false)
  })

  it('treats a one-line solution pasted whole as a leak', () => {
    const oneLine = exercise('x-range-evens').referenceSolution

    expect(revealsReference('Use return list(range(0, n + 1, 2))', oneLine)).toBe(true)
  })
})
