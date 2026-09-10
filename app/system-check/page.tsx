import type { Metadata } from 'next'
import Link from 'next/link'

import { PythonCheck } from '@/ui/components/PythonCheck'
import { DEFAULT_DATABASE_PATH } from '@/db/paths'
import { getDb } from '@/db/instance'
import { learner } from '@/db/schema'

import styles from './page.module.css'

export const metadata: Metadata = { title: 'System check' }

// The database is read on every visit so the page reports the live state rather than
// a build-time snapshot.
export const dynamic = 'force-dynamic'

interface StorageStatus {
  readonly ok: boolean
  readonly detail: string
}

function checkStorage(): StorageStatus {
  try {
    const rows = getDb().select().from(learner).all()
    return {
      ok: true,
      detail: `Migrations applied. ${rows.length === 0 ? 'No learner profile yet' : 'Learner profile present'}.`,
    }
  } catch (cause: unknown) {
    return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) }
  }
}

export default function SystemCheckPage() {
  const storage = checkStorage()
  const databasePath = process.env['DATABASE_PATH'] ?? DEFAULT_DATABASE_PATH

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>System check</h1>
        <p className={styles.lead}>
          Confirms that the parts of the tutor that run on your machine are working: where your
          progress is stored, and whether Python can run in your browser.
        </p>
      </header>

      <section aria-labelledby="storage-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="storage-heading">
          Your data
        </h2>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Status</dt>
            <dd data-testid="storage-status">
              <span className={storage.ok ? styles.good : styles.bad}>
                {storage.ok ? 'Working' : 'Not working'}
              </span>
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Location</dt>
            <dd>
              <code>{databasePath}</code>
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Detail</dt>
            <dd>{storage.detail}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="python-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="python-heading">
          Python
        </h2>
        <p className={styles.sectionNote}>
          Python runs entirely inside your browser. Nothing you write is sent anywhere to be
          executed. A program that never finishes can always be stopped.
        </p>
        <PythonCheck />
      </section>

      <p className={styles.back}>
        <Link href="/">Back</Link>
      </p>
    </div>
  )
}
