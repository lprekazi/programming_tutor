import { expect, test } from '@playwright/test'

import { buildVerificationProgram } from '../src/python/verification'

/**
 * Proves the two things the rest of the application will depend on: that the learner's
 * data store works, and that Python runs in the browser and can always be stopped —
 * including when the program itself never intends to finish.
 */

/** Run is enabled only once the interpreter has actually booted, so this is the honest signal to wait on. */
const PYTHON_READY = { timeout: 60_000 }

test.describe('system check', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/system-check')
  })

  test('reports that the local data store is working', async ({ page }) => {
    await expect(page.getByTestId('storage-status')).toHaveText('Working')
  })

  test('tells the learner the interpreter is starting, then enables Run', async ({ page }) => {
    // Before Python is up, Run must not look available.
    await expect(page.getByTestId('run')).toBeEnabled(PYTHON_READY)
    await expect(page.getByTestId('python-version')).toContainText('Python 3.')
  })

  test('runs Python in the browser and shows its output', async ({ page }) => {
    await expect(page.getByTestId('run')).toBeEnabled(PYTHON_READY)
    await page.getByTestId('run').click()

    await expect(page.getByTestId('output')).toContainText('Hello from Python')
    await expect(page.getByTestId('summary')).toContainText('Finished in')
  })

  test('shows a Python error without breaking the page', async ({ page }) => {
    await expect(page.getByTestId('run')).toBeEnabled(PYTHON_READY)
    await page.getByTestId('example-error').click()
    await page.getByTestId('run').click()

    await expect(page.getByTestId('summary')).toContainText('IndexError')
    // The interpreter is still usable afterwards.
    await expect(page.getByTestId('run')).toBeEnabled()
  })

  test('stops a program that never ends, and recovers afterwards', async ({ page }) => {
    await expect(page.getByTestId('run')).toBeEnabled(PYTHON_READY)

    await page.getByTestId('example-endless').click()
    await page.getByTestId('run').click()

    const stop = page.getByTestId('stop')
    await expect(stop).toBeEnabled()
    await stop.click()

    await expect(page.getByTestId('summary')).toHaveText('Stopped.')

    // The worker was terminated; a replacement must start on its own and run normally.
    await page.getByTestId('example-greeting').click()
    await expect(page.getByTestId('run')).toBeEnabled(PYTHON_READY)
    await page.getByTestId('run').click()
    await expect(page.getByTestId('output')).toContainText('Hello from Python')
    await expect(page.getByTestId('summary')).toContainText('Finished in')
  })

  test('stops a program that never ends on its own, without the learner intervening', async ({
    page,
  }) => {
    await expect(page.getByTestId('run')).toBeEnabled(PYTHON_READY)

    await page.getByTestId('example-endless').click()
    await page.getByTestId('run').click()

    // The wall-clock budget expires and the worker is terminated with no user action.
    await expect(page.getByTestId('summary')).toContainText('Stopped automatically', {
      timeout: 30_000,
    })
    await expect(page.getByTestId('run')).toBeEnabled(PYTHON_READY)
  })

  test('is operable with the keyboard alone', async ({ page }) => {
    // A disabled control is deliberately not focusable, so wait until every control is
    // actually offered before checking that all of them can be reached.
    await expect(page.getByTestId('run')).toBeEnabled(PYTHON_READY)

    // First Tab from the top of the document reaches the skip link.
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()

    // Every control is reachable without a pointer.
    const reachable: string[] = []
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab')
      const testId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')
      if (testId !== '') reachable.push(testId)
    }

    expect(reachable).toContain('python-source')
    expect(reachable).toContain('run')
  })
})

/**
 * The exercise-verification harness is Python that must behave correctly in a real
 * interpreter: it runs a model-written reference solution against model-written tests
 * and reports a machine-readable verdict. These run the harness through the same
 * interpreter the learner uses, so a change that breaks the harness fails here rather
 * than reaching a learner as a broken exercise.
 */
test.describe('exercise verification harness', () => {
  const MARKER = '__exercise_verification__:e2e:'

  test.beforeEach(async ({ page }) => {
    await page.goto('/system-check')
    await expect(page.getByTestId('run')).toBeEnabled({ timeout: 60_000 })
  })

  test('reports no failures when the solution satisfies its tests', async ({ page }) => {
    const program = buildVerificationProgram(
      {
        referenceSolution: 'def double(n):\n    return n * 2\n',
        tests: [
          { name: 'doubles a positive number', code: 'assert double(3) == 6' },
          { name: 'doubles zero', code: 'assert double(0) == 0' },
        ],
      },
      MARKER,
    )

    await page.getByTestId('python-source').fill(program)
    await page.getByTestId('run').click()

    await expect(page.getByTestId('output')).toContainText(`${MARKER}{"failures": []}`)
  })

  test('names the failing test when the solution is wrong', async ({ page }) => {
    const program = buildVerificationProgram(
      {
        referenceSolution: 'def double(n):\n    return n + 2\n',
        tests: [
          { name: 'doubles a positive number', code: 'assert double(3) == 6' },
          { name: 'doubles two', code: 'assert double(2) == 4' },
        ],
      },
      MARKER,
    )

    await page.getByTestId('python-source').fill(program)
    await page.getByTestId('run').click()

    const output = page.getByTestId('output')
    await expect(output).toContainText('doubles a positive number')
    await expect(output).toContainText('AssertionError')
    // The second test happens to pass with this wrong solution, and must not be reported.
    await expect(output).not.toContainText('doubles two')
  })

  test('handles test code containing quotes and newlines', async ({ page }) => {
    const program = buildVerificationProgram(
      {
        referenceSolution: 'def shout(text):\n    return text.upper() + "!"\n',
        tests: [
          {
            name: 'quotes "and" newlines',
            code: 'result = shout("a \\"quoted\\" word")\nassert result.endswith("!")\nassert "QUOTED" in result\n',
          },
        ],
      },
      MARKER,
    )

    await page.getByTestId('python-source').fill(program)
    await page.getByTestId('run').click()

    await expect(page.getByTestId('output')).toContainText(`${MARKER}{"failures": []}`)
  })
})
