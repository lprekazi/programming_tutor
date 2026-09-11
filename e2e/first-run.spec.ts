import { expect, test } from '@playwright/test'

import {
  answerCurrent,
  completeDiagnostic,
  completeOnboarding,
  currentItemId,
  evidenceCount,
  resetEverything,
  PYTHON_READY,
} from './helpers'

/**
 * The first run, end to end.
 *
 * These are the journeys a learner actually takes, and the failures they would actually
 * notice: losing their place, being asked the same question twice, being told they are good at
 * something on their own say-so, or a profile built from evidence that was counted more than
 * once.
 */

test.describe('first run', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
  })

  test('takes a new learner from onboarding through the diagnostic to their profile', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByTestId('goal-input')).toBeVisible()

    await completeOnboarding(page, {
      goal: 'Read my team’s Python scripts without guessing',
      experience: 'some-python',
    })

    // The learner is told how much is left before they are told anything else — as a range,
    // because a single number could only be arrived at by guessing.
    await expect(page.getByTestId('progress')).toContainText('to go')

    const asked = await completeDiagnostic(page, true)
    expect(asked.length).toBeGreaterThanOrEqual(7)

    await expect(page.getByTestId('diagnostic-summary')).toBeVisible()
    await expect(page.getByTestId('answered-count')).toHaveText(String(asked.length))

    await page.getByTestId('finish-diagnostic').click()

    await expect(page).toHaveURL(/\/home$/)
    await expect(page.getByTestId('learner-goal')).toContainText('Read my team')
    await expect(page.getByTestId('next-concept')).not.toBeEmpty()
    await expect(page.getByTestId('next-reason')).not.toBeEmpty()

    // Going back to the root now lands on the profile, not on onboarding.
    await page.goto('/')
    await expect(page).toHaveURL(/\/home$/)
  })

  /*
   * The headline rule of the milestone, checked through the interface rather than only in the
   * domain: a learner who says they are advanced must not be shown a band they have not
   * earned. An earlier version of this test stopped at the evidence count and never reached
   * the page where a band would actually appear, which made its name a larger claim than its
   * body.
   */
  test('never claims a band the learner has not earned', async ({ page }) => {
    // Claims to be experienced, and confident in everything.
    await page.getByTestId('goal-input').fill('Get better fast')
    await page.getByTestId('goal-continue').click()
    await page.getByRole('radio', { name: 'I write Python fairly regularly' }).check()
    await page.getByTestId('experience-continue').click()

    for (const row of await page.getByRole('row').all()) {
      const confident = row.getByRole('radio').nth(3)
      if ((await confident.count()) > 0) await confident.check()
    }
    await page.getByTestId('confidence-continue').click()

    // Before answering anything: no evidence, and no band anywhere to show it.
    expect(await evidenceCount(page)).toBe(0)
    await page.goto('/diagnostic')
    await expect(page.getByTestId('diagnostic-item')).toBeVisible()

    // Now answer every question wrong, and look at what the profile says.
    await completeDiagnostic(page, false)
    await page.getByTestId('finish-diagnostic').click()
    await expect(page).toHaveURL(/\/home$/)

    const bands = page.locator('[data-band]')
    await expect(bands.first()).toBeVisible()

    // Nothing may read Secure — the claim bought them a harder first question and nothing else.
    await expect(page.locator('[data-band="secure"]')).toHaveCount(0)

    // And the concepts they were never asked about are untouched, not assumed weak.
    await expect(page.getByTestId('band-classes-and-objects')).toHaveText('Not started')
  })

  test('resumes at the same question after the tab is closed', async ({ page }) => {
    await completeOnboarding(page, { goal: 'Learn loops', experience: 'some-python' })

    await answerCurrent(page, true)
    await page.getByTestId('next-item').click()
    await expect(page.getByTestId('next-item')).toBeHidden()

    const abandonedAt = await currentItemId(page)
    const prompt = await page.getByTestId('item-prompt').innerText()

    // As close to closing the application as a browser test gets: the page is gone, and what
    // comes back is built entirely from what was stored.
    await page.goto('about:blank')
    await page.goto('/')

    await expect(page).toHaveURL(/\/diagnostic$/)
    expect(await currentItemId(page)).toBe(abandonedAt)
    await expect(page.getByTestId('item-prompt')).toHaveText(prompt)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Question 2')
  })

  /*
   * The progress line used to read "of about 12" for the whole of a run that ended at 7. What
   * is checked now is that it never promises more than is left and never widens, and that the
   * question announced as the last one really is.
   */
  test('tells the truth about how much is left', async ({ page }) => {
    await completeOnboarding(page, { goal: 'Learn loops', experience: 'some-python' })

    let previousMost = Number.POSITIVE_INFINITY
    let sawLast = false

    for (let guard = 0; guard < 20; guard += 1) {
      if (await page.getByTestId('finish-diagnostic').isVisible()) break

      const line = await page.getByTestId('progress').innerText()
      if (line.includes('The last question')) {
        sawLast = true
      } else {
        const most = Math.max(...[...line.matchAll(/\d+/g)].map((match) => Number(match[0])))
        expect(most, line).toBeLessThanOrEqual(previousMost)
        previousMost = most
      }

      await answerCurrent(page, true)
      await page.getByTestId('next-item').click()
      await expect(page.getByTestId('next-item')).toBeHidden()
    }

    // The question announced as the last one was followed by the summary, not another question.
    expect(sawLast).toBe(true)
    await expect(page.getByTestId('diagnostic-summary')).toBeVisible()
  })

  test('records one piece of evidence per answer, however often the page is reloaded', async ({
    page,
  }) => {
    await completeOnboarding(page, { goal: 'Learn loops', experience: 'some-python' })

    await answerCurrent(page, true)
    expect(await evidenceCount(page)).toBe(1)

    // Reloading with the verdict on screen: the answer is stored, so the question is gone and
    // nothing is recorded a second time.
    await page.goto('/diagnostic')
    expect(await evidenceCount(page)).toBe(1)

    await page.goto('/diagnostic')
    await answerCurrent(page, false)
    await page.getByTestId('next-item').click()
    await expect(page.getByTestId('next-item')).toBeHidden()
    expect(await evidenceCount(page)).toBe(2)

    await page.goto('/diagnostic')
    const asked = await completeDiagnostic(page, true)
    expect(await evidenceCount(page)).toBe(asked.length + 2)
  })

  test('explains how each answer was marked', async ({ page }) => {
    await completeOnboarding(page, { goal: 'Learn loops', experience: 'some-python' })

    await answerCurrent(page, false)
    await expect(page.getByTestId('verdict-heading')).toHaveText('Not quite.')
    await expect(page.getByTestId('verdict-source')).toContainText('Recorded as one piece of')
    await expect(page.getByTestId('verdict-explanation')).not.toBeEmpty()
  })

  test('will not submit an empty answer', async ({ page }) => {
    await completeOnboarding(page, { goal: 'Learn loops', experience: 'new-to-programming' })

    await page.getByTestId('submit-answer').click()
    await expect(page.getByTestId('answer-problem')).toBeVisible()
    await expect(page.getByTestId('verdict')).toBeHidden()
    expect(await evidenceCount(page)).toBe(0)
  })
})

/**
 * The practical question.
 *
 * The learner writes Python, runs it in their own browser, and is marked on what the checks
 * did. Three separate facts have to stay separate on screen: what their program printed, which
 * checks passed, and what was recorded.
 */
test.describe('the practical question', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    // This route reaches the practical question early, so the test does not depend on
    // answering ten unrelated questions first.
    await completeOnboarding(page, { goal: 'Write real code', experience: 'regular-python' })
  })

  async function reachTheCodeItem(page: import('@playwright/test').Page): Promise<void> {
    for (let guard = 0; guard < 15; guard += 1) {
      if ((await currentItemId(page)) === 'code-count-evens') return
      await answerCurrent(page, true)
      await page.getByTestId('next-item').click()
      await expect(page.getByTestId('next-item')).toBeHidden()
    }
    throw new Error('the diagnostic never asked the practical question')
  }

  test('runs the learner’s Python in the browser and marks it from the checks', async ({
    page,
  }) => {
    await reachTheCodeItem(page)

    await expect(page.getByTestId('run-code')).toBeEnabled(PYTHON_READY)
    await page.getByTestId('answer-input').fill(
      'def count_evens(numbers):\n    print("checking", len(numbers))\n    return len([n for n in numbers if n % 2 == 0])\n',
    )
    await page.getByTestId('run-code').click()

    // What their program did.
    await expect(page.getByTestId('run-output')).toContainText('checking')
    // The harness's own bookkeeping is not shown to them as output.
    await expect(page.getByTestId('run-output')).not.toContainText('diagnostic-test')

    // Which checks passed, named.
    await expect(page.getByTestId('test-results')).toContainText('counts evens in a mixed list')
    await expect(page.getByTestId('test-results')).toContainText('returns zero for an empty list')

    await page.getByTestId('submit-answer').click()
    await expect(page.getByTestId('verdict-heading')).toHaveText('That is right.')
    await expect(page.getByTestId('verdict-source')).toContainText('running your code')
  })

  test('marks a wrong solution wrong, and says which check failed', async ({ page }) => {
    await reachTheCodeItem(page)

    await expect(page.getByTestId('run-code')).toBeEnabled(PYTHON_READY)
    await page
      .getByTestId('answer-input')
      .fill('def count_evens(numbers):\n    return len(numbers)\n')
    await page.getByTestId('run-code').click()

    await expect(page.getByTestId('test-results')).toBeVisible()
    await page.getByTestId('submit-answer').click()
    await expect(page.getByTestId('verdict-heading')).toHaveText('Not quite.')
  })

  test('says what went wrong when the learner’s code raises, and stays usable', async ({
    page,
  }) => {
    await reachTheCodeItem(page)

    await expect(page.getByTestId('run-code')).toBeEnabled(PYTHON_READY)
    await page.getByTestId('answer-input').fill('def count_evens(numbers):\n    return 1 / 0\n')
    await page.getByTestId('run-code').click()

    // Each check is guarded separately, so the exception does not end the run. The learner
    // must still be told what it was, or every check says nothing but "failed".
    await expect(page.getByTestId('test-results')).toContainText('ZeroDivisionError')

    // The interpreter is unharmed: a correct answer still runs and still passes.
    await page
      .getByTestId('answer-input')
      .fill('def count_evens(numbers):\n    return len([n for n in numbers if n % 2 == 0])\n')
    await page.getByTestId('run-code').click()
    await expect(page.getByTestId('test-results')).not.toContainText('ZeroDivisionError')

    await page.getByTestId('submit-answer').click()
    await expect(page.getByTestId('verdict-heading')).toHaveText('That is right.')
  })

  test('reports a syntax error rather than silently failing every check', async ({ page }) => {
    await reachTheCodeItem(page)

    await expect(page.getByTestId('run-code')).toBeEnabled(PYTHON_READY)
    await page.getByTestId('answer-input').fill('def count_evens(numbers)\n    return 0\n')
    await page.getByTestId('run-code').click()

    // Nothing ran at all, so this failure escapes the guards and the traceback is shown.
    await expect(page.getByTestId('run-traceback')).toContainText('SyntaxError')
    await expect(page.getByTestId('test-results')).toBeVisible()
  })

  test('refuses to mark code that has not been run', async ({ page }) => {
    await reachTheCodeItem(page)

    await page.getByTestId('submit-answer').click()
    await expect(page.getByTestId('answer-problem')).toContainText('Run your code first')
    await expect(page.getByTestId('verdict')).toBeHidden()
  })
})
