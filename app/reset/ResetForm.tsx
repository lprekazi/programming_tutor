'use client'

import { useActionState, useEffect, useRef } from 'react'

import { resetEverything, type ResetResult } from '../actions'
import styles from './page.module.css'

/**
 * The confirmation itself.
 *
 * A client component only because the learner needs to be told when what they typed did not
 * match — and told in the form, next to the field, rather than by nothing happening. Focus
 * returns to the field when that happens, so somebody working from the keyboard is put where
 * the correction has to be made rather than left on a button that refused.
 */

const START: ResetResult = { status: 'idle' }

export function ResetForm({ confirmation }: { readonly confirmation: string }) {
  const [state, action, pending] = useActionState(
    async (_previous: ResetResult, formData: FormData) => await resetEverything(formData),
    START,
  )

  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (state.status === 'mismatch') inputRef.current?.focus()
  }, [state])

  return (
    <form action={action} className={styles.form}>
      <label className={styles.label} htmlFor="confirmation">
        Type <strong>{confirmation}</strong> to confirm
      </label>
      <input
        aria-describedby={state.status === 'mismatch' ? 'confirmation-error' : undefined}
        aria-invalid={state.status === 'mismatch'}
        autoComplete="off"
        className={styles.input}
        data-testid="reset-confirmation"
        id="confirmation"
        name="confirmation"
        ref={inputRef}
        spellCheck={false}
        type="text"
      />

      {state.status === 'failed' && (
        <p className={styles.error} data-testid="reset-failed" role="alert">
          Your data could not be deleted just now, so nothing has been changed. Close anything
          else using the application and try again.
        </p>
      )}

      {state.status === 'mismatch' && (
        <p className={styles.error} data-testid="reset-error" id="confirmation-error" role="alert">
          That did not match, so nothing has been deleted. Type{' '}
          <strong>{confirmation}</strong> exactly, in capitals.
        </p>
      )}

      <button
        className={styles.destructive}
        data-testid="reset-confirm"
        disabled={pending}
        type="submit"
      >
        {pending ? 'Deleting…' : 'Delete everything and start again'}
      </button>
    </form>
  )
}
