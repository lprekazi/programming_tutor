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
import { getConcept } from '@/domain/curriculum/graph'
import type { Area } from '@/domain/curriculum/types'
import {
  bandOf,
  evidenceStrengthOf,
  type Band,
  type ConceptState,
  type EvidenceStrength,
} from '@/domain/learner-model/state'
import {
  describeSelection,
  groundsFor,
  selectNextConcept,
  stateLookupFrom,
} from '@/domain/scheduling/select'
import {
  readLatestOpenSession,
  readOpenSessionConcepts,
} from '@/db/repositories/session-repository'

import { NextStep } from './NextStep'

import styles from './page.module.css'

export const metadata: Metadata = { title: 'Where you are' }
export const dynamic = 'force-dynamic'

/**
 * What the tutor currently believes, and where it would go next.
 *
 * The first thing this page has to get right is not looking more certain than it is. Ten
 * questions is enough to know roughly where to start and nothing like enough to pronounce on
 * thirty-three concepts, so almost everything here says "not started" — and it says so in
 * words, next to a count of how much evidence there actually is.
 *
 * No number from the learner model reaches this page. Bands and evidence strength are coarse
 * on purpose: showing 0.42 would be inventing a precision the estimate does not have.
 */

const AREA_LABELS: Readonly<Record<Area, string>> = {
  fundamentals: 'How programs run',
  'variables-and-types': 'Variables and values',
  expressions: 'Expressions',
  conditionals: 'Conditionals',
  loops: 'Loops',
  functions: 'Functions',
  collections: 'Collections',
  debugging: 'Debugging',
  decomposition: 'Breaking problems up',
  'object-oriented': 'Classes and objects',
}

const BAND_LABELS: Readonly<Record<Band, string>> = {
  'not-started': 'Not started',
  'needs-review': 'Needs review',
  developing: 'Developing',
  secure: 'Secure',
}

/**
 * How much the band rests on, in the learner's terms.
 *
 * Counted in answers, because that is the thing they did. "Evidence" is what the tutor calls
 * it internally and stays there.
 */
const STRENGTH_LABELS: Readonly<Record<EvidenceStrength, string>> = {
  none: 'nothing seen yet',
  limited: 'one or two answers',
  moderate: 'a few answers',
  strong: 'plenty of answers',
}

const BAND_CLASS: Readonly<Record<Band, string>> = {
  'not-started': styles.bandNotStarted ?? '',
  'needs-review': styles.bandNeedsReview ?? '',
  developing: styles.bandDeveloping ?? '',
  secure: styles.bandSecure ?? '',
}

interface Grouped {
  readonly area: Area
  readonly concepts: readonly { readonly state: ConceptState; readonly title: string }[]
}

function groupByArea(states: readonly ConceptState[]): readonly Grouped[] {
  const byArea = new Map<Area, { state: ConceptState; title: string }[]>()

  for (const state of states) {
    const concept = getConcept(state.conceptId)
    const bucket = byArea.get(concept.area) ?? []
    bucket.push({ state, title: concept.title })
    byArea.set(concept.area, bucket)
  }

  return [...byArea.entries()].map(([area, concepts]) => ({ area, concepts }))
}

export default function HomePage() {
  const db = getDb()
  const now = requestNow()
  ensureLearner(db, now)
  const profile = readProfile(db)

  if (profile === null || !profile.onboardingComplete) redirect('/welcome')
  if (!profile.diagnosticComplete) redirect('/diagnostic')

  const states = readConceptStates(db)
  const evidenceCount = countEvidence(db)
  const responses = readResponses(db, openDiagnostic(db, now).sessionId)
  const assessed = states.filter((state) => bandOf(state) !== 'not-started')
  const lookup = stateLookupFrom(states)
  const selection = selectNextConcept(lookup, now)
  const resumable = readLatestOpenSession(db)
  const openSessions = new Set(readOpenSessionConcepts(db))

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Where you are</p>
        <h1>What the tutor knows so far</h1>
        <p className={styles.lead}>
          Built from {evidenceCount} {evidenceCount === 1 ? 'answer' : 'answers'} you gave in the
          short assessment. It is a starting point, not a verdict, and it changes as you work.
        </p>
      </header>

      {profile.goal !== null && profile.goal.length > 0 && (
        <section aria-labelledby="goal-heading" className={styles.section}>
          <h2 className={styles.sectionHeading} id="goal-heading">
            What you said you wanted
          </h2>
          <blockquote className={styles.goal} data-testid="learner-goal">
            {profile.goal}
          </blockquote>
        </section>
      )}

      <section aria-labelledby="next-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="next-heading">
          Next
        </h2>
        {selection === null ? (
          <p className={styles.body} data-testid="next-concept">
            Nothing is open yet. That happens when the assessment did not reach far enough to
            unlock anything.
          </p>
        ) : (
          <NextStep
            conceptId={selection.conceptId}
            continuing={openSessions.has(selection.conceptId)}
            grounds={groundsFor(selection, lookup)}
            reason={describeSelection(selection)}
            title={getConcept(selection.conceptId).title}
          />
        )}
      </section>

      {resumable !== null && resumable.conceptId !== selection?.conceptId && (
        <section aria-labelledby="resume-heading" className={styles.section}>
          <h2 className={styles.sectionHeading} id="resume-heading">
            Still open
          </h2>
          <p className={styles.body}>
            You were working on{' '}
            <Link data-testid="resume-session" href={`/session/${resumable.id}`}>
              {getConcept(resumable.conceptId).title}
            </Link>
            . That conversation is still there.
          </p>
        </section>
      )}

      <section aria-labelledby="assessed-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="assessed-heading">
          What was actually assessed
        </h2>
        <p className={styles.body} data-testid="assessed-count">
          {assessed.length === 0
            ? 'Nothing yet.'
            : `${assessed.length} of ${states.length} concepts, from ${responses.length} ${responses.length === 1 ? 'question' : 'questions'}.`}{' '}
          Everything else is untouched — not weak, not strong, simply unknown.
        </p>
      </section>

      <section aria-labelledby="concepts-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="concepts-heading">
          Every concept
        </h2>

        {groupByArea(states).map((group) => (
          <div className={styles.area} key={group.area}>
            <h3 className={styles.areaHeading}>{AREA_LABELS[group.area]}</h3>
            <ul className={styles.concepts}>
              {group.concepts.map(({ state, title }) => {
                const band = bandOf(state)
                return (
                  <li className={styles.concept} key={state.conceptId}>
                    <span className={styles.conceptTitle}>{title}</span>
                    <span
                      className={`${styles.band} ${BAND_CLASS[band]}`}
                      data-band={band}
                      data-testid={`band-${state.conceptId}`}
                    >
                      {BAND_LABELS[band]}
                    </span>
                    <span className={styles.strength}>
                      {STRENGTH_LABELS[evidenceStrengthOf(state)]}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </section>

      <p className={styles.footer}>
        <Link href="/system-check">System check</Link>
        <Link href="/reset">Start again</Link>
      </p>
    </div>
  )
}
