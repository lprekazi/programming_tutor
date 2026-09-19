import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getDb } from '@/db/instance'
import { ensureLearner, readConceptState, readProfile } from '@/db/repositories/learner-repository'
import { readSessionActivities } from '@/db/repositories/activity-repository'
import { readSessionExercises } from '@/db/repositories/exercise-repository'
import { readSession } from '@/db/repositories/session-repository'
import { requestNow } from '@/db/request-time'
import { presentActivity } from '@/domain/assessment/present'
import { getConcept } from '@/domain/curriculum/graph'
import { isReviewDue } from '@/domain/learner-model/state'
import { isReviewingNow, sittingFor, sittingHasLapsed } from '@/tutor/session/sitting'
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

  const now = requestNow()
  const session = readSession(db, sessionId)
  if (session === null) redirect('/home')

  const concept = getConcept(session.conceptId)
  const provider = resolveProvider()
  /*
   * What this sitting is, said truthfully from the first paint.
   *
   * Three cases, because a session page can be reached three ways:
   *
   *  - **Finished.** The learner closed it. Reading it is not reopening it — Back after "Done
   *    for now" lands here — so it says so, and writing in it picks it up again.
   *  - **Lapsed.** Open, but idle past `MID_LESSON_MS`: a bookmark, the "still open" list or
   *    Back from weeks ago. The runner starts the sitting once the page is on screen (a render
   *    must not write — a prefetch would start sittings nobody asked for), so the header shows
   *    what that sitting will be rather than what the last one was. Without this a due review
   *    reached by a link was shown as an ordinary lesson, with no recall and no review turn
   *    (M7 review finding H-2).
   *  - **Current.** The sitting's own stored purpose, which is fixed for the sitting: a review
   *    the learner has just answered is still the review they sat down to (finding M-2).
   */
  const finished = session.closedAt !== null
  const lapsed = !finished && sittingHasLapsed(session, now)
  const purpose = lapsed
    ? sittingFor(db, session.conceptId, now, session.turns.length > 0)
    : { mode: session.mode, reason: session.resumedReason ?? session.openedReason }

  const reviewing = !finished && purpose.mode === 'review'
  // Whether recall leads the controls: a review the selector would still treat as one. The same
  // function the check selector uses, so the page and the selector cannot disagree.
  // Never on a finished conversation: the header says it is finished, and a filled "Start by
  // recalling it" beneath that would be the page describing two different states at once.
  const recallLeads = finished
    ? false
    : lapsed
      ? reviewing && isReviewDue(readConceptState(db, session.conceptId), now)
      : isReviewingNow(db, session, now)

  /*
   * Checks are looked up by the turn they sit on, so the runner can interleave them with the
   * prose in one ordered sequence. The answer key is stripped here, on the server, by
   * `presentActivity` — the browser is sent the question and nothing it could mark itself with.
   */
  const activities = readSessionActivities(db, session.id)
  const checks = activities.map((activity) => ({
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
    .map((exercise) => ({ turnId: exercise.turnId, view: viewOfExercise(exercise, now) }))
  const exercisePending = storedExercises.some((exercise) => exercise.verification === 'unverified')

  return (
    <div className={styles.page}>
      <nav className={styles.breadcrumb}>
        <Link href="/home">Where you are</Link>
      </nav>

      <header className={styles.header}>
        {/*
          What this sitting is for, in a word. A session is taught once and revisited later, so
          the heading says which of those is happening today rather than what happened the first
          time. Both the word and the reason below it come from the scheduler's own decision,
          stored when the session was opened (ADR-0032).
        */}
        <p className={styles.eyebrow} data-testid="session-mode">
          {finished ? 'Finished for now' : reviewing ? 'Reviewing' : 'Working on'}
        </p>
        <h1>{concept.title}</h1>
        <p className={styles.lead}>{concept.summary}</p>
        {finished ? (
          <p className={styles.reason} data-testid="session-reason">
            You finished with this conversation. It is all still here, and writing below picks it
            up again.
          </p>
        ) : (
          purpose.reason.length > 0 && (
            <p className={styles.reason} data-testid="session-reason">
              {purpose.reason}
            </p>
          )
        )}
        {reviewing && (
          <p className={styles.reason} data-testid="review-note">
            Start by trying to recall it. Bringing something back to mind is what makes it stay —
            more than reading it again would.
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
        recallAsked={!lapsed && activities.some((activity) => activity.createdAt >= session.resumedAt)}
        resume={lapsed}
        review={recallLeads}
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
