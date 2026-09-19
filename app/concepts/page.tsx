import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getDb } from '@/db/instance'
import {
  ensureLearner,
  readConceptStates,
  readEvidenceFor,
  readProfile,
} from '@/db/repositories/learner-repository'
import { requestNow } from '@/db/request-time'
import { getConcept } from '@/domain/curriculum/graph'
import type { Area } from '@/domain/curriculum/types'
import { availableConcepts, stateLookupFrom } from '@/domain/scheduling/select'
import {
  bandOf,
  evidenceStrengthOf,
  isReviewDue,
  type Band,
  type ConceptState,
  type EvidenceStrength,
} from '@/domain/learner-model/state'

import styles from './page.module.css'

export const metadata: Metadata = { title: 'Every concept' }
export const dynamic = 'force-dynamic'

/**
 * What the tutor believes about each concept, and the answers behind it.
 *
 * This page's job is to be checkable. Every band can be opened to see the dated answers that
 * produced it, with the reason the domain recorded at the time — so a learner who disagrees
 * with a standing can see exactly what it rests on rather than being asked to trust it.
 *
 * No number from the learner model reaches this page. Bands and evidence strength are coarse on
 * purpose: showing 0.42 would be inventing a precision the estimate does not have.
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

const BAND_CLASS: Readonly<Record<Band, string>> = {
  'not-started': styles.bandNotStarted ?? '',
  'needs-review': styles.bandNeedsReview ?? '',
  developing: styles.bandDeveloping ?? '',
  secure: styles.bandSecure ?? '',
}

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

export default function ConceptsPage() {
  const db = getDb()
  const now = requestNow()
  ensureLearner(db, now)
  const profile = readProfile(db)

  if (profile === null || !profile.onboardingComplete) redirect('/welcome')
  if (!profile.diagnosticComplete) redirect('/diagnostic')

  const states = readConceptStates(db)
  /*
   * Dueness is shown only for concepts the scheduler would currently offer.
   *
   * `isReviewDue` is the single definition of due, but the scheduler also requires the
   * prerequisites to have been demonstrated. A concept that went weak in the diagnostic comes
   * due within a day while still sitting behind an unmet prerequisite, so this page said "due
   * for review" about something Home would never bring back — the disagreement between page and
   * scheduler that `isReviewDue` exists to prevent (M7 review finding M6).
   */
  const lookup = stateLookupFrom(states)
  const reachable = new Set(availableConcepts(lookup).map((concept) => concept.id))

  return (
    <div className={styles.page}>
      <nav className={styles.breadcrumb}>
        <Link href="/home">Where you are</Link>
      </nav>

      <header className={styles.header}>
        <p className={styles.eyebrow}>Your record</p>
        <h1>Every concept</h1>
        <p className={styles.lead}>
          Each standing can be opened to see the answers behind it, with the reason recorded at
          the time. Anything untouched says so rather than being guessed at.
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

      <section aria-labelledby="concepts-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="concepts-heading">
          Concept by concept
        </h2>

        {groupByArea(states).map((group) => (
          <div className={styles.area} key={group.area}>
            <h3 className={styles.areaHeading}>{AREA_LABELS[group.area]}</h3>
            <ul className={styles.concepts}>
              {group.concepts.map(({ state, title }) => {
                const band = bandOf(state)
                const history = readEvidenceFor(db, state.conceptId)
                const due = isReviewDue(state, now) && reachable.has(state.conceptId)

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
                      {/*
                        Dueness in words, next to the band, never as a colour on its own — and
                        beside the evidence strength, not instead of it. The page's lead promises
                        every standing says how much it rests on (M7 review finding L-4).
                      */}
                      {due
                        ? `due for review · ${STRENGTH_LABELS[evidenceStrengthOf(state)]}`
                        : STRENGTH_LABELS[evidenceStrengthOf(state)]}
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
        <Link href="/home">Back to what next</Link>
        <Link href="/settings">Your data</Link>
      </p>
    </div>
  )
}
