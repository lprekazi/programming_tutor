import { expect, test } from '@playwright/test'

import { answerCurrent, completeOnboarding, resetEverything } from './helpers'

/**
 * The first run on a small screen.
 *
 * 360 × 740 is about the narrowest phone still in use. The thing that actually breaks at this
 * width is not prettiness — it is a page that scrolls sideways, or a control the learner cannot
 * hit, or a label that only existed as a table column heading that has since been hidden.
 *
 * Asserted rather than claimed: the layout has breakpoints, and until something exercises them
 * "responsive" is an intention.
 */

const NARROW = { width: 360, height: 740 }

test.use({ viewport: NARROW })

/** True when the document is wider than the window, which is the failure worth catching. */
async function scrollsSideways(page: import('@playwright/test').Page): Promise<boolean> {
  return await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
}

test.describe('at 360px', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
  })

  test('onboarding never scrolls sideways, at any step', async ({ page }) => {
    expect(await scrollsSideways(page)).toBe(false)

    await page.getByTestId('goal-input').fill('Understand the scripts I inherited')
    await page.getByTestId('goal-continue').click()
    expect(await scrollsSideways(page)).toBe(false)

    await page.getByRole('radio', { name: 'I have written some Python' }).check()
    await page.getByTestId('experience-continue').click()

    // The confidence grid is the hard case: a table of eight rows by four columns.
    expect(await scrollsSideways(page)).toBe(false)
  })

  test('every confidence option keeps a visible label once the column headings are gone', async ({
    page,
  }) => {
    await page.getByTestId('goal-input').fill('Understand the scripts I inherited')
    await page.getByTestId('goal-continue').click()
    await page.getByRole('radio', { name: 'I have written some Python' }).check()
    await page.getByTestId('experience-continue').click()

    // The column heading is hidden at this width — it is the first match in the DOM, and it
    // must not be the one carrying the meaning.
    await expect(page.getByRole('columnheader', { name: 'Comfortable' })).toBeHidden()

    /*
     * Collapsing the table to blocks also costs it its table semantics, so neither the visible
     * heading nor the row/column association survives. The per-control label is what does: each
     * radio carries its area *and* its confidence level in its accessible name, which holds
     * whether or not the browser still thinks this is a table.
     */
    await expect(
      page.getByRole('radio', { name: 'Variables and values: Comfortable' }),
    ).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Repeating things: New to me' })).toBeVisible()

    // And a visible label beside each control, one per competence area, so a sighted learner
    // is not choosing between four identical unlabelled circles.
    for (const label of ['New to me', 'Some idea', 'Comfortable', 'Confident']) {
      await expect(page.getByText(label, { exact: true }).locator('visible=true')).toHaveCount(10)
    }

    // And the control is still reachable and operable.
    const first = page.getByRole('radio').first()
    await first.check()
    await expect(first).toBeChecked()
  })

  test('a diagnostic question fits, and its controls are big enough to hit', async ({ page }) => {
    await completeOnboarding(page, {
      goal: 'Understand the scripts I inherited',
      experience: 'some-python',
    })

    expect(await scrollsSideways(page)).toBe(false)

    // WCAG 2.2 SC 2.5.8 asks for 24 × 24 CSS pixels. The whole option row is the target, so
    // it should be comfortably past that.
    for (const option of await page.locator('label', { has: page.getByRole('radio') }).all()) {
      const box = await option.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24)
    }

    await answerCurrent(page, true)
    expect(await scrollsSideways(page)).toBe(false)
    await expect(page.getByTestId('verdict')).toBeVisible()
  })

  test('the profile fits, with its bands still readable beside each concept', async ({ page }) => {
    await completeOnboarding(page, {
      goal: 'Understand the scripts I inherited',
      experience: 'some-python',
    })

    for (let guard = 0; guard < 20; guard += 1) {
      if (await page.getByTestId('finish-diagnostic').isVisible()) break
      await answerCurrent(page, true)
      await page.getByTestId('next-item').click()
      await expect(page.getByTestId('next-item')).toBeHidden()
    }

    await page.getByTestId('finish-diagnostic').click()
    await expect(page).toHaveURL(/\/home$/)

    // Thirty-three concepts in a three-column grid is the other layout that could burst.
    expect(await scrollsSideways(page)).toBe(false)
    await expect(page.getByTestId('band-program-execution')).toBeVisible()
  })

  test('a long line of code scrolls inside its own block, not the page', async ({ page }) => {
    await completeOnboarding(page, { goal: 'Write code', experience: 'regular-python' })

    for (let guard = 0; guard < 15; guard += 1) {
      const id = await page.getByTestId('diagnostic-item').getAttribute('data-item-id')
      if (id === 'code-count-evens') break
      await answerCurrent(page, true)
      await page.getByTestId('next-item').click()
      await expect(page.getByTestId('next-item')).toBeHidden()
    }

    await page
      .getByTestId('answer-input')
      .fill(`def count_evens(numbers):\n    return len([n for n in numbers if n % 2 == 0])  # ${'x'.repeat(200)}\n`)

    expect(await scrollsSideways(page)).toBe(false)
  })
})
