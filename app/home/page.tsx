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
  readEvidenceFor,
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

/** How many dated entries to show before summarising the rest. */
const EVIDENCE_SHOWN = 5

/**
 * A recorded band, in the same words the list above uses.
 *
 * Narrowed rather than cast: the column is free text, and a value the current band vocabulary
 * no longer knows is shown as itself rather than mapped to something it is not.
 */
function bandWord(band: string): string {
  return isBand(band) ? BAND_LABELS[band].toLowerCase() : band
}

function isBand(value: string): value is Band {
  return Object.prototype.hasOwnProperty.call(BAND_LABELS, value)
}

/**
 * The day an answer was given.
 *
 * Day rather than time: the exact minute is noise, and a learner reading their own history
 * wants to know whether this was today or last week.
 */
function formatDay(at: Date): string {
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
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
  // Split rather than summed: where the picture came from is more informative than how much
  // of it there is, and the two sources mean different things.
  const diagnosticAnswers = readResponses(db, openDiagnostic(db, now).sessionId).length
  const sessionAnswers = Math.max(0, evidenceCount - diagnosticAnswers)
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
          {/*
            Every answer, not only the assessment's. M5 added questions inside sessions, and a
            sentence that still said "in the short assessment" would have been quietly
            undercounting the learner's own work from the moment they answered one.
          */}
          Built from {evidenceCount} {evidenceCount === 1 ? 'answer' : 'answers'} you have given
          so far. It is a starting point, not a verdict, and it changes as you work.
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
            : `${assessed.length} of ${states.length} concepts, from ${String(diagnosticAnswers)} assessment ${diagnosticAnswers === 1 ? 'question' : 'questions'} and ${String(sessionAnswers)} since.`}{' '}
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
                const history = readEvidenceFor(db, state.conceptId)

                const row = (
                  <>
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
                  </>
                )

                /*
                 * A concept with nothing behind it has nothing to disclose, so it stays a plain
                 * row rather than a control that opens onto an empty list.
                 */
                if (history.length === 0) {
                  return (
                    <li className={styles.concept} key={state.conceptId}>
                      {row}
                    </li>
                  )
                }

                return (
                  <li className={styles.conceptWithHistory} key={state.conceptId}>
                    <details className={styles.history}>
                      <summary
                        className={styles.concept}
                        data-testid={`history-${state.conceptId}`}
                      >
                        {row}
                      </summary>

                      {/*
                        Why the band says what it says.

                        One dated line per answer, with the reason the domain recorded when it
                        made the change — not a sentence written here to sound plausible. Where a
                        band moved, it says which way; where it did not, it says the answer was
                        recorded and the band held, because one answer usually should not move it.
                      */}
                      <ol className={styles.evidence} data-testid={`evidence-${state.conceptId}`}>
                        {history.slice(0, EVIDENCE_SHOWN).map((entry) => (
                          <li className={styles.evidenceEntry} key={entry.id}>
                            <span className={styles.evidenceWhen}>
                              {formatDay(entry.observedAt)}
                            </span>
                            <span className={styles.evidenceWhat}>
                              {/*
                                The reason as the domain recorded it, verbatim. It already names
                                the move where there was one, so nothing is appended in that
                                case — saying it twice was the first thing the browser showed.
                                Where the band held, that is worth saying out loud, because a
                                learner watching a single answer change nothing needs to know
                                it was still counted.
                              */}
                              {entry.reason}
                              {entry.priorBand === entry.posteriorBand
                                ? ` Counted; ${bandWord(entry.posteriorBand)} still fits.`
                                : ''}
                            </span>
                          </li>
                        ))}
                      </ol>

                      {history.length > EVIDENCE_SHOWN && (
                        <p className={styles.evidenceMore}>
                          {history.length - EVIDENCE_SHOWN} earlier{' '}
                          {history.length - EVIDENCE_SHOWN === 1 ? 'answer' : 'answers'} not shown.
                        </p>
                      )}
                    </details>
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
