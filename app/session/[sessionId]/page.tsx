import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getDb } from '@/db/instance'
import { ensureLearner, readProfile } from '@/db/repositories/learner-repository'
import { readSession } from '@/db/repositories/session-repository'
import { requestNow } from '@/db/request-time'
import { getConcept } from '@/domain/curriculum/graph'
import { resolveProvider } from '@/llm/resolve'

import { SessionRunner } from './SessionRunner'
import styles from './page.module.css'

export const metadata: Metadata = { title: 'Session' }
export const dynamic = 'force-dynamic'

/**
 * One concept, one conversation.
 *
 * Everything on this page comes from the database. The browser holds nothing that matters, so
 * a refresh, a restart, or coming back next week lands on the same conversation at the same
 * point — which is the difference between a tutor and a chat window that forgets you.
 */

export default async function SessionPage({
  params,
}: {
  readonly params: Promise<{ readonly sessionId: string }>
}) {
  const { sessionId } = await params
  const db = getDb()
  ensureLearner(db, requestNow())
  const profile = readProfile(db)

  if (profile === null || !profile.onboardingComplete) redirect('/welcome')
  if (!profile.diagnosticComplete) redirect('/diagnostic')

  const session = readSession(db, sessionId)
  if (session === null) redirect('/home')

  const concept = getConcept(session.conceptId)
  const provider = resolveProvider()

  return (
    <div className={styles.page}>
      <nav className={styles.breadcrumb}>
        <Link href="/home">Where you are</Link>
      </nav>

      <header className={styles.header}>
        <p className={styles.eyebrow}>Working on</p>
        <h1>{concept.title}</h1>
        <p className={styles.lead}>{concept.summary}</p>
        {session.openedReason.length > 0 && (
          <p className={styles.reason} data-testid="session-reason">
            {session.openedReason}
          </p>
        )}
      </header>

      {provider?.model === 'mock' && (
        // Said outright rather than left to be discovered. A fixed script presented as a tutor
        // would be the application lying about the one thing it exists to do.
        <p className={styles.notice} data-testid="mock-notice">
          This copy is running against a fixed demo script, not a real tutor. Replies are the
          same every time and are not written for what you asked.
        </p>
      )}

      <SessionRunner
        conceptTitle={concept.title}
        sessionId={session.id}
        turns={session.turns}
      />
    </div>
  )
}
