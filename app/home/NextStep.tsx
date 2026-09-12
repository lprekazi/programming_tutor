'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'

import { startSession } from '../actions'
import styles from './page.module.css'

/**
 * The one thing the learner is being asked to do next.
 *
 * A client component only so that pressing the button twice cannot start two things. The
 * server makes that safe anyway — the session is unique on `(learner, concept)` — but a button
 * that visibly does nothing on the second press is better than one that silently relies on the
 * database to clean up after it.
 */

interface Props {
  readonly conceptId: string
  readonly title: string
  readonly reason: string
  /** What "Why this?" opens onto: the scheduler's grounds, in the scheduler's own terms. */
  readonly grounds: readonly string[]
  /** True when there is already a conversation about this concept to carry on. */
  readonly continuing: boolean
}

export function NextStep({ conceptId, title, reason, grounds, continuing }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const start = useCallback(() => {
    setBusy(true)
    setProblem(null)

    void startSession(conceptId)
      .then((result) => {
        if (result.status === 'nothing-to-study') {
          setProblem('There is nothing to work on here just now.')
          setBusy(false)
          return
        }
        router.push(`/session/${result.sessionId}`)
      })
      .catch(() => {
        setProblem('That could not be started just now.')
        setBusy(false)
      })
  }, [conceptId, router])

  return (
    <div className={styles.nextStep}>
      <p className={styles.next} data-concept={conceptId} data-testid="next-concept">
        {title}
      </p>
      <p className={styles.body} data-testid="next-reason">
        {reason}
      </p>

      <button
        className={styles.primary}
        data-testid="start-session"
        disabled={busy}
        onClick={start}
        type="button"
      >
        {busy ? 'Opening…' : continuing ? 'Continue' : 'Start learning'}
      </button>

      {problem !== null && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}

      {/*
        Closed by default. A learner who wants to know why can look; one who does not is not
        made to read the scheduler's reasoning before they can start.
      */}
      <details className={styles.why}>
        <summary data-testid="why-this">Why this?</summary>
        <ul className={styles.grounds} data-testid="why-this-grounds">
          {grounds.map((ground) => (
            <li key={ground}>{ground}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}
