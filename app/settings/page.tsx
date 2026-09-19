import type { Metadata } from 'next'
import Link from 'next/link'

import { getDb } from '@/db/instance'
import { countEvidence, ensureLearner, readProfile } from '@/db/repositories/learner-repository'
import { readAllSessions } from '@/db/repositories/session-repository'
import { requestNow } from '@/db/request-time'
import { EXPORT_SCHEMA_VERSION } from '@/domain/export/document'

import { ResetForm } from '../reset/ResetForm'
import { RESET_CONFIRMATION } from '../reset/confirmation'
import { ExportPanel } from './ExportPanel'
import styles from './page.module.css'

export const metadata: Metadata = { title: 'Your data' }
export const dynamic = 'force-dynamic'

/**
 * Where the learner's data is, how to take a copy, and how to delete it.
 *
 * Secondary by construction. Neither of these belongs beside the thing the learner came to do,
 * and the destructive one is at the bottom behind a word they have to type — a dialog is
 * dismissed by reflex, typing is not.
 */

export default function SettingsPage() {
  const db = getDb()
  const now = requestNow()
  ensureLearner(db, now)

  const profile = readProfile(db)
  const evidenceCount = countEvidence(db)
  const sessions = readAllSessions(db)

  return (
    <div className={styles.page}>
      <nav className={styles.breadcrumb}>
        <Link href="/home">Where you are</Link>
      </nav>

      <header className={styles.header}>
        <p className={styles.eyebrow}>Your data</p>
        <h1>What is stored, and what you can do with it</h1>
        <p className={styles.lead}>
          Everything the tutor knows about you is in one file on this machine. Nothing is sent
          anywhere, and there is no account behind it.
        </p>
      </header>

      <section aria-labelledby="what-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="what-heading">
          What is here
        </h2>
        <ul className={styles.list} data-testid="what-is-stored">
          <li>
            What you said you wanted, how you rated yourself, and your answers to the short
            assessment.
          </li>
          <li>
            Every piece of evidence behind your concept standings —{' '}
            <span data-testid="evidence-count">{evidenceCount}</span> so far.
          </li>
          <li>
            Your tutoring conversations, questions, exercises and hints — {sessions.length}{' '}
            {sessions.length === 1 ? 'conversation' : 'conversations'}.
          </li>
        </ul>
      </section>

      <section aria-labelledby="export-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="export-heading">
          Take a copy
        </h2>
        <p className={styles.body}>
          A JSON file with your profile, your standings, the evidence behind each one, and your
          conversations. It is version {EXPORT_SCHEMA_VERSION} of the export format, and says so
          in the file.
        </p>
        <p className={styles.body}>
          It does <strong>not</strong> contain answer keys or exercise solutions — an export
          should not hand you the answers to questions you have not been asked yet — nor
          anything about the model behind the tutor.
        </p>
        <ExportPanel />
      </section>

      <section aria-labelledby="delete-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="delete-heading">
          Delete everything
        </h2>
        <p className={styles.body}>
          This deletes everything above and returns the application to its first run. It cannot
          be undone, and there is no copy kept anywhere — so if you want one, take it first.
        </p>
        {profile !== null && !profile.onboardingComplete && (
          <p className={styles.body} data-testid="nothing-yet">
            There is almost nothing here yet: you have not finished the first-run questions.
          </p>
        )}
        <ResetForm confirmation={RESET_CONFIRMATION} />
      </section>

      <p className={styles.footer}>
        <Link href="/home">Where you are</Link>
        <Link href="/concepts">Every concept</Link>
        <Link href="/system-check">System check</Link>
      </p>
    </div>
  )
}
