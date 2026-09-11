import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { getDb } from '@/db/instance'
import { requestNow } from '@/db/request-time'
import {
  decideNext,
  openDiagnostic,
  remainingQuestions,
} from '@/db/repositories/diagnostic-repository'
import { ensureLearner, readProfile } from '@/db/repositories/learner-repository'
import { getConcept } from '@/domain/curriculum/graph'
import { getDiagnosticItem } from '@/domain/diagnostic/items'
import { conceptsAsked } from '@/domain/diagnostic/plan'
import { presentItem } from '@/domain/diagnostic/present'
import { tutorIsReachable, unmarkableItemIds } from '@/tutor/diagnostic-readiness'

import { finishDiagnostic } from '../actions'
import { DiagnosticRunner } from './DiagnosticRunner'
import styles from './page.module.css'

export const metadata: Metadata = { title: 'Short assessment' }
export const dynamic = 'force-dynamic'

/**
 * The diagnostic.
 *
 * Ten or so questions, mixed in kind, chosen one at a time from what the learner has already
 * shown. Everything that decides whether an answer is right stays on this side of the network:
 * the browser is sent the question and nothing else.
 *
 * The page is driven entirely by stored state rather than by anything held in the browser, so
 * closing the tab mid-question and coming back a week later resumes at the same place.
 */

const REASONS: Readonly<Record<string, string>> = {
  'covered-enough': 'That is enough to start from. You covered a good spread of topics.',
  'reached-limit': 'That is the full set of questions.',
  'nothing-left':
    'There are no further questions worth asking — the remaining ones all rest on something this assessment has already covered.',
}

export default function DiagnosticPage() {
  const db = getDb()
  const now = requestNow()
  ensureLearner(db, now)
  const profile = readProfile(db)

  if (profile === null || !profile.onboardingComplete) redirect('/welcome')
  if (profile.diagnosticComplete) redirect('/home')

  const progress = openDiagnostic(db, now)
  const unmarkable = unmarkableItemIds()
  const decision = decideNext(db, progress, unmarkable)

  if (decision.kind === 'finished') {
    const covered = conceptsAsked(progress.answers).map((id) => getConcept(id).title)
    // Only what was actually set aside during this run. Merging in every item the tutor could
    // not have marked overstated it: with the diagnostic stopping at seven of eighteen items,
    // most of those were never going to be reached anyway, and reporting them as "left out"
    // claims a gap that selection, not availability, accounts for.
    const setAside = progress.skippedItemIds

    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Short assessment</p>
          <h1>Done</h1>
          <p className={styles.lead}>{REASONS[decision.reason] ?? 'That is the last question.'}</p>
        </header>

        <dl className={styles.summary} data-testid="diagnostic-summary">
          <div className={styles.summaryRow}>
            <dt>Questions answered</dt>
            <dd data-testid="answered-count">{decision.asked}</dd>
          </div>
          <div className={styles.summaryRow}>
            <dt>Topics touched</dt>
            <dd>{covered.length === 0 ? 'None' : covered.join(', ')}</dd>
          </div>
          {setAside.length > 0 && (
            <div className={styles.summaryRow}>
              <dt>Set aside</dt>
              <dd data-testid="set-aside">
                {setAside.length} question{setAside.length === 1 ? '' : 's'} could not be marked
                and {setAside.length === 1 ? 'was' : 'were'} left out. Nothing has been assumed
                about {setAside.length === 1 ? 'it' : 'them'}.
              </dd>
            </div>
          )}

          {!tutorIsReachable() && (
            <div className={styles.summaryRow}>
              <dt>Not available</dt>
              <dd data-testid="tutor-unreachable">
                The tutor could not be reached, so questions needing it to be read were not
                offered. Everything you were asked was marked without it.
              </dd>
            </div>
          )}
        </dl>

        <p className={styles.note}>
          Everything else stays marked as not started. The tutor will not claim you know
          something it has not seen you do.
        </p>

        <form action={finishDiagnostic}>
          <button className={styles.primary} data-testid="finish-diagnostic" type="submit">
            See where you are
          </button>
        </form>
      </div>
    )
  }

  const item = getDiagnosticItem(decision.item.id)
  const left = remainingQuestions(db, progress, unmarkable)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Short assessment</p>
        <h1>Question {decision.position}</h1>
        <p className={styles.progress} data-testid="progress">
          {decision.isLast
            ? 'The last question.'
            : left.least === left.most
              ? `${String(left.most)} question${left.most === 1 ? '' : 's'} to go, including this one.`
              : `Between ${String(left.least)} and ${String(left.most)} to go, including this one.`}
        </p>
      </header>

      <DiagnosticRunner
        // Remounting on the item is what resets the editor, the answer and the run output:
        // there is no state from one question that belongs in the next.
        key={item.id}
        item={presentItem(item)}
        isLast={decision.isLast}
      />

      <p className={styles.note} data-testid="saved-note">
        Answers are saved as you give them. You can close this and come back to the same place.
      </p>
    </div>
  )
}
