import { expect, type Page } from '@playwright/test'

import { DIAGNOSTIC_ITEMS_BY_ID } from '../src/domain/diagnostic/items'
import { RESET_CONFIRMATION } from '../app/reset/confirmation'

/**
 * Driving the first-run journey from the outside.
 *
 * The answers come from the real item bank rather than from a copy kept in the test, so a
 * question whose correct answer changes does not quietly turn these into tests of a learner
 * getting everything wrong. What the browser is *shown* still comes only from the page.
 */

/** Pyodide is ~13 MB on a cold start in a fresh profile. */
export const PYTHON_READY = { timeout: 60_000 }

const CORRECT_SOLUTION = [
  'def count_evens(numbers):',
  '    total = 0',
  '    for n in numbers:',
  '        if n % 2 == 0:',
  '            total += 1',
  '    return total',
].join('\n')

const WRONG_SOLUTION = [
  'def count_evens(numbers):',
  '    return len(numbers)',
].join('\n')

export async function resetEverything(page: Page): Promise<void> {
  await page.goto('/reset')
  await page.getByTestId('reset-confirmation').fill(RESET_CONFIRMATION)
  await page.getByTestId('reset-confirm').click()
  await expect(page.getByTestId('goal-input')).toBeVisible()
}

export type Experience =
  | 'new-to-programming'
  | 'other-language'
  | 'some-python'
  | 'regular-python'

export async function completeOnboarding(
  page: Page,
  options: { readonly goal: string; readonly experience: Experience },
): Promise<void> {
  await page.getByTestId('goal-input').fill(options.goal)
  await page.getByTestId('goal-continue').click()

  await page.getByRole('radio', { name: experienceLabel(options.experience) }).check()
  await page.getByTestId('experience-continue').click()

  // Confidence is deliberately optional: a learner who skips it has simply said nothing.
  await page.getByTestId('confidence-continue').click()
  await expect(page.getByTestId('diagnostic-item')).toBeVisible()
}

function experienceLabel(experience: Experience): string {
  switch (experience) {
    case 'new-to-programming':
      return 'I have not written code before'
    case 'other-language':
      return 'I have programmed, but not in Python'
    case 'some-python':
      return 'I have written some Python'
    case 'regular-python':
      return 'I write Python fairly regularly'
  }
}

/** The id of the question currently on screen. */
export async function currentItemId(page: Page): Promise<string> {
  const id = await page.getByTestId('diagnostic-item').getAttribute('data-item-id')
  if (id === null) throw new Error('the question on screen has no item id')
  return id
}

/**
 * Answers whatever question is showing, correctly or not as asked.
 *
 * Returns once the verdict is on screen; it does not move to the next question, so a test can
 * assert on what the learner is told.
 */
export async function answerCurrent(page: Page, correctly: boolean): Promise<string> {
  const itemId = await currentItemId(page)
  const item = DIAGNOSTIC_ITEMS_BY_ID.get(itemId)
  if (item === undefined) throw new Error(`the page is showing an unknown item: ${itemId}`)

  switch (item.kind) {
    case 'choice': {
      const index = correctly
        ? item.correctIndex
        : (item.correctIndex + 1) % item.options.length
      await page.getByTestId(`option-${String(index)}`).check()
      break
    }
    case 'predict-output': {
      await page
        .getByTestId('answer-input')
        .fill(correctly ? item.expectedOutput : 'something else entirely')
      break
    }
    case 'explain': {
      // The mock provider marks every written answer correct, so what is typed does not change
      // the verdict — but the helper still has to send different text, or a test that asked for
      // a wrong run is quietly submitting a right one.
      await page
        .getByTestId('answer-input')
        .fill(
          correctly
            ? 'A name defined inside a function belongs to that function alone.'
            : 'Every name in a program can be seen from everywhere in it.',
        )
      break
    }
    case 'code': {
      await expect(page.getByTestId('run-code')).toBeEnabled(PYTHON_READY)
      await page.getByTestId('answer-input').fill(correctly ? CORRECT_SOLUTION : WRONG_SOLUTION)
      await page.getByTestId('run-code').click()
      await expect(page.getByTestId('run-result')).toBeVisible(PYTHON_READY)
      break
    }
  }

  await page.getByTestId('submit-answer').click()
  await expect(page.getByTestId('verdict')).toBeVisible()
  return itemId
}

/** Works through the whole diagnostic, returning the ids of every question asked. */
export async function completeDiagnostic(
  page: Page,
  correctly: boolean,
): Promise<readonly string[]> {
  const asked: string[] = []

  for (let guard = 0; guard < 20; guard += 1) {
    if (await page.getByTestId('finish-diagnostic').isVisible()) return asked

    asked.push(await answerCurrent(page, correctly))
    await page.getByTestId('next-item').click()
    await expect(page.getByTestId('next-item')).toBeHidden()
  }

  throw new Error('the diagnostic did not finish')
}

/** How many pieces of evidence the learner model holds, read from the reset page. */
export async function evidenceCount(page: Page): Promise<number> {
  await page.goto('/reset')
  return Number(await page.getByTestId('evidence-count').innerText())
}
