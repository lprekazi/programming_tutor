import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getDb } from '@/db/instance'
import { ensureLearner, readProfile } from '@/db/repositories/learner-repository'
import { readSessionActivities } from '@/db/repositories/activity-repository'
import { readSessionExercises } from '@/db/repositories/exercise-repository'
import { readSession } from '@/db/repositories/session-repository'
import { requestNow } from '@/db/request-time'
import { presentActivity } from '@/domain/assessment/present'
import { getConcept } from '@/domain/curriculum/graph'
import { viewOfExercise } from '@/domain/exercises/view'
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

  /*
   * Checks are looked up by the turn they sit on, so the runner can interleave them with the
   * prose in one ordered sequence. The answer key is stripped here, on the server, by
   * `presentActivity` — the browser is sent the question and nothing it could mark itself with.
   */
  const checks = readSessionActivities(db, session.id).map((activity) => ({
    turnId: activity.turnId,
    presented: presentActivity(activity),
    hint: activity.hints.find((each) => each.depth === 1)?.text ?? null,
    answered:
      activity.attempt === null
        ? null
        : {
            response: activity.attempt.response,
            marked: activity.attempt.marked,
            correct: activity.attempt.correct === true,
            partial: activity.attempt.partial,
            markedBy: activity.attempt.markingSource,
            unmarkedReason: activity.attempt.unmarkedReason,
            feedback: activity.attempt.feedback,
            hintDepth: activity.attempt.hintDepth,
          },
  }))

  /*
   * Exercises the same way, through `viewOfExercise`, which is the only assembly path to the
   * browser and never carries the reference solution. An unverified generated exercise has no slot
   * at all — nothing a learner could read — only a flag so the page can resume checking it.
   */
  const storedExercises = readSessionExercises(db, session.id)
  const exercises = storedExercises
    .filter((exercise) => exercise.verification === 'verified')
    .map((exercise) => ({ turnId: exercise.turnId, view: viewOfExercise(exercise, requestNow()) }))
  const exercisePending = storedExercises.some((exercise) => exercise.verification === 'unverified')

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
        checks={checks}
        conceptTitle={concept.title}
        exercisePending={exercisePending}
        exercises={exercises}
        sessionId={session.id}
        /*
         * An activity turn's text is a record for the model — what was asked, how it went, and
         * the ids of any misconceptions it showed. The page renders the check itself in that
         * turn's place and never reads the text, but passing it anyway put internal
         * vocabulary into the serialised payload of a page whose rule is that it stays on the
         * server. Emptied here rather than filtered out, so the turn keeps its position.
         */
        turns={session.turns.map((turn) =>
          turn.role === 'activity' ? { ...turn, text: '' } : turn,
        )}
      />
    </div>
  )
}
