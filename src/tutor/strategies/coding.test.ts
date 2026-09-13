import { describe, expect, it } from 'vitest'

import { UNKNOWN_LEARNER } from '../blocks/learner'
import { renderPrompt } from '@/llm/provider'
import { codeFeedbackStrategy, codeTaskGenerateStrategy, hintStrategy, type CodeFeedback, type CodeTask } from './coding'
import { strategyContext } from './shared'

/**
 * The M6 contracts for the three coding strategies.
 *
 * Each invariant below exists because an exercise a model wrote, a hint it gave or notes it made
 * would otherwise reach a learner in a state the brief rules out: a task on the wrong concept, a
 * check that cannot fail, an import Pyodide does not have, the solution handed over, or notes that
 * contradict what the checks decided.
 */

const REFERENCE =
  'def largest(numbers):\n    best = numbers[0]\n    for number in numbers:\n        if number > best:\n            best = number\n    return best\n'

function task(overrides: Partial<CodeTask> = {}): CodeTask {
  return {
    conceptId: 'for-loops-and-range',
    title: 'Largest in a list',
    brief: 'Write largest(numbers) so it returns the biggest number in the list, without using max().',
    starterCode: 'def largest(numbers):\n    """Return the biggest number."""\n    pass\n',
    referenceSolution: REFERENCE,
    tests: [
      { name: 'finds the biggest', code: 'assert largest([3, 9, 2]) == 9' },
      { name: 'handles negatives', code: 'assert largest([-4, -2]) == -2' },
    ],
    declaredDifficulty: 'typical',
    ...overrides,
  }
}

function taskProblems(output: CodeTask): string[] {
  return codeTaskGenerateStrategy
    .checkInvariants(output, { learner: UNKNOWN_LEARNER, conceptId: 'for-loops-and-range', avoid: [] }, strategyContext())
    .map((problem) => problem.code)
}

describe('code.task.generate v2', () => {
  it('accepts a sound exercise', () => {
    expect(taskProblems(task())).toEqual([])
  })

  it('refuses an exercise on a concept other than the one requested', () => {
    expect(taskProblems(task({ conceptId: 'dictionaries' }))).toContain('concept-mismatch')
  })

  it('refuses a check that cannot fail', () => {
    expect(
      taskProblems(task({ tests: [{ name: 'runs', code: 'largest([1, 2])' }, { name: 'ok', code: 'assert True' }] })),
    ).toContain('test-cannot-fail')
  })

  it('refuses an import Pyodide cannot be relied on for', () => {
    expect(taskProblems(task({ referenceSolution: `import numpy\n${REFERENCE}` }))).toContain('imports-outside-allowlist')
    expect(taskProblems(task({ referenceSolution: `import math\n${REFERENCE}` }))).not.toContain('imports-outside-allowlist')
  })

  it('refuses a brief that gives the solution away', () => {
    expect(
      taskProblems(task({ brief: `Hint: best = numbers[0] and for number in numbers: if number > best: best = number then return best` })),
    ).toContain('reveals-solution')
  })

  it('refuses starter code that already contains the solution', () => {
    expect(taskProblems(task({ starterCode: REFERENCE }))).toContain('reveals-solution')
  })

  it('tells the regeneration why the last one was discarded, in its own words', () => {
    const blocks = codeTaskGenerateStrategy.buildBlocks({
      learner: UNKNOWN_LEARNER,
      conceptId: 'for-loops-and-range',
      avoid: [],
      previousProblem: 'its reference solution did not pass its own tests.',
    })

    expect(renderPrompt(blocks)).toContain('discarded because its reference solution did not pass its own tests.')
  })
})

describe('code.feedback v2', () => {
  function feedback(overrides: Partial<CodeFeedback> = {}): CodeFeedback {
    return {
      summary: 'You are close.',
      observations: [],
      nextStep: 'Trace the loop for a list of two numbers.',
      misconceptions: [],
      ...overrides,
    }
  }

  function problems(output: CodeFeedback, result: 'passed' | 'failed' | 'crashed') {
    return codeFeedbackStrategy
      .checkInvariants(
        output,
        {
          learner: UNKNOWN_LEARNER,
          conceptId: 'for-loops-and-range',
          brief: 'Largest in a list.',
          learnerCode: 'def largest(numbers):\n    return numbers[0]\n',
          executionOutput: '',
          failedTests: [],
          result,
          referenceSolution: REFERENCE,
        },
        strategyContext(),
      )
      .map((problem) => problem.code)
  }

  it('states the result to the model as settled', () => {
    const prompt = renderPrompt(
      codeFeedbackStrategy.buildBlocks({
        learner: UNKNOWN_LEARNER,
        conceptId: 'for-loops-and-range',
        brief: 'b',
        learnerCode: 'c',
        executionOutput: '',
        failedTests: ['finds the biggest'],
        result: 'failed',
        referenceSolution: REFERENCE,
      }),
    )

    expect(prompt).toContain('RESULT: failed')
    // The reference solution is for the leak check only. Showing it to the model invites a copy.
    expect(prompt).not.toContain('best = numbers[0]')
  })

  it('refuses notes calling passing code wrong', () => {
    expect(problems(feedback({ summary: 'This does not work for negative numbers.' }), 'passed')).toContain('contradicts-result')
  })

  it('refuses a misconception diagnosed in passing code', () => {
    expect(problems(feedback({ misconceptions: ['range-endpoint-inclusive'] }), 'passed')).toContain(
      'misconception-on-passing-code',
    )
  })

  it('refuses notes saying failing code works', () => {
    expect(problems(feedback({ summary: 'Well done, this works correctly.' }), 'failed')).toContain('contradicts-result')
    expect(problems(feedback({ summary: 'All the checks pass.' }), 'crashed')).toContain('contradicts-result')
  })

  it('catches the review’s wordings, in the next step as well as the summary', () => {
    // M6 review finding F-10.
    expect(problems(feedback({ summary: 'It returns the wrong total.' }), 'passed')).toContain('contradicts-result')
    expect(problems(feedback({ summary: 'This has a bug.' }), 'passed')).toContain('contradicts-result')
    expect(problems(feedback({ nextStep: 'Your code is wrong: rewrite the loop.' }), 'passed')).toContain('contradicts-result')
    expect(problems(feedback({ summary: 'This works now — nicely done.' }), 'failed')).toContain('contradicts-result')
    expect(problems(feedback({ nextStep: 'Your solution is correct.' }), 'failed')).toContain('contradicts-result')
  })

  it('allows suggestions on passing code, and honest notes on failing code', () => {
    expect(problems(feedback({ summary: 'Every check passes. A for loop over the list directly would read more simply.' }), 'passed')).toEqual([])
    expect(problems(feedback({ summary: 'This is the case that trips most people up: an empty list.' }), 'failed')).toEqual([])
  })

  it('refuses notes that hand over the reference solution', () => {
    expect(
      problems(
        feedback({ nextStep: 'Use best = numbers[0], then for number in numbers: if number > best: best = number, then return best.' }),
        'failed',
      ),
    ).toContain('reveals-solution')
  })
})

describe('hint v2', () => {
  function problems(text: string, previousHints: readonly string[] = []) {
    return hintStrategy
      .checkInvariants(
        { text, kind: 'specific' },
        {
          learner: UNKNOWN_LEARNER,
          conceptId: 'for-loops-and-range',
          brief: 'Largest in a list.',
          learnerAttempt: null,
          depth: previousHints.length + 1,
          previousHints,
          referenceSolution: REFERENCE,
        },
        strategyContext(),
      )
      .map((problem) => problem.code)
  }

  it('allows a hint that moves the learner one step', () => {
    expect(problems('Start by assuming the first number is the biggest you have seen, then look at the rest.')).toEqual([])
  })

  it('refuses a hint containing most of the solution, even without the def line', () => {
    expect(problems('best = numbers[0] then for number in numbers: if number > best: best = number and return best')).toContain(
      'reveals-solution',
    )
  })

  it('refuses a hint that completes the solution together with the hints before it', () => {
    // Each alone is a fragment; on the page they are all visible at once.
    const earlier = ['Start with best = numbers[0].', 'Then use for number in numbers: to look at each one.']

    const last = 'Inside, if number > best: replace it, and at the end return best.'

    // On its own this last hint is a fragment, and would be allowed...
    expect(problems(last)).toEqual([])
    // ...but with the two before it, the ladder has now shown most of the solution.
    expect(problems(last, earlier)).toContain('reveals-solution')
  })

  it('still works for a question, which has no reference solution', () => {
    expect(
      hintStrategy
        .checkInvariants(
          { text: 'Think about what the loop does on its last pass.', kind: 'orienting' },
          {
            learner: UNKNOWN_LEARNER,
            conceptId: 'for-loops-and-range',
            brief: 'b',
            learnerAttempt: null,
            depth: 1,
            previousHints: [],
            referenceSolution: null,
          },
          strategyContext(),
        )
        .map((problem) => problem.code),
    ).toEqual([])
  })
})
