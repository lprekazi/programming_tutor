import type { Metadata } from 'next'
import Link from 'next/link'

import { getDb } from '@/db/instance'
import { countEvidence, ensureLearner } from '@/db/repositories/learner-repository'
import { requestNow } from '@/db/request-time'

import { ResetForm } from './ResetForm'
import { RESET_CONFIRMATION } from './confirmation'
import styles from './page.module.css'

export const metadata: Metadata = { title: 'Start again' }
export const dynamic = 'force-dynamic'

/**
 * Deleting everything, on purpose.
 *
 * The learner's whole history lives in one file on their own machine, so this is the only way
 * to undo a first run that went badly — a diagnostic answered while distracted, an experience
 * level chosen wrongly. It has to exist, and it has to be honest about what it destroys.
 *
 * Guarded by typing a word rather than by a confirmation dialog. A dialog is dismissed by
 * reflex; typing is not.
 */

export default function ResetPage() {
  const db = getDb()
  ensureLearner(db, requestNow())
  const evidenceCount = countEvidence(db)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Your data</p>
        <h1>Start again</h1>
        <p className={styles.lead}>
          This deletes everything the tutor has recorded about you and returns the application to
          its first run. It cannot be undone.
        </p>
      </header>

      <section aria-labelledby="removed-heading">
        <h2 className={styles.sectionHeading} id="removed-heading">
          What goes
        </h2>
        <ul className={styles.list}>
          <li>What you said you wanted, and how you rated yourself.</li>
          <li>Your answers to the short assessment.</li>
          <li>
            Every piece of evidence behind the tutor&rsquo;s picture of you —{' '}
            <span data-testid="evidence-count">{evidenceCount}</span> so far.
          </li>
        </ul>
      </section>

      <ResetForm confirmation={RESET_CONFIRMATION} />

      <p className={styles.footer}>
        <Link href="/">Back</Link>
      </p>
    </div>
  )
}
