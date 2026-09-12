import { expect, test } from '@playwright/test'

import { FLAKY_BASE_URL, OFFLINE_BASE_URL, PACED_BASE_URL } from '../playwright.config'

import { reachHome, resetEverything, sendToTutor, startTutoring } from './helpers'

/**
 * When the tutor does not answer.
 *
 * Three different things, which the learner must be able to tell apart: they stopped it, it
 * broke, or there is no tutor configured at all. Each needs something different from them, and
 * one of them needs a retry that does not leave two copies of the reply.
 *
 * Each runs against its own instance of the same build, so the failure is produced by the real
 * streaming endpoint rather than by a stub standing in for it.
 */

const GOAL = 'Understand how programs run'

/*
 * Cancellation, against a server whose stream is paced.
 *
 * The pacing is what makes a window to press Stop exist at all. The test still waits on the
 * page saying the tutor is replying — a state it publishes — rather than on a clock.
 */
test.describe('stopping a reply', () => {
  test.use({ baseURL: PACED_BASE_URL })

  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('stops it, says so, and keeps what had arrived', async ({ page }) => {
    await page.getByTestId('start-session').click()
    await expect(page).toHaveURL(/\/session\//)

    // Published state, not a delay: text has begun to arrive.
    await expect(page.getByTestId('session-status')).toContainText('is replying')
    const partial = await page.getByTestId('turn-0').innerText()

    await page.getByTestId('stop-reply').click()

    // Told they stopped it — not told something went wrong, which is a different thing.
    await expect(page.getByTestId('session-status')).toContainText('You stopped the reply')
    await expect(page.getByTestId('stop-reply')).toBeHidden()

    // What they had already read is still on the page.
    await expect(page.getByTestId('turn-0')).not.toBeEmpty()
    expect(partial.length).toBeGreaterThan(0)
  })

  test('lets the learner carry on afterwards', async ({ page }) => {
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('session-status')).toContainText('is replying')
    await page.getByTestId('stop-reply').click()
    await expect(page.getByTestId('session-status')).toContainText('You stopped the reply')

    // The compose box is available again, and asking something works.
    await expect(page.getByTestId('reply-input')).toBeEnabled()
    await page.getByTestId('reply-input').fill('Can you go over that again?')
    await page.getByTestId('send-reply').click()

    await expect(page.getByTestId('turns').locator('li')).toHaveCount(3)
  })

  test('shows a pending state before any text has arrived', async ({ page }) => {
    await page.getByTestId('start-session').click()
    // One restrained line of prose. No typing dots, no spinner, no animation.
    await expect(page.getByTestId('session-status')).toContainText('is thinking about')
  })

  test('a stopped reply survives a reload, marked as stopped', async ({ page }) => {
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('session-status')).toContainText('is replying')
    await page.getByTestId('stop-reply').click()
    await expect(page.getByTestId('session-status')).toContainText('You stopped the reply')

    await page.reload()

    await expect(page.getByTestId('turn-0')).toContainText('You stopped this reply part-way')
    // And it can be picked up again rather than being a dead end.
    await expect(page.getByTestId('retry-reply').or(page.getByTestId('reply-input'))).toBeVisible()
  })
})

/*
 * A transient failure, against a server that drops its first attempt at each prose turn.
 */
test.describe('a reply that fails', () => {
  test.use({ baseURL: FLAKY_BASE_URL })

  /*
   * A distinct goal per test. The goal rides in every prompt, and the flaky provider fails the
   * first attempt at each distinct prompt — so this is what keeps the tests independent of one
   * another without the server needing to know a test is running.
   */
  async function arrive(page: import('@playwright/test').Page, goal: string): Promise<void> {
    await resetEverything(page)
    await reachHome(page, { goal, experience: 'some-python' })
  }

  test('says so plainly, without showing the learner a provider error', async ({ page }) => {
    await arrive(page, 'flaky: no provider error shown')
    await page.getByTestId('start-session').click()
    await expect(page).toHaveURL(/\/session\//)

    const status = page.getByTestId('session-status')
    await expect(status).toContainText('Nothing you wrote has been lost')
    // Never the underlying error: it can carry model text, endpoints or a stack.
    await expect(status).not.toContainText('connection dropped')
    await expect(status).not.toContainText('Error')
  })

  test('offers a retry that works, and leaves only one reply behind', async ({ page }) => {
    await arrive(page, 'flaky: retry works')
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('retry-reply')).toBeVisible()

    await page.getByTestId('retry-reply').click()
    await expect(page.getByTestId('session-status')).toHaveText('')

    // One tutor turn, not two. The turn was reserved before the first attempt, so the retry
    // rewrote the same row rather than appending another.
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(1)
    await expect(page.getByTestId('turn-0')).toContainText('adds up three numbers')
  })

  test('retrying repeatedly never duplicates the reply', async ({ page }) => {
    await arrive(page, 'flaky: retry never duplicates')
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('retry-reply')).toBeVisible()

    await page.getByTestId('retry-reply').click()
    await expect(page.getByTestId('session-status')).toHaveText('')
    await page.reload()

    await expect(page.getByTestId('turns').locator('li')).toHaveCount(1)
  })

  test('keeps the learner’s message when the tutor’s reply fails', async ({ page }) => {
    await arrive(page, 'flaky: message survives failure')
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('retry-reply')).toBeVisible()
    await page.getByTestId('retry-reply').click()
    await expect(page.getByTestId('session-status')).toHaveText('')

    // The second prose turn is a fresh strategy, so it fails on its first attempt too.
    await page.getByTestId('reply-input').fill('Does the order matter?')
    await page.getByTestId('send-reply').click()

    await expect(page.getByTestId('turn-1')).toContainText('Does the order matter?')
    await expect(page.getByTestId('session-status')).toContainText('Nothing you wrote has been lost')

    await page.getByTestId('retry-reply').click()
    await expect(page.getByTestId('session-status')).toHaveText('')
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(3)
  })
})

/*
 * No tutor configured at all. Not a failure to retry around — there is nothing to retry
 * against — so the requirement is that nothing is invented and nothing is lost.
 */
test.describe('with no tutor configured', () => {
  test.use({ baseURL: OFFLINE_BASE_URL })

  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('says there is no tutor rather than inventing a lesson', async ({ page }) => {
    await page.getByTestId('start-session').click()
    await expect(page).toHaveURL(/\/session\//)

    await expect(page.getByTestId('session-status')).toContainText('No tutor is configured')
    // The turn is on the page as an empty slot — labelled, so the learner can see where the
    // reply would have gone — but nothing was fabricated and presented as teaching.
    await expect(page.getByTestId('turn-0').locator('p').first()).toHaveText('Tutor')
    await expect(page.getByTestId('turn-0').locator('pre')).toHaveCount(0)
  })

  test('still keeps the learner’s question', async ({ page }) => {
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('session-status')).toContainText('No tutor is configured')

    await page.getByTestId('reply-input').fill('Can you explain this to me?')
    await page.getByTestId('send-reply').click()

    await expect(page.getByTestId('turn-1')).toContainText('Can you explain this to me?')
    await page.reload()
    // Their words survived, even though nothing could answer them.
    await expect(page.getByTestId('turn-1')).toContainText('Can you explain this to me?')
  })

  test('does not claim the learner has learned anything', async ({ page }) => {
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('session-status')).toContainText('No tutor is configured')

    await page.goto('/reset')
    // Evidence comes only from the diagnostic; an unanswered session added none.
    const count = Number(await page.getByTestId('evidence-count').innerText())
    expect(count).toBeGreaterThan(0)

    await page.goto('/home')
    await expect(page.locator('[data-band="secure"]')).toHaveCount(0)
  })
})

/*
 * Narrow screens and the keyboard. Both are requirements in their own right, and both are
 * where a streaming interface tends to come apart.
 */
test.describe('the session at 360px', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('never scrolls sideways, even with a code block in the reply', async ({ page }) => {
    const sideways = async (): Promise<boolean> =>
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )

    expect(await sideways()).toBe(false)

    await startTutoring(page)
    // The opening turn contains a fenced code block, which is the thing that would burst.
    await expect(page.getByTestId('turn-0').locator('pre')).toBeVisible()
    expect(await sideways()).toBe(false)

    await sendToTutor(page, 'A question from a phone.')
    expect(await sideways()).toBe(false)
  })

  test('keeps a long line of code inside its own block', async ({ page }) => {
    await startTutoring(page)

    const overflow = await page
      .getByTestId('turn-0')
      .locator('pre')
      .evaluate((node) => getComputedStyle(node).overflowX)

    expect(overflow).toBe('auto')
  })
})

test.describe('the session with a keyboard alone', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('reaches the essential controls by tabbing', async ({ page }) => {
    await startTutoring(page)

    // Send is disabled while there is nothing to send, and a disabled control is correctly not
    // focusable — so there has to be something in the box before it can be reached.
    await page.getByTestId('reply-input').fill('Something to send.')

    const reachable: string[] = []
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.press('Tab')
      const id = await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? '',
      )
      if (id !== '') reachable.push(id)
    }

    expect(reachable, reachable.join(' > ')).toContain('reply-input')
    expect(reachable, reachable.join(' > ')).toContain('send-reply')
    expect(reachable, reachable.join(' > ')).toContain('finish-session')
  })

  test('sends with Enter and breaks the line with Shift+Enter', async ({ page }) => {
    await startTutoring(page)

    const input = page.getByTestId('reply-input')
    await input.click()

    // Shift+Enter must not send: losing a half-written thought to a stray Enter is the reason
    // the behaviour is spelled out in the help text beside the box.
    await input.pressSequentially('first line')
    await page.keyboard.press('Shift+Enter')
    await input.pressSequentially('second line')
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(1)
    await expect(input).toHaveValue('first line\nsecond line')

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(3)
    await expect(page.getByTestId('turn-1')).toContainText('second line')
  })

  test('does not move focus when the reply streams in', async ({ page }) => {
    await startTutoring(page)

    await page.getByTestId('reply-input').click()
    await expect(page.getByTestId('reply-input')).toBeFocused()

    await page.getByTestId('reply-input').fill('Keep my place, please.')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('session-status')).toHaveText('')

    // Streamed content must not steal focus. After the reply lands the learner is back in the
    // box they were typing in, ready to ask the next thing.
    await expect(page.getByTestId('reply-input')).toBeFocused()
  })

  test('describes the reply box properly', async ({ page }) => {
    await startTutoring(page)

    const input = page.getByTestId('reply-input')
    await expect(input).toHaveAccessibleName(/Reply, or ask about this/)
    await expect(input).toHaveAccessibleDescription(/Shift \+ Enter for a new line/)
  })
})
