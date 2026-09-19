import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getDb } from '@/db/instance'
import { requestNow } from '@/db/request-time'
import { openDiagnostic, readResponses } from '@/db/repositories/diagnostic-repository'
import {
  countEvidence,
  ensureLearner,
  readConceptStates,
  readProfile,
} from '@/db/repositories/learner-repository'
import { readDataGeneration } from '@/db/repositories/meta-repository'
import { readAllSessions } from '@/db/repositories/session-repository'
import { getConcept } from '@/domain/curriculum/graph'
import { bandOf } from '@/domain/learner-model/state'
import {
  activityKindOf,
  describeRecommendation,
  dueForReview,
  groundsForRecommendation,
  otherOpenSessions,
  recommendNext,
} from '@/domain/scheduling/next-action'
import { availableConcepts, stateLookupFrom } from '@/domain/scheduling/select'

import { NextStep } from './NextStep'

import styles from './page.module.css'

export const metadata: Metadata = { title: 'Where you are' }
export const dynamic = 'force-dynamic'

/**
 * Where the learner lands, and the one thing they are asked to do.
 *
 * Home answers four questions and stops: what should I do now, why that, what else is waiting,
 * and where is everything I have done. The per-concept record used to live here as well, which
 * made the first question compete with thirty-three rows of standing; it now has its own page
 * and is linked, not inlined.
 *
 * What is deliberately absent: totals presented as achievements, anything that counts days in a
 * row, and any number from the learner model. The one figure shown is how many answers the
 * picture rests on, which is a statement about the evidence rather than a score.
 */

/** How many concepts to name in the review list before summarising the rest. */
const REVIEW_SHOWN = 4

/**
 * Calendar days between two moments, in the reader's own timezone.
 *
 * Elapsed milliseconds are the wrong unit for the words "today" and "yesterday": a session left
 * at eleven at night is not "earlier today" when it is read at eight the next morning, though
 * only nine hours have passed (M7 review finding L2). The scheduling arithmetic stays in
 * milliseconds, where it belongs; only the words are counted in days.
 */
function calendarDaysBetween(at: number, now: number): number {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return 0

  const midnight = (moment: number): number => {
    const date = new Date(moment)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }

  return Math.max(0, Math.round((midnight(now) - midnight(at)) / 86_400_000))
}

/** How long ago, in the words the learner would use. */
function whenLast(at: number, now: number): string {
  const days = calendarDaysBetween(at, now)
  if (days === 0) return 'earlier today'
  if (days === 1) return 'yesterday'
  return `${String(days)} days ago`
}

/** How overdue, in the same calendar terms. `overdueMs` is measured back from now. */
function dueWords(overdueMs: number, now: number): string {
  const days = calendarDaysBetween(now - overdueMs, now)
  if (days === 0) return 'due today'
  return days === 1 ? 'due since yesterday' : `due ${String(days)} days ago`
}

export default function HomePage() {
  const db = getDb()
  const now = requestNow()
  ensureLearner(db, now)
  const profile = readProfile(db)

  if (profile === null || !profile.onboardingComplete) redirect('/welcome')
  if (!profile.diagnosticComplete) redirect('/diagnostic')

  const states = readConceptStates(db)
  const lookup = stateLookupFrom(states)
  const sessions = readAllSessions(db)
  const generation = readDataGeneration(db)

  const recommendation = recommendNext({
    lookup,
    sessions: sessions.map((session) => ({
      id: session.id,
      conceptId: session.conceptId,
      updatedAt: session.updatedAt,
      closedAt: session.closedAt,
    })),
    now,
  })
  const activity = activityKindOf(recommendation)
  const chosenConcept = recommendation.kind === 'nothing' ? null : recommendation.conceptId

  // The same predicate the scheduler uses, over the same concepts it would consider, so the
  // list and the recommendation cannot disagree about what is due.
  const due = dueForReview(
    lookup,
    availableConcepts(lookup).map((concept) => concept.id),
    now,
  ).filter((entry) => entry.conceptId !== chosenConcept)

  const stillOpen = otherOpenSessions(
    sessions.map((session) => ({
      id: session.id,
      conceptId: session.conceptId,
      updatedAt: session.updatedAt,
      closedAt: session.closedAt,
    })),
    recommendation,
    now,
  )

  const evidenceCount = countEvidence(db)
  const diagnosticAnswers = readResponses(db, openDiagnostic(db, now).sessionId).length
  const sessionAnswers = Math.max(0, evidenceCount - diagnosticAnswers)
  const assessed = states.filter((state) => bandOf(state) !== 'not-started')

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Where you are</p>
        <h1>What next</h1>
        <p className={styles.lead}>
          Chosen from what you have shown so far — {evidenceCount}{' '}
          {evidenceCount === 1 ? 'answer' : 'answers'} across {assessed.length} of {states.length}{' '}
          concepts. It changes as you work.
        </p>
      </header>

      <section aria-labelledby="next-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="next-heading">
          Next
        </h2>
        {recommendation.kind === 'nothing' || activity === null ? (
          <p className={styles.body} data-testid="next-concept">
            {describeRecommendation(recommendation)}
          </p>
        ) : (
          <NextStep
            activity={activity}
            conceptId={recommendation.conceptId}
            generation={generation}
            grounds={groundsForRecommendation(recommendation, lookup)}
            reason={describeRecommendation(recommendation)}
            title={getConcept(recommendation.conceptId).title}
            {...(activity === 'review' && recommendation.alternative !== null
              ? {
                  alternative: {
                    conceptId: recommendation.alternative.conceptId,
                    title: getConcept(recommendation.alternative.conceptId).title,
                  },
                }
              : {})}
          />
        )}
      </section>

      {due.length > 0 && (
        <section aria-labelledby="due-heading" className={styles.section}>
          <h2 className={styles.sectionHeading} id="due-heading">
            Also due
          </h2>
          {/*
            Listed, not urged. These are concepts the scheduler will come to; saying so is
            useful, and dressing it up as a backlog to clear would be inventing pressure the
            scheduling does not imply.
          */}
          <ul className={styles.dueList} data-testid="due-list">
            {due.slice(0, REVIEW_SHOWN).map((entry) => (
              <li key={entry.conceptId}>
                <span className={styles.dueConcept}>{getConcept(entry.conceptId).title}</span>
                <span className={styles.dueWhen}>{dueWords(entry.overdueMs, now)}</span>
              </li>
            ))}
          </ul>
          {due.length > REVIEW_SHOWN && (
            <p className={styles.body}>
              {due.length - REVIEW_SHOWN} more will come round in turn.
            </p>
          )}
        </section>
      )}

      {stillOpen.length > 0 && (
        <section aria-labelledby="open-heading" className={styles.section}>
          <h2 className={styles.sectionHeading} id="open-heading">
            Still open
          </h2>
          <ul className={styles.openList} data-testid="open-sessions">
            {stillOpen.map((session) => (
              <li key={session.id}>
                <Link data-testid={`resume-${session.conceptId}`} href={`/session/${session.id}`}>
                  {getConcept(session.conceptId).title}
                </Link>{' '}
                <span className={styles.openWhen}>
                  {session.lifecycle === 'dormant'
                    ? `left ${whenLast(session.updatedAt, now)}`
                    : `last opened ${whenLast(session.updatedAt, now)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="record-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="record-heading">
          Your record
        </h2>
        <p className={styles.body} data-testid="assessed-count">
          {assessed.length === 0
            ? 'Nothing has been assessed yet.'
            : `${assessed.length} of ${states.length} concepts, from ${String(diagnosticAnswers)} assessment ${diagnosticAnswers === 1 ? 'question' : 'questions'} and ${String(sessionAnswers)} since.`}{' '}
          Everything else is untouched — not weak, not strong, simply unknown.
        </p>
        <p className={styles.body}>
          <Link data-testid="see-concepts" href="/concepts">
            Every concept, and the answers behind it
          </Link>
        </p>
      </section>

      <p className={styles.footer}>
        <Link href="/settings">Your data</Link>
        <Link href="/system-check">System check</Link>
      </p>
    </div>
  )
}
