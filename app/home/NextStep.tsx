'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'

import type { ActivityKind } from '@/domain/scheduling/next-action'

import { startSession } from '../actions'
import styles from './page.module.css'

/**
 * The one thing the learner is being asked to do next.
 *
 * A client component only so that pressing the button twice cannot start two things. The
 * server makes that safe anyway — the session is unique on `(learner, concept)` — but a button
 * that visibly does nothing on the second press is better than one that silently relies on the
 * database to clean up after it.
 *
 * What the button says comes from the recommendation's own kind, not from a guess here, so the
 * word on the button, the sentence above it and the session that opens all describe the same
 * decision.
 */

interface Props {
  readonly conceptId: string
  readonly title: string
  readonly reason: string
  /** What "Why this?" opens onto: the scheduler's grounds, in the scheduler's own terms. */
  readonly grounds: readonly string[]
  /** Review, carrying on, or something new. */
  readonly activity: ActivityKind
  /** The data this page was rendered against (ADR-0034). */
  readonly generation: number
  /**
   * What the learner may start instead, when this is a review.
   *
   * Offered quietly under the review, never in place of it. Without it a review that cannot be
   * asked — the concept's questions used up, no provider to write another — would lead Home for
   * ever and keep every other concept out of reach (M7 review finding M-4).
   */
  readonly alternative?: { readonly conceptId: string; readonly title: string } | undefined
}

const LABEL: Readonly<Record<ActivityKind, string>> = {
  review: 'Start the review',
  continue: 'Continue',
  resume: 'Pick it up again',
  reopen: 'Go back to it',
  practise: 'Work on this',
  learn: 'Start learning',
}

const EYEBROW: Readonly<Record<ActivityKind, string>> = {
  review: 'Due for review',
  continue: 'Still going',
  resume: 'Left open',
  reopen: 'Finished earlier',
  practise: 'Worth another go',
  learn: 'New',
}

export function NextStep({ conceptId, title, reason, grounds, activity, generation, alternative }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const open = useCallback((target: string) => {
    setBusy(true)
    setProblem(null)

    void startSession(target, generation)
      .then((result) => {
        if (result.status === 'nothing-to-study') {
          setProblem('There is nothing to work on here just now.')
          setBusy(false)
          return
        }
        if (result.status === 'stale') {
          setProblem('This page was open before the data was deleted. Reload to start again.')
          setBusy(false)
          return
        }
        router.push(`/session/${result.sessionId}`)
      })
      .catch(() => {
        setProblem('That could not be started just now.')
        setBusy(false)
      })
  }, [generation, router])

  return (
    <div className={styles.nextStep}>
      {/* The kind is said in words as well as carried in an attribute: never colour alone. */}
      <p className={styles.kind} data-activity={activity} data-testid="next-kind">
        {EYEBROW[activity]}
      </p>
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
        onClick={() => {
          open(conceptId)
        }}
        type="button"
      >
        {busy ? 'Opening…' : LABEL[activity]}
      </button>

      {alternative !== undefined && (
        <div className={styles.alternative} data-testid="next-alternative">
          <p>Rather not review it now? The review will still be here afterwards.</p>
          <button
            className={styles.secondary}
            data-concept={alternative.conceptId}
            data-testid="start-alternative"
            disabled={busy}
            onClick={() => {
              open(alternative.conceptId)
            }}
            type="button"
          >
            Start {alternative.title.toLowerCase()} instead
          </button>
        </div>
      )}

      {problem !== null && (
        <p className={styles.problem} data-testid="next-problem" role="alert">
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
