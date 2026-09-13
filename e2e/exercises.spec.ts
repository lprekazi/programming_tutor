import { expect, test, type Locator, type Page } from '@playwright/test'

import { FLAKY_BASE_URL, OFFLINE_BASE_URL } from '../playwright.config'
import { buildTestProgram, parseTestReport } from '../src/domain/diagnostic/harness'
import { AUTHORED_EXERCISES, AUTHORED_EXERCISES_BY_ID } from '../src/domain/exercises/bank'
import { markPractical, type PracticalOutcome } from '../src/domain/exercises/mark'

import {
  PYTHON_READY,
  evidenceCount,
  reachHome,
  resetEverything,
  sendToTutor,
  startTutoring,
} from './helpers'

/**
 * Programming exercises, end to end, in a real interpreter.
 *
 * Every Python program here runs in Pyodide in the browser, exactly as a learner's would. The
 * solutions come from the authored bank rather than a copy kept in this file, so an exercise
 * whose solution changes cannot quietly turn these into tests of a learner who never gets
 * anything right.
 */

const GOAL = 'Understand how programs run'

/** The exercise the end-to-end learner is set first: their session is on while loops. */
const FIRST = AUTHORED_EXERCISES_BY_ID.get('x-while-countdown')
if (FIRST === undefined) throw new Error('the bank has no x-while-countdown')

/** Wrong in a way the checks can see: stops one early, so countdown(1) comes back empty. */
const COUNTDOWN_STOPS_EARLY = [
  'def countdown(n):',
  '    result = []',
  '    while n > 1:',
  '        result.append(n)',
  '        n = n - 1',
  '    return result',
  '',
].join('\n')

function exercise(page: Page): Locator {
  return page.getByTestId('exercise').last()
}

/** Replaces everything in the editor with `code`, the way a paste would. */
async function setCode(page: Page, code: string): Promise<void> {
  const editor = exercise(page).getByTestId('exercise-editor')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(code)
}

/** What the editor holds, read from the lines CodeMirror renders. */
async function editorText(page: Page): Promise<string> {
  return await exercise(page)
    .getByTestId('exercise-editor')
    .evaluate((node) => [...node.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'))
}

/** Asks for an exercise and waits until Python is ready to run it. */
async function askForExercise(page: Page): Promise<void> {
  const before = await page.getByTestId('exercise').count()
  await page.getByTestId('ask-exercise').click()
  await expect(page.getByTestId('exercise')).toHaveCount(before + 1, PYTHON_READY)
  await expect(exercise(page).getByTestId('exercise-run')).toBeEnabled(PYTHON_READY)
}

async function reachExercise(page: Page): Promise<void> {
  await startTutoring(page)
  await sendToTutor(page, 'Could I try writing one?')
  await askForExercise(page)
}

async function runCode(page: Page): Promise<void> {
  await exercise(page).getByTestId('exercise-run').click()
  await expect(exercise(page).getByTestId('exercise-run')).toBeEnabled(PYTHON_READY)
}

/** Submits whatever is in the editor and waits for this submission's result. */
async function submit(page: Page): Promise<void> {
  const set = exercise(page)
  await set.getByTestId('exercise-submit').click()
  await expect(set.getByTestId('exercise-status')).toHaveText(/checks? pass|Not marked|stopped with an error/i, PYTHON_READY)
}

/** Resolves once the next draft save has reached the server and come back. */
async function nextSave(page: Page): Promise<void> {
  await page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.request().headers()['next-action'] !== undefined,
  )
}

async function takeHint(page: Page, depth: number): Promise<void> {
  await exercise(page).getByTestId('exercise-hint-ask').click()
  await expect(exercise(page).getByTestId(`exercise-hint-${String(depth)}`)).toBeVisible()
}

test.describe('a programming exercise', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('is set inside the lesson, with the task, its checks and the starter code', async ({ page }) => {
    await reachExercise(page)

    const set = exercise(page)
    await expect(set.getByTestId('exercise-title')).toHaveText(FIRST.title)
    await expect(set.getByTestId('exercise-brief')).toHaveText(FIRST.brief)
    await expect(set.getByTestId('exercise-ground')).not.toBeEmpty()
    await expect(set.getByTestId('exercise-checks').locator('li')).toHaveText(FIRST.tests.map((check) => check.name))
    // Exactly the starter, final newline included.
    expect(await editorText(page)).toBe(FIRST.starterCode)

    // Part of the conversation, in its place, not a separate page.
    await expect(page).toHaveURL(/\/session\//)
    await expect(page.getByTestId('turns').locator('li[data-role="activity"]')).toHaveCount(1)
    // One thing at a time: nothing else can be asked for while it waits.
    await expect(page.getByTestId('exercise-pending')).toBeVisible()
    await expect(page.getByTestId('ask-check')).toHaveCount(0)
  })

  test('runs code, shows every line of its output, and running is never recorded', async ({ page }) => {
    await reachExercise(page)
    const session = page.url()
    const before = await evidenceCount(page)
    await page.goto(session)
    await expect(exercise(page).getByTestId('exercise-run')).toBeEnabled(PYTHON_READY)

    await setCode(page, 'print("hello")\nprint("world")\nprint(2 + 3)\n')
    await runCode(page)

    await expect(exercise(page).getByTestId('exercise-output')).toHaveText('hello\nworld\n5\n')
    await expect(exercise(page).getByTestId('exercise-status')).toHaveText('Finished.')

    expect(await evidenceCount(page)).toBe(before)
  })

  test('shows a syntax error and a runtime error as the learner wrote them, and recovers', async ({ page }) => {
    await reachExercise(page)

    await setCode(page, 'def broken(:\n    pass\n')
    await runCode(page)
    const syntax = exercise(page).getByTestId('exercise-traceback')
    await expect(syntax).toContainText('SyntaxError')
    await expect(syntax).toContainText('File "main.py", line 1')
    // The interpreter's own frames are not the learner's problem.
    await expect(syntax).not.toContainText('_pyodide')

    await setCode(page, 'items = [1, 2]\nprint(items[5])\n')
    await runCode(page)
    await expect(exercise(page).getByTestId('exercise-traceback')).toContainText('IndexError')
    await expect(exercise(page).getByTestId('exercise-traceback')).toContainText('line 2')

    // No reload: the next run simply works.
    await setCode(page, 'print("fixed")\n')
    await runCode(page)
    await expect(exercise(page).getByTestId('exercise-output')).toHaveText('fixed\n')
    await expect(exercise(page).getByTestId('exercise-traceback')).toHaveCount(0)
  })

  test('stops a program that never ends, and runs the next one without a reload', async ({ page }) => {
    await reachExercise(page)

    await setCode(page, 'count = 0\nwhile True:\n    count = count + 1\n')
    await exercise(page).getByTestId('exercise-run').click()
    await expect(exercise(page).getByTestId('exercise-stop')).toBeVisible()
    await exercise(page).getByTestId('exercise-stop').click()
    await expect(exercise(page).getByTestId('exercise-status')).toHaveText('Stopped.')

    // The worker was terminated; a replacement comes up on its own.
    await expect(exercise(page).getByTestId('exercise-run')).toBeEnabled(PYTHON_READY)
    await setCode(page, 'print("alive again")\n')
    await runCode(page)
    await expect(exercise(page).getByTestId('exercise-output')).toHaveText('alive again\n')
  })

  test('times out a program that never ends by itself, and recovers', async ({ page }) => {
    await reachExercise(page)

    await setCode(page, 'while True:\n    pass\n')
    await exercise(page).getByTestId('exercise-run').click()
    await expect(exercise(page).getByTestId('exercise-status')).toContainText('still running', { timeout: 30_000 })

    await expect(exercise(page).getByTestId('exercise-run')).toBeEnabled(PYTHON_READY)
    await setCode(page, 'print("after the timeout")\n')
    await runCode(page)
    await expect(exercise(page).getByTestId('exercise-output')).toHaveText('after the timeout\n')
  })

  test('a failing submission says which checks pass and what to try next', async ({ page }) => {
    await reachExercise(page)
    const session = page.url()

    await setCode(page, COUNTDOWN_STOPS_EARLY)
    await submit(page)

    const set = exercise(page)
    await expect(set.getByTestId('exercise-result-heading')).toHaveText('Not yet')
    await expect(set.getByTestId('exercise-checks-line')).toHaveText('1 of 3 checks pass.')
    await expect(set.getByTestId('exercise-check-1')).toHaveAttribute('data-outcome', 'fail')
    await expect(set.getByTestId('exercise-check-2')).toHaveAttribute('data-outcome', 'pass')
    // The tutor's notes agree with the checks, and point somewhere rather than just judging.
    await expect(set.getByTestId('exercise-feedback')).toContainText('do not pass')
    await expect(set.getByTestId('exercise-feedback')).toContainText('Next:')
    await expect(set.getByTestId('exercise-attribution')).toContainText('Marked by running your code against the checks')

    // Evidence: one failure, attributed to the exercise.
    await page.goto(session)
    await page.goto('/home')
    await page.getByTestId('history-while-loops').click()
    await expect(page.getByTestId('evidence-while-loops')).toContainText('Did not yet solve an exercise')
  })

  test('the hint ladder has three rungs, cannot be skipped, and survives a reload', async ({ page }) => {
    await reachExercise(page)

    await takeHint(page, 1)
    await expect(exercise(page).getByTestId('exercise-hint-ask')).toContainText('2 of 3')
    await takeHint(page, 2)
    await takeHint(page, 3)
    // Bounded: no fourth.
    await expect(exercise(page).getByTestId('exercise-hint-ask')).toHaveCount(0)

    for (const [index, text] of FIRST.hints.entries()) {
      await expect(exercise(page).getByTestId(`exercise-hint-${String(index + 1)}`)).toContainText(text)
    }

    await page.reload()
    await expect(exercise(page).getByTestId('exercise-hints').locator('li')).toHaveCount(3)
  })

  test('a success after hints counts, for less, and never against the learner', async ({ page }) => {
    await reachExercise(page)
    const session = page.url()

    await takeHint(page, 1)
    await takeHint(page, 2)
    await setCode(page, FIRST.referenceSolution)
    await submit(page)

    await expect(exercise(page).getByTestId('exercise-result-heading')).toHaveText('Every check passes')
    await expect(exercise(page).getByTestId('exercise-attribution')).toContainText('You took 2 hints first')
    await expect(exercise(page).getByTestId('exercise-attribution')).toContainText('never against you')

    await page.goto(session)
    await page.goto('/home')
    await page.getByTestId('history-while-loops').click()
    // The domain's own reason, stating the support that was actually taken.
    await expect(page.getByTestId('evidence-while-loops')).toContainText('Solved an exercise on repeating while something is true after 2 hints')
  })

  test('a correct unaided submission is recorded once, as evidence', async ({ page }) => {
    await reachExercise(page)
    const session = page.url()
    const before = await evidenceCount(page)
    await page.goto(session)
    await expect(exercise(page).getByTestId('exercise-run')).toBeEnabled(PYTHON_READY)

    await setCode(page, FIRST.referenceSolution)
    await submit(page)

    await expect(exercise(page).getByTestId('exercise-result-heading')).toHaveText('Every check passes')
    await expect(exercise(page).getByTestId('exercise-checks-line')).toHaveText('All 3 checks pass.')
    await expect(exercise(page).getByTestId('exercise-attribution')).toContainText('This helps the tutor decide what to practise next')
    // Done: nothing further to submit, and no hints left to offer.
    await expect(exercise(page).getByTestId('exercise-submit')).toHaveCount(0)
    await expect(exercise(page).getByTestId('exercise-hint-ask')).toHaveCount(0)

    expect(await evidenceCount(page)).toBe(before + 1)
  })

  test('submitting twice at once records one submission and one piece of evidence', async ({ page }) => {
    await reachExercise(page)
    const session = page.url()
    const before = await evidenceCount(page)
    await page.goto(session)
    await expect(exercise(page).getByTestId('exercise-run')).toBeEnabled(PYTHON_READY)

    await setCode(page, FIRST.referenceSolution)
    // Actually clicked twice, rather than trusting the button to disable itself.
    await exercise(page).getByTestId('exercise-submit').dblclick()
    await expect(exercise(page).getByTestId('exercise-result-heading')).toHaveText('Every check passes', PYTHON_READY)

    await page.reload()
    await expect(exercise(page).getByTestId('exercise-result-heading')).toHaveText('Every check passes')
    await expect(exercise(page).locator('details')).toHaveCount(0)
    expect(await evidenceCount(page)).toBe(before + 1)
  })

  test('the starter code submitted unchanged is refused, and nothing is recorded', async ({ page }) => {
    await reachExercise(page)
    const session = page.url()
    const before = await evidenceCount(page)
    await page.goto(session)
    await expect(exercise(page).getByTestId('exercise-submit')).toBeEnabled(PYTHON_READY)

    await exercise(page).getByTestId('exercise-submit').click()
    await expect(exercise(page).getByTestId('exercise-problem')).toContainText('still the code the exercise started with')
    // Focus is on the explanation, not lost at the top of the page.
    await expect(exercise(page).getByTestId('exercise-problem')).toBeFocused()
    await expect(exercise(page).getByTestId('exercise-result')).toHaveCount(0)

    expect(await evidenceCount(page)).toBe(before)
  })

  test('checks that never finish can be stopped, and nothing is submitted', async ({ page }) => {
    await reachExercise(page)
    const session = page.url()
    const before = await evidenceCount(page)
    await page.goto(session)
    await expect(exercise(page).getByTestId('exercise-submit')).toBeEnabled(PYTHON_READY)

    await setCode(page, ['def countdown(n):', '    while True:', '        pass', ''].join('\n'))
    await exercise(page).getByTestId('exercise-submit').click()
    await exercise(page).getByTestId('exercise-stop').click()

    await expect(exercise(page).getByTestId('exercise-status')).toHaveText('Stopped. Nothing was submitted.')
    await expect(exercise(page).getByTestId('exercise-status')).toBeFocused()
    await expect(exercise(page).getByTestId('exercise-result')).toHaveCount(0)
    await expect(exercise(page).getByTestId('exercise-submit')).toBeEnabled(PYTHON_READY)
    expect(await evidenceCount(page)).toBe(before)
  })

  test('output printed without a newline does not disturb the marking', async ({ page }) => {
    await reachExercise(page)

    // Printing with end=" " used to glue the harness's own report onto the learner's line.
    await setCode(
      page,
      ['print("counting", end=" ")', FIRST.referenceSolution, 'if __name__ == "__main__":', '    print(countdown(3), end=" ")', ''].join('\n'),
    )
    await submit(page)

    await expect(exercise(page).getByTestId('exercise-checks-line')).toHaveText('All 3 checks pass.')
    await expect(exercise(page).getByTestId('exercise-output')).toContainText('counting')
  })

  test('a reload brings back the same exercise, the code as it was left, and the hints', async ({ page }) => {
    await reachExercise(page)
    await takeHint(page, 1)

    const saved = nextSave(page)
    await setCode(page, 'def countdown(n):\n    # half way there\n    return [n]\n')
    await saved

    await page.reload()
    await expect(exercise(page).getByTestId('exercise-title')).toHaveText(FIRST.title)
    expect(await editorText(page)).toBe('def countdown(n):\n    # half way there\n    return [n]\n')
    await expect(exercise(page).getByTestId('exercise-hint-1')).toBeVisible()
    // Not replaced by a fresh draw on remount.
    await expect(page.getByTestId('exercise')).toHaveCount(1)
  })

  test('a second exercise in the sitting is generated, checked in the browser, and then set', async ({ page }) => {
    await reachExercise(page)
    await setCode(page, FIRST.referenceSolution)
    await submit(page)

    // The only authored exercise for while loops is used, so the next has to be written. The mock
    // writes "Largest in a list"; it is only shown once Pyodide has confirmed its reference solution
    // passes its checks and its starter code does not.
    await askForExercise(page)
    await expect(exercise(page).getByTestId('exercise-title')).toHaveText('Largest in a list')
    expect(await editorText(page)).toContain('def largest(numbers):')
    // The reference solution was never put on the page.
    expect(await page.content()).not.toContain('best = numbers[0]')
  })

  test('keeps the look of the lesson: no IDE chrome, no score, nothing animated', async ({ page }) => {
    await reachExercise(page)

    const body = await page.locator('body').innerText()
    expect(body).not.toMatch(/\bscore\b|\bpoints?\b|\bstreak\b|\bbadge\b|\d+%/i)
    expect(await page.locator('img, [role="tablist"], [role="tree"]').count()).toBe(0)

    const animated = await page.evaluate(
      () => [...document.querySelectorAll('*')].filter((node) => getComputedStyle(node).animationName !== 'none').length,
    )
    expect(animated).toBe(0)
  })
})

/*
 * The authored bank, verified where it has to be: in the interpreter learners' code runs in.
 *
 * `bank.test.ts` checks everything that can be checked without Python. This checks the rest, for
 * every exercise: the reference solution passes every check, the starter code fails at least one,
 * and each misconception signal names its misconception for its witness and for none of its
 * counterexamples — judged by the marking rule itself, on what Pyodide actually reported.
 */
test.describe('the authored exercises', () => {
  test('hold up in a real interpreter', async ({ page }) => {
    await page.goto('/system-check')

    const programs = AUTHORED_EXERCISES.flatMap((authored) => [
      { id: authored.id, role: 'reference', program: buildTestProgram(authored.referenceSolution, authored.tests) },
      { id: authored.id, role: 'starter', program: buildTestProgram(authored.starterCode, authored.tests) },
      ...authored.signals.flatMap((signal) => [
        {
          id: authored.id,
          role: `witness:${signal.misconception}`,
          code: signal.witness,
          program: buildTestProgram(signal.witness, authored.tests),
        },
        ...signal.counterexamples.map((counterexample) => ({
          id: authored.id,
          role: `counterexample:${signal.misconception}`,
          code: counterexample,
          program: buildTestProgram(counterexample, authored.tests),
        })),
      ]),
    ])

    const outputs = await page.evaluate(async (all) => {
      const worker = new Worker('/workers/execution.worker.js', { type: 'module' })
      const results: { stdout: string; failed: boolean }[] = []
      const ready = new Promise<void>((resolve) => {
        worker.addEventListener('message', (event: MessageEvent<{ type: string }>) => {
          if (event.data.type === 'ready') resolve()
        })
      })
      await ready

      for (const [index, entry] of all.entries()) {
        const runId = `bank-${String(index)}`
        let stdout = ''
        let failed = false
        await new Promise<void>((resolve) => {
          const listener = (event: MessageEvent<{ type: string; runId?: string; text?: string }>) => {
            if (event.data.runId !== runId) return
            if (event.data.type === 'output') stdout += event.data.text ?? ''
            if (event.data.type === 'failed') failed = true
            if (event.data.type === 'completed' || event.data.type === 'failed') {
              worker.removeEventListener('message', listener)
              resolve()
            }
          }
          worker.addEventListener('message', listener)
          worker.postMessage({ type: 'run', runId, code: entry.program })
        })
        results.push({ stdout, failed })
      }

      worker.terminate()
      return results
    }, programs)

    const problems: string[] = []
    programs.forEach((entry, index) => {
      const authored = AUTHORED_EXERCISES_BY_ID.get(entry.id)
      if (authored === undefined) return
      const output = outputs[index] ?? { stdout: '', failed: true }
      const report = parseTestReport(output.stdout, authored.tests)
      const pattern = report.results.map((result) => (result.passed ? 'pass' : 'fail'))

      if (entry.role === 'reference' && !report.allTestsPassed) {
        problems.push(`${entry.id}: the reference solution gives ${pattern.join(',')}`)
      }
      if (entry.role === 'starter' && report.allTestsPassed) {
        problems.push(`${entry.id}: the starter code already passes every check`)
      }
      if ('code' in entry) {
        const [role, misconception] = entry.role.split(':')
        const signal = authored.signals.find((each) => each.misconception === misconception)
        if (signal === undefined) return
        const outcome: PracticalOutcome = {
          kind: 'ran',
          checks: report.results.map((result) => ({ outcome: result.passed ? 'pass' : 'fail', error: result.error })),
          incomplete: report.incomplete || output.failed,
          crash: output.failed ? { type: 'Error', message: 'the program stopped' } : null,
        }
        const marking = markPractical({ outcome, tests: authored.tests, signals: [signal], code: entry.code })
        const named = marking.kind === 'marked' && marking.misconceptions.includes(signal.misconception)

        if (role === 'witness' && !named) {
          problems.push(`${entry.id}: ${signal.misconception} is not named for its witness (${pattern.join(',')})`)
        }
        if (role === 'counterexample' && named) {
          problems.push(`${entry.id}: ${signal.misconception} is named for a counterexample: ${JSON.stringify(entry.code)}`)
        }
      }
    })

    expect(problems).toEqual([])
    // And it really ran all of them.
    expect(outputs).toHaveLength(programs.length)
  })
})

/*
 * No tutor configured at all. The programming environment must not depend on one: an exercise can
 * still be set, edited, run, stopped, submitted and marked, and it produces evidence. Only the
 * tutor's notes are missing, and the page says so.
 */
test.describe('an exercise with no tutor configured', () => {
  test.use({ baseURL: OFFLINE_BASE_URL })

  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('still sets, runs, stops, marks and records, and comes back after a reload', async ({ page }) => {
    const before = await evidenceCount(page)
    await page.goto('/home')

    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('session-status')).toContainText('No tutor is configured')
    await page.getByTestId('reply-input').fill('Can I practise this?')
    await page.getByTestId('send-reply').click()
    await expect(page.getByTestId('turns')).toContainText('Can I practise this?')
    const session = page.url()

    await askForExercise(page)

    await setCode(page, 'while True:\n    pass\n')
    await exercise(page).getByTestId('exercise-run').click()
    await exercise(page).getByTestId('exercise-stop').click()
    await expect(exercise(page).getByTestId('exercise-status')).toHaveText('Stopped.')
    await expect(exercise(page).getByTestId('exercise-run')).toBeEnabled(PYTHON_READY)

    // Hints on an authored exercise need no tutor either.
    await takeHint(page, 1)

    await setCode(page, FIRST.referenceSolution)
    await submit(page)
    await expect(exercise(page).getByTestId('exercise-result-heading')).toHaveText('Every check passes')
    await expect(exercise(page).getByTestId('exercise-feedback-unavailable')).toBeVisible()

    expect(await evidenceCount(page)).toBe(before + 1)

    await page.goto(session)
    await expect(exercise(page).getByTestId('exercise-result-heading')).toHaveText('Every check passes')
  })
})

/*
 * Feedback that cannot be written. The failing mock refuses every `code.feedback` call: the result
 * the checks decided, and the evidence it produced, must stand exactly as they would otherwise.
 */
test.describe('an exercise whose feedback fails', () => {
  test.use({ baseURL: FLAKY_BASE_URL })

  test('keeps the checks’ result and the evidence, and says the notes are unavailable', async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: `${GOAL} (feedback failure)`, experience: 'some-python' })
    const before = await evidenceCount(page)
    await page.goto('/home')

    await page.getByTestId('start-session').click()
    await expect(page).toHaveURL(/\/session\//)
    await page.getByTestId('reply-input').fill('Let me try one.')
    await page.getByTestId('send-reply').click()
    await expect(page.getByTestId('turns')).toContainText('Let me try one.')
    await expect(page.getByTestId('retry-reply')).toBeVisible()

    await askForExercise(page)
    await setCode(page, FIRST.referenceSolution)
    await submit(page)

    await expect(exercise(page).getByTestId('exercise-result-heading')).toHaveText('Every check passes')
    await expect(exercise(page).getByTestId('exercise-feedback-unavailable')).toBeVisible()
    await expect(exercise(page).getByTestId('exercise-feedback')).toHaveCount(0)

    expect(await evidenceCount(page)).toBe(before + 1)
  })
})

test.describe('an exercise at 360px', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  test('fits the screen, with controls big enough to hit and code that scrolls inside itself', async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
    await reachExercise(page)

    await setCode(page, `print("${'a long line of output that is much wider than a phone screen '.repeat(3)}")\n`)
    await runCode(page)

    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(sideways).toBe(false)

    for (const id of ['exercise-run', 'exercise-submit']) {
      const box = await exercise(page).getByTestId(id).boundingBox()
      expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(44)
    }
  })
})

test.describe('an exercise with a keyboard alone', () => {
  test('reaches the editor, types, leaves it, runs and submits', async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
    await reachExercise(page)

    // Tab until the editor has focus. Bounded, so a broken tab order fails rather than hangs.
    let reached = false
    await exercise(page).getByTestId('exercise-title').evaluate((node) => {
      ;(node as HTMLElement).setAttribute('tabindex', '-1')
      ;(node as HTMLElement).focus()
    })
    for (let step = 0; step < 15 && !reached; step += 1) {
      await page.keyboard.press('Tab')
      reached = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'exercise-editor')
    }
    expect(reached, 'the editor is reachable with Tab').toBe(true)

    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText('print("typed with the keyboard")\n')

    // Tab indents inside the editor; Escape, then Tab, moves on.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('exercise-run')

    await page.keyboard.press('Enter')
    await expect(exercise(page).getByTestId('exercise-output')).toHaveText('typed with the keyboard\n', PYTHON_READY)

    await expect(exercise(page).getByTestId('exercise-run')).toBeEnabled(PYTHON_READY)
    await exercise(page).getByTestId('exercise-run').focus()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('exercise-submit')
    await page.keyboard.press('Enter')

    // Focus lands on the result, so it is heard and the learner is beside it.
    await expect(exercise(page).getByTestId('exercise-result-heading')).toBeFocused(PYTHON_READY)
  })
})
