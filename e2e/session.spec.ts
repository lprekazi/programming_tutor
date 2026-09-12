import { expect, test } from '@playwright/test'

import { evidenceCount, reachHome, resetEverything, sendToTutor, startTutoring } from './helpers'

/**
 * A tutoring session, end to end.
 *
 * The journeys are the ones a learner takes; the failures are the ones that would make them
 * stop using it. Losing the conversation, being answered twice, being told mastery they have
 * not earned, or reaching a dead end when the tutor cannot be reached.
 *
 * Nothing here waits on a timer. Every wait is on something the page publishes — a turn
 * appearing, the status region hiding itself — because a test that sleeps for streaming passes
 * on a fast machine and fails on a slow one, and tells you nothing either way.
 */

const GOAL = 'Understand how programs run'

test.describe('a tutoring session', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('takes the learner from their profile into a real lesson', async ({ page }) => {
    // Home offers one thing to do, with the scheduler's reason beside it.
    await expect(page.getByTestId('next-concept')).not.toBeEmpty()
    await expect(page.getByTestId('next-reason')).not.toBeEmpty()
    await expect(page.getByTestId('start-session')).toHaveText('Start learning')

    await startTutoring(page)

    // An opening teaching turn, from the tutor, without the learner having said anything.
    const opening = page.getByTestId('turn-0')
    await expect(opening).toHaveAttribute('data-role', 'tutor')
    await expect(opening).not.toBeEmpty()

    // And the session says why this concept, in the scheduler's own words.
    await expect(page.getByTestId('session-reason')).not.toBeEmpty()
  })

  test('formats the tutor’s teaching rather than dumping a wall of text', async ({ page }) => {
    await startTutoring(page)

    const opening = page.getByTestId('turn-0')
    // A fenced code block became a real code element, and inline code inside prose did too.
    await expect(opening.locator('pre code')).toContainText('for n in [2, 3, 4]')
    await expect(opening.locator('p code')).toContainText('total')
    // The authoring syntax itself never reaches the learner.
    await expect(opening).not.toContainText('```')
  })

  test('answers what the learner asks, and keeps both sides of the exchange', async ({ page }) => {
    await startTutoring(page)
    await sendToTutor(page, 'Why does total not reset each time round?')

    await expect(page.getByTestId('turn-1')).toHaveAttribute('data-role', 'learner')
    await expect(page.getByTestId('turn-1')).toContainText('Why does total not reset')
    await expect(page.getByTestId('turn-2')).toHaveAttribute('data-role', 'tutor')
    await expect(page.getByTestId('turn-2')).not.toBeEmpty()
  })

  test('follow-up questions continue the same conversation', async ({ page }) => {
    await startTutoring(page)
    await sendToTutor(page, 'First question about this.')
    await sendToTutor(page, 'And a follow-up.')

    await expect(page.getByTestId('turns').locator('li')).toHaveCount(5)
    await expect(page.getByTestId('turn-3')).toContainText('And a follow-up.')
  })

  /*
   * The continuity requirement. Everything on the page comes from the database, so this is
   * really a test that nothing important is being kept in the browser.
   */
  test('resumes the conversation after a reload', async ({ page }) => {
    await startTutoring(page)
    await sendToTutor(page, 'Why does that work?')

    const url = page.url()
    await page.reload()

    await expect(page.getByTestId('turns').locator('li')).toHaveCount(3)
    await expect(page.getByTestId('turn-1')).toContainText('Why does that work?')

    // And after leaving the page entirely, as closing the application would.
    await page.goto('about:blank')
    await page.goto(url)
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(3)
  })

  test('offers Continue from Home rather than starting a second conversation', async ({ page }) => {
    await startTutoring(page)
    await sendToTutor(page, 'A question.')

    await page.goto('/home')
    await expect(page.getByTestId('start-session')).toHaveText('Continue')

    await page.getByTestId('start-session').click()
    await expect(page).toHaveURL(/\/session\//)
    // The same conversation, not a fresh one.
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(3)
  })

  /*
   * Pressing Start twice, and the two-tabs case. The database guarantees it — the session is
   * unique on (learner, concept) and the opening turn is reserved at ordinal zero — but the
   * point of testing it here is that the guarantee holds through the whole stack.
   */
  test('starting twice does not produce two conversations', async ({ page }) => {
    await startTutoring(page)
    const first = page.url()

    await page.goto('/home')
    await page.getByTestId('start-session').click()
    await expect(page).toHaveURL(/\/session\//)

    expect(page.url()).toBe(first)
    await expect(page.getByTestId('turn-0')).toBeVisible()
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(1)
  })

  test('double-clicking Send does not send twice', async ({ page }) => {
    await startTutoring(page)

    await page.getByTestId('reply-input').fill('Only once, please.')
    // Actually double-clicked, rather than asserting that the button disables itself and
    // trusting that to be enough.
    await page.getByTestId('send-reply').dblclick()

    await expect(page.getByTestId('turns').locator('li')).toHaveCount(3)
    await page.reload()
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(3)
    await expect(page.getByTestId('turn-1')).toContainText('Only once, please.')
  })

  /*
   * The streaming endpoint writes model output into whichever turn its URL names, so what it
   * refuses matters as much as what it does. Posting a learner turn's id used to overwrite the
   * learner's own message with a model reply — under their name, and quoted back to the model
   * on the next turn as something they had said.
   */
  test('the streaming endpoint refuses any turn but the one awaiting a reply', async ({ page }) => {
    await startTutoring(page)
    await sendToTutor(page, 'This is mine and must stay mine.')

    const ids = await page.getByTestId('turns').locator('li').evaluateAll((nodes) =>
      nodes.map((node) => ({
        role: node.getAttribute('data-role') ?? '',
        id: node.getAttribute('data-turn-id') ?? '',
      })),
    )

    const learnerTurn = ids.find((turn) => turn.role === 'learner')
    const tutorTurn = ids.find((turn) => turn.role === 'tutor')
    expect(learnerTurn?.id).toBeTruthy()
    expect(tutorTurn?.id).toBeTruthy()

    const statuses = await page.evaluate(async (targets) => {
      const results: number[] = []
      for (const id of targets) {
        const response = await fetch(`/api/tutor/${id}`, { method: 'POST' })
        results.push(response.status)
      }
      return results
    }, [learnerTurn?.id ?? '', tutorTurn?.id ?? '', 'not-a-real-turn-id'])

    // A learner turn and an already-finished tutor turn are both refused; an unknown id is not
    // found. None of them streams anything.
    expect(statuses).toEqual([409, 409, 404])

    await page.reload()
    await expect(page.getByTestId('turn-1')).toContainText('This is mine and must stay mine.')
    await expect(page.getByTestId('turn-1')).toHaveAttribute('data-role', 'learner')
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(3)
  })

  test('will not send an empty message', async ({ page }) => {
    await startTutoring(page)

    await expect(page.getByTestId('send-reply')).toBeDisabled()
    await page.getByTestId('reply-input').fill('   ')
    await expect(page.getByTestId('send-reply')).toBeDisabled()
  })

  /*
   * The rule the whole design rests on. A learner who reads an explanation, asks questions and
   * says "that makes sense" has demonstrated nothing, and their standing must not move.
   */
  test('talking to the tutor does not change what the tutor claims they know', async ({ page }) => {
    const before = await evidenceCount(page)

    await page.goto('/home')
    const bandsBefore = await page.locator('[data-band]').evaluateAll((nodes) =>
      nodes.map((node) => `${node.getAttribute('data-testid') ?? ''}:${node.getAttribute('data-band') ?? ''}`),
    )

    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('turn-0')).toBeVisible()
    await sendToTutor(page, 'That makes sense now, I completely understand it.')
    await sendToTutor(page, 'Yes, I have definitely mastered this.')

    expect(await evidenceCount(page)).toBe(before)

    await page.goto('/home')
    const bandsAfter = await page.locator('[data-band]').evaluateAll((nodes) =>
      nodes.map((node) => `${node.getAttribute('data-testid') ?? ''}:${node.getAttribute('data-band') ?? ''}`),
    )

    expect(bandsAfter).toEqual(bandsBefore)
  })

  test('says when it is running against a fixed script rather than a real tutor', async ({
    page,
  }) => {
    await startTutoring(page)
    // Presenting a demo script as a tutor would be the application lying about the one thing
    // it exists to do.
    await expect(page.getByTestId('mock-notice')).toContainText('fixed demo script')
  })

  test('leaving the session keeps it, and Home stops pressing it', async ({ page }) => {
    await startTutoring(page)
    await sendToTutor(page, 'A question.')

    await page.getByTestId('finish-session').click()
    await expect(page).toHaveURL(/\/home$/)
    await expect(page.getByTestId('start-session')).toHaveText('Start learning')
  })
})

/*
 * Why this concept. The disclosure must reflect the scheduler's real grounds, not plausible
 * prose written beside it — which is why the grounds are generated from the reason and
 * asserted against a learner whose situation is known.
 */
test.describe('why this concept', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('is closed until asked for, then gives the real grounds', async ({ page }) => {
    await expect(page.getByTestId('why-this-grounds')).toBeHidden()

    await page.getByTestId('why-this').click()
    const grounds = page.getByTestId('why-this-grounds')
    await expect(grounds).toBeVisible()

    // Every selection rests on its prerequisites being met, by construction.
    await expect(grounds).toContainText('in place')

    /*
     * The correspondence check, rather than a guess at which reason will apply. Whichever
     * concept the scheduler picked, the grounds must agree with the band shown for that same
     * concept further down the page — an untouched concept cannot be described as one the
     * learner has made a start on, and vice versa.
     */
    const conceptId = await page.getByTestId('next-concept').getAttribute('data-concept')
    const band = await page.getByTestId(`band-${conceptId ?? ''}`).innerText()
    const text = await grounds.innerText()

    if (band === 'Not started') {
      expect(text, band).toContain('You have not worked on this yet.')
      expect(text, band).not.toContain('answer you have given')
    } else {
      expect(text, band).not.toContain('You have not worked on this yet.')
      expect(text, band).toMatch(/answers? you have given/)
    }
  })

  test('exposes no estimate or internal number', async ({ page }) => {
    await page.getByTestId('why-this').click()
    const text = await page.getByTestId('why-this-grounds').innerText()

    expect(text).not.toMatch(/theta|logit|uncertainty/i)
    expect(text).not.toMatch(/0\.\d/)
  })
})
