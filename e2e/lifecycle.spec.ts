import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { expect, test, type Page } from '@playwright/test'

import { RESTARTED_BASE_URL, RESTARTED_PORT } from '../playwright.config'
import { RESET_CONFIRMATION } from '../app/reset/confirmation'
import type { ConceptId } from '../src/domain/curriculum/types'
import { initialConceptState, type ConceptState } from '../src/domain/learner-model/state'
import { availableConcepts, stateLookupFrom } from '../src/domain/scheduling/select'

import { answerCheckCorrectly, reachHome, resetEverything, sendToTutor } from './helpers'

/**
 * Coming back tomorrow: continuing, reviewing, restarting, exporting and deleting.
 *
 * Two things here are not ordinary page interactions, and both are deliberate.
 *
 * **Time.** Review intervals are measured in days, so the passage of time is simulated by
 * moving a stored review date into the past, directly in the database file the server is
 * using. Nothing else is touched, and the scheduling arithmetic itself runs for real.
 *
 * **Restarting.** Playwright cannot restart the server it manages, so one test starts a second
 * application process of its own over the same database file, asks it what the learner did, and
 * stops it again. Anything still visible through it came off disk rather than out of the first
 * process's memory.
 */

const GOAL = 'Understand how programs run'
const DATABASE = 'data/e2e.db'
const DAY = 86_400_000

/** The database the main server is using, opened read/write for the two things above. */
function database(): Database.Database {
  return new Database(DATABASE)
}

/**
 * Brings forward the review of a concept the learner has actually been assessed on.
 *
 * Restricted to concepts the scheduler would currently consider — `availableConcepts`, the
 * domain's own rule — because a due concept sitting behind an unmet prerequisite is correctly
 * not recommended, and choosing one would be testing the wrong thing. The rule is imported
 * rather than guessed at, so this cannot drift from what the application does.
 *
 * Returns the concept's id, so the test names what it expects to be offered.
 */
function makeSomethingDue(): string {
  const db = database()

  try {
    const rows = db
      .prepare(
        'SELECT concept_id, theta, uncertainty, evidence_count, successes, unaided_successes, support_signal, last_seen_at, next_review_at FROM concept_state',
      )
      .all() as {
      concept_id: string
      theta: number
      uncertainty: number
      evidence_count: number
      successes: number
      unaided_successes: number
      support_signal: number
      last_seen_at: number | null
      next_review_at: number | null
    }[]

    const states: ConceptState[] = rows.map((row) => ({
      ...initialConceptState(row.concept_id as ConceptId),
      theta: row.theta,
      uncertainty: row.uncertainty,
      evidenceCount: row.evidence_count,
      successes: row.successes,
      unaidedSuccesses: row.unaided_successes,
      supportSignal: row.support_signal,
      lastSeenAt: row.last_seen_at,
      nextReviewAt: row.next_review_at,
    }))

    const lookup = stateLookupFrom(states)
    const candidate = availableConcepts(lookup).find((concept) => {
      const state = lookup(concept.id)
      return state.evidenceCount > 0 && state.nextReviewAt !== null
    })

    if (candidate === undefined) {
      throw new Error('the diagnostic assessed no concept the scheduler would currently offer')
    }

    db.prepare('UPDATE concept_state SET next_review_at = ? WHERE concept_id = ?').run(
      Date.now() - 3 * DAY,
      candidate.id,
    )
    return candidate.id
  } finally {
    db.close()
  }
}

/** Winds every conversation back by `days`, as if the learner had been away that long. */
function lapseEverySession(days: number): void {
  const db = database()
  try {
    const then = Date.now() - days * DAY
    db.prepare('UPDATE tutoring_session SET updated_at = ?, resumed_at = ?').run(then, then)
    db.prepare('UPDATE session_turn SET created_at = ?').run(then)
  } finally {
    db.close()
  }
}

/** Makes one named concept due again. */
function makeDue(conceptId: string): void {
  const db = database()
  try {
    db.prepare('UPDATE concept_state SET next_review_at = ? WHERE concept_id = ?').run(Date.now() - 3 * DAY, conceptId)
  } finally {
    db.close()
  }
}

/** The learner row as stored, to check a reset emptied it rather than merely hid it. */
function learnerRow(): Record<string, unknown> | undefined {
  const db = database()
  try {
    return db.prepare('SELECT * FROM learner').get() as Record<string, unknown> | undefined
  } finally {
    db.close()
  }
}

/** One value straight from the file, for the questions only the file can answer. */
function countRows(table: string): number {
  const db = database()
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

function nextReviewOf(conceptId: string): number | null {
  const db = database()
  try {
    const row = db
      .prepare('SELECT next_review_at AS at FROM concept_state WHERE concept_id = ?')
      .get(conceptId) as { at: number | null } | undefined
    return row?.at ?? null
  } finally {
    db.close()
  }
}

/** Starts whatever Home is recommending and waits for the session to open. */
async function startRecommended(page: Page): Promise<void> {
  await page.getByTestId('start-session').click()
  await expect(page).toHaveURL(/\/session\//)
}

test.describe('coming back to the tutor', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('a learner who was part-way through is offered the conversation they left', async ({ page }) => {
    await startRecommended(page)
    await sendToTutor(page, 'That makes sense so far.')

    await page.goto('/home')

    await expect(page.getByTestId('next-kind')).toHaveText('Still going')
    await expect(page.getByTestId('start-session')).toHaveText('Continue')
    /*
     * A continuation, in its own words. The concept they are part-way through is also what the
     * scheduler would choose, and saying "Starting …" over a Continue button was the mismatch
     * the M7 review found (M3).
     */
    await expect(page.getByTestId('next-reason')).toContainText('where you left off')
    await expect(page.getByTestId('next-reason')).not.toContainText('Starting')

    // And it is the same conversation, not a second one about the same concept.
    await startRecommended(page)
    await expect(page.getByTestId('turns').locator('li[data-role="learner"]')).toHaveCount(1)
  })

  test('a concept that has come due is offered as a review, with the scheduler’s own reason', async ({ page }) => {
    const due = makeSomethingDue()

    await page.goto('/home')

    await expect(page.getByTestId('next-kind')).toHaveText('Due for review')
    await expect(page.getByTestId('next-concept')).toHaveAttribute('data-concept', due)
    await expect(page.getByTestId('start-session')).toHaveText('Start the review')
    await expect(page.getByTestId('next-reason')).toContainText('due for review')

    // The explanation matches the branch that was actually taken.
    await page.getByTestId('why-this').click()
    await expect(page.getByTestId('why-this-grounds')).toContainText('due to be revisited')

    // A review is offered, never insisted on: the scheduler's second choice is under it, so a
    // review that cannot be answered does not keep everything else out of reach (finding M-4).
    await expect(page.getByTestId('next-alternative')).toContainText('The review will still be here')
    const alternative = await page.getByTestId('start-alternative').getAttribute('data-concept')
    expect(alternative).not.toBe(due)
    await page.getByTestId('start-alternative').click()
    await expect(page).toHaveURL(/\/session\//)
    await expect(page.getByTestId('session-mode')).toHaveText('Working on')
  })

  /*
   * M7 fresh review finding H-2. A bookmark, Back, or Home's "still open" list lands on the
   * session page without going through Home's button, and nothing used to start the sitting: a
   * due review reached that way was shown as an ordinary lesson, with no recall and no turn for
   * the tutor to open it.
   */
  test('a review reached by a link, weeks later, is a review', async ({ page }) => {
    const due = makeSomethingDue()
    await page.goto('/home')
    await startRecommended(page)
    await sendToTutor(page, 'I think I remember this one.')
    const session = page.url()
    const turnsBefore = await page.getByTestId('turns').locator('li').count()

    // Three weeks pass without an answer: the sitting lapses, and the concept is still due.
    lapseEverySession(21)
    makeDue(due)

    await page.goto(session)

    await expect(page.getByTestId('session-mode')).toHaveText('Reviewing')
    await expect(page.getByTestId('review-note')).toContainText('recall')
    // The sitting has a turn of its own, which the page streams once it has started it.
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(turnsBefore + 1)
    await expect(page.getByTestId('ask-check')).toHaveText('Start by recalling it')

    // Reloading is the same sitting, not another one.
    await page.reload()
    await expect(page.getByTestId('turns').locator('li')).toHaveCount(turnsBefore + 1)
  })

  test('a review asks the learner to recall it, and opening one records nothing by itself', async ({ page }) => {
    const due = makeSomethingDue()
    const before = nextReviewOf(due)

    await page.goto('/home')
    await startRecommended(page)

    await expect(page.getByTestId('session-mode')).toHaveText('Reviewing')
    await expect(page.getByTestId('review-note')).toContainText('recall')
    await expect(page.getByTestId('ask-check')).toHaveText('Start by recalling it')

    // Opening it is not doing it: nothing has changed about the learner.
    expect(nextReviewOf(due)).toBe(before)

    // The question comes first, with no teaching exchange needed to unlock it.
    await page.getByTestId('ask-check').click()
    await expect(page.getByTestId('check')).toBeVisible()
    await expect(page.getByTestId('check-ground')).toContainText('review')
  })

  test('answering the review schedules the next one, and Home moves on', async ({ page }) => {
    const due = makeSomethingDue()
    const wasDueAt = nextReviewOf(due)

    await page.goto('/home')
    await startRecommended(page)
    await page.getByTestId('ask-check').click()
    await expect(page.getByTestId('check')).toBeVisible()
    await answerCheckCorrectly(page)

    // The scheduler, not the interface, decides when it comes round again.
    const nextDueAt = nextReviewOf(due)
    expect(nextDueAt).not.toBeNull()
    expect(nextDueAt ?? 0).toBeGreaterThan(wasDueAt ?? 0)
    expect(nextDueAt ?? 0).toBeGreaterThan(Date.now())

    await page.goto('/home')
    // Whatever comes next, it is no longer that review.
    await expect(page.getByTestId('next-kind')).not.toHaveText('Due for review')
    await expect(page.getByTestId('due-list')).toHaveCount(0)
  })
})

/*
 * Everything the learner did is in one file, and nothing that matters is in the server's
 * memory. A second application process over the same file is how that is checked from outside.
 *
 * Started here rather than as another `webServer`, and stopped as soon as the test is done: an
 * extra instance running for the whole suite slowed the Pyodide scenarios enough to time them
 * out.
 */
test.describe('a second application process over the same data', () => {
  let second: ChildProcess | null = null

  test.afterAll(() => {
    second?.kill()
    second = null
  })

  test('finds the learner where they left off, with their conversation and their standing', async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: 'Automate my spreadsheets', experience: 'some-python' })
    await startRecommended(page)
    await sendToTutor(page, 'Could you explain that once more?')
    const session = new URL(page.url()).pathname

    // A different server process, started now, reading the file the first one wrote.
    second = await startSecondInstance()
    await page.goto(`${RESTARTED_BASE_URL}${session}`)

    await expect(page.getByTestId('turns').locator('li[data-role="learner"]')).toHaveCount(1)
    await expect(page.getByTestId('turns')).toContainText('Could you explain that once more?')

    await page.goto(`${RESTARTED_BASE_URL}/concepts`)
    await expect(page.getByTestId('learner-goal')).toContainText('Automate my spreadsheets')
    await expect(page.locator('[data-band]').first()).toBeVisible()
  })
})

test.describe('taking a copy of everything', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('downloads the learner’s own data as JSON, with a schema and no answer keys', async ({ page }) => {
    await startRecommended(page)
    await sendToTutor(page, 'Understood, thank you.')

    await page.goto('/settings')
    const started = page.waitForEvent('download')
    await page.getByTestId('export-button').click()
    const download = await started

    expect(download.suggestedFilename()).toMatch(/^programming-tutor-\d{4}-\d{2}-\d{2}\.json$/)
    await expect(page.getByTestId('export-status')).toContainText('Saved')

    const path = await download.path()
    const text = readFileSync(path, 'utf8')
    const parsed = JSON.parse(text) as {
      schema: string
      schemaVersion: number
      learner: { goal: string }
      concepts: unknown[]
      evidence: unknown[]
      sessions: { turns: unknown[] }[]
    }

    expect(parsed.schema).toBe('programming-tutor-learner-export')
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.learner.goal).toBe(GOAL)
    expect(parsed.concepts.length).toBeGreaterThan(30)
    expect(parsed.evidence.length).toBeGreaterThan(0)
    expect(parsed.sessions[0]?.turns.length).toBeGreaterThan(0)

    // The exclusions, checked on the actual file a learner would open.
    expect(text).not.toContain('correctIndex')
    expect(text).not.toContain('referenceSolution')
    expect(text).not.toContain('expectedOutput')
    expect(text.toLowerCase()).not.toContain('openai')
  })
})

test.describe('deleting everything', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('takes a mature profile back to the first run, and leaves nothing behind', async ({ page }) => {
    await startRecommended(page)
    await sendToTutor(page, 'One more question about this.')
    expect(countRows('evidence')).toBeGreaterThan(0)

    await page.goto('/settings')
    // The word has to be typed exactly; something close is refused, and deletes nothing.
    await page.getByTestId('reset-confirmation').fill('reset please')
    await page.getByTestId('reset-confirm').click()
    await expect(page.getByTestId('reset-error')).toBeVisible()
    expect(countRows('learner')).toBe(1)

    await page.getByTestId('reset-confirmation').fill(RESET_CONFIRMATION)
    await page.getByTestId('reset-confirm').click()

    await expect(page.getByTestId('goal-input')).toBeVisible()
    /*
     * Everything the learner did is gone. The `learner` row itself is not asserted empty: the
     * first page after the deletion is onboarding, and rendering it creates the empty row that
     * a first run starts from. What matters is that it carries nothing.
     */
    for (const table of ['evidence', 'tutoring_session', 'session_turn', 'concept_state', 'session_activity']) {
      expect([table, countRows(table)]).toEqual([table, 0])
    }
    expect(learnerRow()).toMatchObject({ goal: null, experience: null, onboarding_completed_at: null })

    // Every route leads back to the first run rather than to a half-empty profile.
    await page.goto('/home')
    await expect(page).toHaveURL(/\/welcome$/)
  })

  test('cannot be undone by a tab that was open when it happened', async ({ browser, page }) => {
    await startRecommended(page)
    await page.goto('/home')

    // A second tab, rendered against the data that is about to be deleted.
    const stale = await browser.newPage()
    await stale.goto(`${new URL(page.url()).origin}/home`)
    await expect(stale.getByTestId('start-session')).toBeVisible()

    await page.goto('/settings')
    await page.getByTestId('reset-confirmation').fill(RESET_CONFIRMATION)
    await page.getByTestId('reset-confirm').click()
    await expect(page.getByTestId('goal-input')).toBeVisible()

    // The stale tab still looks alive. Pressing its button must not put anything back.
    await stale.getByTestId('start-session').click()
    await expect(stale.getByTestId('next-problem')).toContainText('before the data was deleted')
    expect(countRows('tutoring_session')).toBe(0)
    expect(countRows('learner')).toBe(1)

    await stale.close()
  })
})

test.describe('at 360px', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('the landing page, a review and the data page all fit', async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
    makeSomethingDue()

    await page.goto('/home')
    expect(await scrollsSideways(page)).toBe(false)
    await expect(page.getByTestId('next-kind')).toBeVisible()
    expect(await hitTarget(page, 'start-session')).toBeGreaterThanOrEqual(40)

    await startRecommended(page)
    expect(await scrollsSideways(page)).toBe(false)
    await expect(page.getByTestId('session-mode')).toHaveText('Reviewing')

    await page.goto('/settings')
    expect(await scrollsSideways(page)).toBe(false)
    expect(await hitTarget(page, 'export-button')).toBeGreaterThanOrEqual(40)
    expect(await hitTarget(page, 'reset-confirm')).toBeGreaterThanOrEqual(40)
  })
})

test.describe('with the keyboard alone', () => {
  test.beforeEach(async ({ page }) => {
    await resetEverything(page)
    await reachHome(page, { goal: GOAL, experience: 'some-python' })
  })

  test('exports and then deletes everything, without a mouse', async ({ page }) => {
    await page.goto('/settings')

    const started = page.waitForEvent('download')
    await focusByTab(page, 'export-button')
    await page.keyboard.press('Enter')
    await started
    await expect(page.getByTestId('export-status')).toContainText('Saved')

    await focusByTab(page, 'reset-confirmation')
    await page.keyboard.type('reset')
    await page.keyboard.press('Enter')

    // Refused, and focus is put back in the field rather than left on a button that did nothing.
    await expect(page.getByTestId('reset-error')).toBeVisible()
    await expect(page.getByTestId('reset-confirmation')).toBeFocused()

    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(RESET_CONFIRMATION)
    await page.keyboard.press('Enter')

    await expect(page.getByTestId('goal-input')).toBeVisible()
  })
})

/** Tabs forward until the named control has focus. Fails rather than looping for ever. */
async function focusByTab(page: Page, testId: string): Promise<void> {
  const target = page.getByTestId(testId)
  await expect(target).toBeVisible()

  for (let presses = 0; presses < 40; presses += 1) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((node) => node === document.activeElement)) return
  }

  throw new Error(`${testId} was never reached with the keyboard`)
}

async function scrollsSideways(page: Page): Promise<boolean> {
  return await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
}

/** The shorter side of a control's box, in pixels. */
async function hitTarget(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox()
  if (box === null) throw new Error(`${testId} is not on the page`)
  return Math.min(box.width, box.height)
}

/**
 * Starts another instance of the production build over the same database, and waits for it.
 *
 * `next start` is run through Node directly rather than through a shell, so there is a process
 * to kill afterwards on every platform.
 */
async function startSecondInstance(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '--port', String(RESTARTED_PORT)],
    {
      env: { ...process.env, DATABASE_PATH: DATABASE, LLM_PROVIDER: 'mock' },
      stdio: 'ignore',
    },
  )

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(RESTARTED_BASE_URL, { redirect: 'manual' })
      if (response.status > 0) return child
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  child.kill()
  throw new Error('the second application process never came up')
}
