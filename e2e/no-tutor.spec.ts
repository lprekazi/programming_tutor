import { expect, test } from '@playwright/test'

import { OFFLINE_BASE_URL } from '../playwright.config'
import { DIAGNOSTIC_ITEMS } from '../src/domain/diagnostic/items'

import { completeDiagnostic, completeOnboarding, evidenceCount, resetEverything } from './helpers'

/**
 * The application with no tutor behind it.
 *
 * Almost everything in the diagnostic is marked without a model — a choice has a correct
 * option, a prediction has an expected string, the practical question has checks that pass or
 * do not. Only a written explanation needs reading, and when there is nothing to read it the
 * honest outcome is to leave that question unasked and say so.
 *
 * What must not happen is the interesting part: a question marked wrong because a model could
 * not be reached, or a concept quietly assumed to be weak because it was never covered.
 */

test.use({ baseURL: OFFLINE_BASE_URL })

const WRITTEN_ITEM_IDS = DIAGNOSTIC_ITEMS.filter((item) => item.kind === 'explain').map(
  (item) => item.id,
)

test.describe('with no tutor configured', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
  })

  test('still completes the diagnostic and produces a profile', async ({ page }) => {
    await completeOnboarding(page, { goal: 'Understand my own code', experience: 'regular-python' })

    const asked = await completeDiagnostic(page, true)
    expect(asked.length).toBeGreaterThanOrEqual(7)

    await page.getByTestId('finish-diagnostic').click()
    await expect(page).toHaveURL(/\/home$/)
    await expect(page.getByTestId('assessed-count')).toContainText('concepts')
  })

  test('never asks a question it could not mark', async ({ page }) => {
    await completeOnboarding(page, { goal: 'Understand my own code', experience: 'regular-python' })

    const asked = await completeDiagnostic(page, true)
    for (const written of WRITTEN_ITEM_IDS) {
      expect(asked).not.toContain(written)
    }
  })

  test('says plainly that the tutor was unavailable, rather than glossing over it', async ({
    page,
  }) => {
    await completeOnboarding(page, { goal: 'Understand my own code', experience: 'regular-python' })
    const asked = await completeDiagnostic(page, true)

    await expect(page.getByTestId('tutor-unreachable')).toContainText('could not be reached')
    await expect(page.getByTestId('tutor-unreachable')).toContainText('marked without it')

    // Nothing was *set aside* — the written question was never offered in the first place, and
    // claiming otherwise would overstate what this run actually left out.
    await expect(page.getByTestId('set-aside')).toHaveCount(0)

    // One piece of evidence per question answered, and none for the question never asked.
    await page.getByTestId('finish-diagnostic').click()
    expect(await evidenceCount(page)).toBe(asked.length)
  })
})
