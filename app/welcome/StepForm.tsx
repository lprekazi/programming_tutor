'use client'

import { useActionState, type ReactNode } from 'react'

import { goBackTo, type StepResult } from '../actions'
import styles from './page.module.css'

/**
 * One onboarding step's form, with somewhere to say what went wrong.
 *
 * The whole reason this is a client component is the error slot. A server action that declines
 * to advance — a goal of three spaces, which the browser's `required` check lets through —
 * used to reload the page unchanged, leaving the learner pressing Continue and watching
 * nothing happen. That is indistinguishable from the application being broken.
 */

interface Props {
  readonly action: (formData: FormData) => Promise<StepResult>
  readonly children: ReactNode
  readonly submitLabel: string
  readonly submitTestId: string
  /** The earlier step to offer a way back to, where there is one. */
  readonly back?: { readonly step: 'goal' | 'experience'; readonly label: string }
}

const START: StepResult = { status: 'idle' }

export function StepForm({ action, children, submitLabel, submitTestId, back }: Props) {
  const [state, submit, pending] = useActionState(
    async (_previous: StepResult, formData: FormData) => await action(formData),
    START,
  )

  return (
    <form action={submit} className={styles.form}>
      {children}

      {state.status === 'invalid' && (
        <p className={styles.error} data-testid="step-error" role="alert">
          {state.message}
        </p>
      )}

      {state.status === 'already-done' && (
        <p className={styles.error} role="alert">
          These questions are already answered. Reload the page to carry on from where you are.
        </p>
      )}

      <div className={styles.stepActions}>
        <button className={styles.primary} data-testid={submitTestId} disabled={pending} type="submit">
          {pending ? 'Saving…' : submitLabel}
        </button>

        {back !== undefined && (
          // A plain form rather than a link, because going back changes stored state. It is
          // deliberately quiet: useful when needed, not competing with Continue.
          <button
            className={styles.back}
            data-testid="step-back"
            disabled={pending}
            formAction={async () => {
              await goBackTo(back.step)
            }}
            type="submit"
          >
            {back.label}
          </button>
        )}
      </div>
    </form>
  )
}
