import { expect, test, type Locator, type Page } from '@playwright/test'

import { OFFLINE_BASE_URL } from '../playwright.config'
import { PRACTICE_ITEMS_BY_ID } from '../src/domain/assessment/items'

import {
  answerCurrent,
  completeOnboarding,
  currentItemId,
  evidenceCount,
  reachHome,
  resetEverything,
  sendToTutor,
  startTutoring,
} from './helpers'

/**
 * Checking understanding inside a session, end to end.
 *
 * The journeys a learner takes, and the failures that would matter: being marked wrong for an
 * answer that works, being told nothing useful about why, having one answer counted twice, or
 * having their standing moved by something they never demonstrated.
 *
 * The correct answers come from the real bank rather than a copy kept here, so a question whose
 * answer changes does not quietly turn these into tests of a learner getting everything wrong.
 */

const GOAL = 'Understand how programs run'

/** Gets a check on screen, holding off until the selector agrees it is a moment for one. */
async function reachCheck(page: Page): Promise<void> {
  await startTutoring(page)
  // One exchange first: the selector holds off before any teaching has happened, which is
  // itself asserted below.
  await sendToTutor(page, 'I think I follow, but I am not sure.')

  await page.getByTestId('ask-check').click()
  await expect(page.getByTestId('check')).toBeVisible()
}

/** The correct answer for whatever check is on screen, read from the bank. */
async function answerCorrectly(page: Page): Promise<void> {
  const check = page.getByTestId('check').last()
  const options = await check.getByTestId(/^check-option-/).count()

  if (options > 0) {
    const labels = await check.locator('label').allInnerTexts()
    const item = [...PRACTICE_ITEMS_BY_ID.values()].find(
      (candidate) =>
        candidate.kind === 'choice' &&
        candidate.options.every((option) => labels.some((label) => label.includes(option))),
    )
    if (item === undefined || item.kind !== 'choice') throw new Error('unrecognised question')

    // The options were shuffled when the question was asked, so the right one is found by its
    // text rather than by the index the bank happens to store.
    const correct = item.options[item.correctIndex] ?? ''
    const index = labels.findIndex((label) => label.includes(correct))
    await check.getByTestId(`check-option-${String(index)}`).check()
  } else {
    const prompt = await check.getByTestId('check-prompt').innerText()
    const code = await check.getByTestId('check-code').innerText()
    const item = [...PRACTICE_ITEMS_BY_ID.values()].find(
      (candidate) => candidate.prompt === prompt && (candidate.code ?? '') === code,
    )
    if (item === undefined || item.kind !== 'predict-output') throw new Error('unrecognised question')
    await check.getByTestId('check-input').fill(item.expectedOutput)
  }

  await check.getByTestId('check-submit').click()
  // The region itself is always in the document — a live region has to be, or its first
  // message is not announced — so the heading is what says an answer has been marked.
  await expect(check.getByTestId('check-verdict-heading')).toBeVisible()
}

/** Asks for a check and returns the one that arrives, so several can be answered in a row. */
async function askForCheck(page: Page): Promise<Locator> {
  const before = await page.getByTestId('check').count()

  await page.getByTestId('ask-check').click()
  await expect(page.getByTestId('check')).toHaveCount(before + 1)

  return page.getByTestId('check').last()
}

/**
 * A learner whose one recorded mistake is about `return` versus `print`.
 *
 * Written answers are the only questions a model reads, and the tutor asks one only when it
 * has a reason to — it probes a wrong idea it has actually seen. So the route to a written
 * question is a learner who has shown that idea, which is the route a real learner takes
 * rather than a switch these tests flip.
 */
async function reachHomeShowingReturnVsPrint(page: Page): Promise<void> {
  await completeOnboarding(page, { goal: GOAL, experience: 'some-python' })

  for (let guard = 0; guard < 20; guard += 1) {
    if (await page.getByTestId('finish-diagnostic').isVisible()) break

    // Everything right except the one item whose distractors say a printed value is returned.
    await answerCurrent(page, (await currentItemId(page)) !== 'return-vs-print')
    await page.getByTestId('next-item').click()
    await expect(page.getByTestId('next-item')).toBeHidden()
  }

  await page.getByTestId('finish-diagnostic').click()
  await expect(page).toHaveURL(/\/home$/)
}

/**
 * Works through checks until the written one arrives.
 *
 * Two items probe that idea: a multiple choice first, then the one that asks for a sentence.
 * Answering the first correctly is deliberate — it leaves the wrong idea as the most recent
 * thing worth probing without adding a second one.
 */
async function reachWrittenCheck(
  page: Page,
  say: (text: string) => Promise<void>,
): Promise<Locator> {
  await askForCheck(page)
  await answerCorrectly(page)
  await say('That makes sense now.')

  const written = await askForCheck(page)
  await expect(written.getByTestId('check-prompt')).toContainText('In your own words')
  await expect(written.getByTestId('check-input')).toBeVisible()

  return written
}

/** Opens a session where no reply can arrive, and waits for the page to say so. */
async function openSessionWithNoTutor(page: Page): Promise<void> {
  await page.getByTestId('start-session').click()
  await expect(page).toHaveURL(/\/session\//)
  await expect(page.getByTestId('session-status')).toContainText('No tutor is configured')
}

/** Says something where nothing can answer. The learner's own words still land. */
async function sayWithNoTutor(page: Page, text: string): Promise<void> {
  await page.getByTestId('reply-input').fill(text)
  await page.getByTestId('send-reply').click()

  // Their words are kept, and the page says plainly that nothing will answer them. The empty
  // slot where a reply would have gone stays on the page rather than being hidden.
  await expect(page.getByTestId('turns')).toContainText(text)
  await expect(page.getByTestId('session-status')).toContainText('No tutor is configured')
}

test.describe('checking understanding', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('holds off until there is something to check, and says why', async ({ page }) => {
    await startTutoring(page)

    await page.getByTestId('ask-check').click()
    // Not a silent no-op: the reason the scheduler gave, in words.
    await expect(page.getByTestId('session-status')).toContainText('Read a little more first')
    await expect(page.getByTestId('check')).toHaveCount(0)
  })

  test('asks a question inside the lesson, with the reason it is asking', async ({ page }) => {
    await reachCheck(page)

    const check = page.getByTestId('check')
    await expect(check.getByTestId('check-prompt')).not.toBeEmpty()
    await expect(check.getByTestId('check-ground')).not.toBeEmpty()

    // Part of the conversation, not a separate page.
    await expect(page).toHaveURL(/\/session\//)
    await expect(page.getByTestId('turns').locator('li[data-role="activity"]')).toHaveCount(1)
  })

  test('a correct answer is acknowledged and produces attributable evidence', async ({ page }) => {
    const before = await evidenceCount(page)
    await page.goto('/home')
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('turn-0')).toBeVisible()
    await sendToTutor(page, 'Following so far.')
    await page.getByTestId('ask-check').click()
    await expect(page.getByTestId('check')).toBeVisible()

    await answerCorrectly(page)

    await expect(page.getByTestId('check-verdict-heading')).toHaveText('Right')
    await expect(page.getByTestId('check-attribution')).toContainText(
      'This helps the tutor decide what to practise next',
    )

    expect(await evidenceCount(page)).toBe(before + 1)
  })

  /*
   * The feedback requirement: the learner should understand both what was wrong and what to
   * think about differently. "Incorrect. Try again." is named in the brief as what to avoid.
   */
  test('a wrong answer gets a specific explanation, not a bare verdict', async ({ page }) => {
    await reachCheck(page)

    const check = page.getByTestId('check')
    const options = await check.getByTestId(/^check-option-/).count()

    if (options > 0) {
      await check.getByTestId('check-option-0').check()
    } else {
      await check.getByTestId('check-input').fill('something plainly wrong')
    }
    await check.getByTestId('check-submit').click()

    const verdict = check.getByTestId('check-verdict')
    await expect(check.getByTestId('check-verdict-heading')).toBeVisible()

    const text = await verdict.innerText()
    expect(text).not.toBe('Not right')
    expect(text.length).toBeGreaterThan(80)
    expect(text).not.toMatch(/^Incorrect\. Try again\.$/)
  })

  test('a recognised wrong answer names the idea behind it', async ({ page }) => {
    await reachCheck(page)

    const check = page.getByTestId('check')
    const prompt = await check.getByTestId('check-prompt').innerText()
    const code = await check.getByTestId('check-code').innerText()
    const item = [...PRACTICE_ITEMS_BY_ID.values()].find(
      (candidate) => candidate.prompt === prompt && (candidate.code ?? '') === code,
    )

    test.skip(item?.kind !== 'predict-output', 'this check is not an output prediction')
    if (item?.kind !== 'predict-output') return

    const known = item.knownWrongAnswers[0]
    test.skip(known === undefined, 'this item recognises no particular wrong answer')
    if (known === undefined) return

    await check.getByTestId('check-input').fill(known.answer)
    await check.getByTestId('check-submit').click()

    // The feedback states the belief the answer fits and what is actually true — composed from
    // the catalogue, so it cannot contradict the marking.
    await expect(check.getByTestId('check-verdict')).toContainText('That answer fits the idea that')
  })

  /*
   * The core rule, through the interface. One answer, one change.
   */
  test('answering twice does not count twice', async ({ page }) => {
    const before = await evidenceCount(page)
    await page.goto('/home')
    await page.getByTestId('start-session').click()
    await expect(page.getByTestId('turn-0')).toBeVisible()
    await sendToTutor(page, 'Following so far.')
    await page.getByTestId('ask-check').click()
    await expect(page.getByTestId('check')).toBeVisible()

    const check = page.getByTestId('check')
    const options = await check.getByTestId(/^check-option-/).count()
    if (options > 0) await check.getByTestId('check-option-0').check()
    else await check.getByTestId('check-input').fill('an answer')

    // Actually clicked twice, rather than trusting the button to disable itself.
    await check.getByTestId('check-submit').dblclick()
    await expect(check.getByTestId('check-verdict-heading')).toBeVisible()

    expect(await evidenceCount(page)).toBe(before + 1)

    await page.goBack()
    await page.reload()
    expect(await evidenceCount(page)).toBe(before + 1)
  })

  test('the question and its answer survive a reload', async ({ page }) => {
    await reachCheck(page)

    const prompt = await page.getByTestId('check-prompt').innerText()
    await page.reload()

    // The question is still there, unanswered, and the same question. The verdict region is
    // in the document from the start so its first message is announced; what says nothing has
    // been marked is that it holds no verdict.
    await expect(page.getByTestId('check-prompt')).toHaveText(prompt)
    await expect(page.getByTestId('check-verdict-heading')).toHaveCount(0)

    await answerCorrectly(page)
    const feedback = await page.getByTestId('check-verdict').innerText()

    await page.reload()
    // The same words, not a regenerated approximation.
    await expect(page.getByTestId('check-verdict')).toContainText(feedback.split('\n')[1] ?? '')
  })

  test('the options are not shown in the order they were written', async ({ page }) => {
    /*
     * What is asserted, and why it is this rather than "the position varied".
     *
     * The property that matters is that the order on the page is not the authored order, since
     * the authored order is the one an author can fall into a habit with and the one a
     * generator can settle on. Asserting instead that the correct answer *moved between draws*
     * reads better and is a coin flip: with four options, several draws can legitimately agree,
     * and a test that fails a few times in a hundred for no reason is worse than no test.
     *
     * The version this replaces asserted `positions.size > 0` inside `if (positions.size > 0)`,
     * which is true whenever it runs at all — it advertised coverage it did not provide. The
     * per-activity spread is asserted properly in `marking.test.ts`, where it can be done
     * exhaustively and deterministically.
     */
    let sawAChoice = false
    let sawAShuffle = false

    for (let round = 0; round < 4 && !sawAShuffle; round += 1) {
      await resetEverything(page)
      // This learner is asked a multiple choice first, deterministically: they got one
      // diagnostic question wrong, and the item that probes that idea is a choice.
      await reachHomeShowingReturnVsPrint(page)
      await reachCheck(page)

      const check = page.getByTestId('check')
      if ((await check.getByTestId(/^check-option-/).count()) === 0) continue

      const labels = await check.locator('label').allInnerTexts()
      const item = [...PRACTICE_ITEMS_BY_ID.values()].find(
        (candidate) =>
          candidate.kind === 'choice' &&
          candidate.options.every((option) => labels.some((label) => label.includes(option))),
      )
      if (item?.kind !== 'choice') continue

      sawAChoice = true
      const shown = item.options.map((option) =>
        labels.findIndex((label) => label.includes(option)),
      )
      // The identity permutation is one of 24, so a handful of draws all landing on it is not
      // something that happens by chance.
      if (shown.some((position, index) => position !== index)) sawAShuffle = true
    }

    expect(sawAChoice, 'no multiple choice was ever asked').toBe(true)
    expect(sawAShuffle, 'every draw showed the options in the order they were authored').toBe(true)
  })

  test('the profile shows what the answer did, with its reason', async ({ page }) => {
    await reachCheck(page)
    await answerCorrectly(page)
    await page.goto('/home')

    // At least one concept now has a dated evidence entry with the domain's own reason.
    const disclosure = page.getByTestId(/^history-/).first()
    await expect(disclosure).toBeVisible()
    await disclosure.click()

    const log = page.getByTestId(/^evidence-/).first()
    await expect(log).toBeVisible()
    await expect(log).toContainText('question on')
    // No raw estimate, and no invented percentage.
    const text = await log.innerText()
    expect(text).not.toMatch(/theta|\d+%/)
  })

  test('a nudge is offered, counts as support, and never counts against', async ({ page }) => {
    await reachCheck(page)

    const check = page.getByTestId('check')
    await check.getByTestId('check-hint-ask').click()
    await expect(check.getByTestId('check-hint')).toBeVisible()

    await answerCorrectly(page)

    await expect(check.getByTestId('check-verdict-heading')).toHaveText('Right')
    await expect(check.getByTestId('check-attribution')).toContainText('never against you')
  })

  test('keeps the check inside the academic layout, with no quiz styling', async ({ page }) => {
    await reachCheck(page)

    // No score, no streak, no badge, no percentage anywhere on the page.
    const body = await page.locator('body').innerText()
    expect(body).not.toMatch(/\b\d+\s*\/\s*\d+\b|\bstreak\b|\bpoints?\b|\bscore\b|\bbadge\b/i)

    // Nothing animated, and no images.
    const animated = await page.evaluate(
      () =>
        [...document.querySelectorAll('*')].filter(
          (node) => getComputedStyle(node).animationName !== 'none',
        ).length,
    )
    expect(animated).toBe(0)
    expect(await page.locator('img, svg').count()).toBe(0)
  })
})

/*
 * A written answer — the only kind a model reads. Everything else is marked against the item's
 * own answer, so this is the one path where a judgement, rather than a fact, becomes evidence.
 */
test.describe('a written answer', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHomeShowingReturnVsPrint(page)
  })

  test('is read by the tutor, and recorded as a judgement rather than a fact', async ({ page }) => {
    const before = await evidenceCount(page)
    await page.goto('/home')

    await startTutoring(page)
    await sendToTutor(page, 'I want to be sure I have this right.')

    const written = await reachWrittenCheck(page, (text) => sendToTutor(page, text))
    await written
      .getByTestId('check-input')
      .fill(
        'print puts the value on the screen for me to read. return hands it back to whatever called the function, so it can be stored — here nothing is returned, so result is None.',
      )
    await written.getByTestId('check-submit').click()

    await expect(written.getByTestId('check-verdict')).toBeVisible()
    // Said plainly, because a judgement is not the same kind of thing as a marked answer.
    await expect(written.getByTestId('check-attribution')).toContainText(
      'Read and marked by the tutor',
    )
    await expect(written.getByTestId('check-attribution')).toContainText(
      'A judgement, not a fixed answer',
    )

    // Two answers, two pieces of evidence: the multiple choice and this one.
    expect(await evidenceCount(page)).toBe(before + 2)
  })
})

/*
 * No tutor configured. Deterministic questions still work, because they never needed one; a
 * written answer cannot be marked at all, and the requirement is that the attempt survives
 * while the learner's standing does not move.
 */
test.describe('a check that cannot be marked', () => {
  test.use({ baseURL: OFFLINE_BASE_URL })

  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHomeShowingReturnVsPrint(page)
  })

  test('still asks deterministic questions, because they need no tutor', async ({ page }) => {
    const before = await evidenceCount(page)
    await page.goto('/home')

    await openSessionWithNoTutor(page)
    await sayWithNoTutor(page, 'Can you check whether I have this right?')

    const check = await askForCheck(page)
    await expect(check.getByTestId('check-prompt')).not.toBeEmpty()

    await answerCorrectly(page)

    await expect(check.getByTestId('check-verdict-heading')).toHaveText('Right')
    await expect(check.getByTestId('check-attribution')).toContainText(
      'Marked against the expected answer',
    )
    // Assessment does not depend on the tutor being reachable.
    expect(await evidenceCount(page)).toBe(before + 1)
  })

  test('leaves mastery untouched when nothing could be marked', async ({ page }) => {
    await openSessionWithNoTutor(page)
    await sayWithNoTutor(page, 'Can you check whether I have this right?')

    const written = await reachWrittenCheck(page, (text) => sayWithNoTutor(page, text))
    const session = page.url()

    // Counted after the multiple choice, so what follows is measured against the written
    // answer alone.
    const before = await evidenceCount(page)
    await page.goto('/home')
    const bandsBefore = await page
      .locator('[data-band]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-band')))

    await page.goto(session)
    await written
      .getByTestId('check-input')
      .fill('return hands the value back to the caller; print only shows it.')
    await written.getByTestId('check-submit').click()

    // Kept and shown, and honest about what it is worth.
    await expect(written.getByTestId('check-verdict-heading')).toHaveText('Not marked')
    await expect(written.getByTestId('check-verdict')).toContainText('No tutor is configured')
    await expect(written.getByTestId('check-attribution')).toContainText(
      'has not changed what the tutor thinks you know',
    )

    expect(await evidenceCount(page)).toBe(before)

    await page.goto('/home')
    const bandsAfter = await page
      .locator('[data-band]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-band')))

    expect(bandsAfter).toEqual(bandsBefore)
  })
})

test.describe('a check at 360px', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('fits, and its controls are big enough to hit', async ({ page }) => {
    await reachCheck(page)

    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(sideways).toBe(false)

    for (const option of await page
      .getByTestId('check')
      .locator('label')
      .filter({ has: page.getByRole('radio') })
      .all()) {
      const box = await option.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24)
    }

    await answerCorrectly(page)
    const stillFits = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(stillFits).toBe(false)
  })
})

test.describe('a check with a keyboard alone', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('reaches the answer controls by tabbing, and labels them', async ({ page }) => {
    await reachCheck(page)

    const check = page.getByTestId('check')
    const options = await check.getByTestId(/^check-option-/).count()

    if (options > 0) {
      // The group is named, and each option carries its own text as its accessible name.
      await expect(check.getByRole('radiogroup')).toBeVisible()
      await expect(check.getByRole('radio').first()).toBeEnabled()
    } else {
      const input = check.getByTestId('check-input')
      await expect(input).toHaveAccessibleName(/What it prints|Your answer/)
      await expect(input).toHaveAccessibleDescription(/.+/)
    }

    const reachable: string[] = []
    for (let step = 0; step < 25; step += 1) {
      await page.keyboard.press('Tab')
      const id = await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? '',
      )
      if (id !== '') reachable.push(id)
    }

    expect(reachable, reachable.join(' > ')).toContain('check-submit')
  })
})
