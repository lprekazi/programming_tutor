'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { PresentedActivity } from '@/domain/assessment/present'
import { TutorProse } from '@/ui/components/TutorProse'

import { askHint, submitActivityAnswer, type AnswerOutcome } from '../../actions'
import styles from './page.module.css'

/**
 * One check on understanding, inside the conversation.
 *
 * Deliberately not a quiz card. It sits in the same column as the teaching, under the same kind
 * of small label the tutor's turns carry, with a hairline rule instead of a border. No score, no
 * streak, no badge, no confetti — the brief rules those out, and they would also be answering a
 * question nobody asked: the learner is here to understand something, not to accumulate points.
 *
 * Correct and incorrect are distinguished by a word first and a restrained colour second, so
 * the distinction survives being unable to see the colour.
 */

interface Props {
  readonly activity: PresentedActivity
  /** An answer already given, when the page is being re-read after one. */
  readonly answered: AnsweredView | null
  /** The hint already taken, if any. */
  readonly hint: string | null
}

export interface AnsweredView {
  readonly response: string
  readonly marked: boolean
  readonly correct: boolean
  readonly partial: boolean
  readonly markedBy: 'deterministic' | 'model' | null
  readonly unmarkedReason: string | null
  readonly feedback: string
  readonly hintDepth: number
}

const MARKING: Readonly<Record<string, string>> = {
  deterministic: 'Marked against the expected answer.',
  model: 'Read and marked by the tutor. A judgement, not a fixed answer.',
}

export function Check({ activity, answered, hint }: Props) {
  const router = useRouter()
  const [choice, setChoice] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [outcome, setOutcome] = useState<AnswerOutcome | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hintText, setHintText] = useState<string | null>(hint)
  const verdictRef = useRef<HTMLParagraphElement | null>(null)

  const settled: AnsweredView | null =
    answered ??
    (outcome === null || outcome.status === 'rejected'
      ? null
      : outcome.status === 'unmarked'
        ? {
            response: activity.kind === 'choice' ? String(choice ?? '') : text,
            marked: false,
            correct: false,
            partial: false,
            markedBy: null,
            unmarkedReason: outcome.reason,
            feedback: outcome.reason,
            hintDepth: hintText === null ? 0 : 1,
          }
        : {
            response: activity.kind === 'choice' ? String(choice ?? '') : text,
            marked: true,
            correct: outcome.correct,
            partial: outcome.partial,
            markedBy: outcome.markedBy,
            unmarkedReason: null,
            feedback: outcome.feedback,
            hintDepth: hintText === null ? 0 : 1,
          })

  const submit = useCallback(() => {
    setProblem(null)

    const response = activity.kind === 'choice' ? (choice === null ? '' : String(choice)) : text
    if (response.trim().length === 0) {
      setProblem(activity.kind === 'choice' ? 'Choose one of the options first.' : 'Write an answer first.')
      return
    }

    setBusy(true)
    submitActivityAnswer(activity.id, response)
      .then((result) => {
        if (result.status === 'rejected') {
          // The draft is left alone: clearing it would throw away what the learner wrote
          // because the server said no.
          setProblem(result.message)
          return
        }
        setOutcome(result)
        // The band on the home page and the evidence log both move on a marked answer, so the
        // server's view is re-read rather than patched locally.
        router.refresh()
      })
      .catch(() => {
        setProblem('That could not be sent, so nothing has been recorded. Your answer is still here.')
      })
      .finally(() => {
        setBusy(false)
      })
  }, [activity.id, activity.kind, choice, router, text])

  const hintNow = useCallback(() => {
    setBusy(true)
    askHint(activity.id)
      .then((result) => {
        if (result.status === 'given') setHintText(result.text)
        else setProblem(result.message)
      })
      .catch(() => {
        setProblem('A hint could not be fetched just now.')
      })
      .finally(() => {
        setBusy(false)
      })
  }, [activity.id])

  const locked = settled !== null

  /*
   * Focus follows the answer, for the same two reasons the diagnostic does it: a screen-reader
   * user hears the verdict, and a keyboard user is left beside it rather than at the top of the
   * page — which is where the browser puts them when the button they pressed unmounts and the
   * fieldset around their answer is disabled, both of which happen here in the same update.
   */
  useEffect(() => {
    if (locked && answered === null) verdictRef.current?.focus()
  }, [answered, locked])

  return (
    <div className={styles.check} data-activity-id={activity.id} data-testid="check">
      <p className={styles.speaker}>Check your understanding</p>
      <p className={styles.checkGround} data-testid="check-ground">
        {activity.ground}
      </p>

      <p className={styles.prompt} data-testid="check-prompt">
        {activity.prompt}
      </p>

      {activity.code !== null && (
        <pre className={styles.code} data-testid="check-code">
          <code>{activity.code}</code>
        </pre>
      )}

      <fieldset className={styles.fieldset} disabled={locked || busy}>
        <legend className="visually-hidden">Your answer</legend>

        {activity.kind === 'choice' && (
          <div aria-label="Options" className={styles.options} role="radiogroup">
            {activity.options.map((option, index) => (
              <label className={styles.option} key={option}>
                <input
                  checked={locked ? settled.response === String(index) : choice === index}
                  data-testid={`check-option-${String(index)}`}
                  name={`answer-${activity.id}`}
                  onChange={() => {
                    setChoice(index)
                  }}
                  type="radio"
                  value={index}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        )}

        {activity.kind !== 'choice' && (
          <>
            <label className={styles.label} htmlFor={`answer-${activity.id}`}>
              {activity.kind === 'predict-output' ? 'What it prints' : 'Your answer'}
            </label>
            <p className={styles.help} id={`help-${activity.id}`}>
              {activity.kind === 'predict-output'
                ? 'One line per line of output. Capitalisation and the spaces around commas are not checked.'
                : 'A sentence or two is plenty.'}
            </p>
            <textarea
              aria-describedby={`help-${activity.id}`}
              className={styles.input}
              data-testid="check-input"
              id={`answer-${activity.id}`}
              onChange={(event) => {
                setText(event.target.value)
              }}
              rows={activity.kind === 'predict-output' ? 3 : 4}
              spellCheck={activity.kind !== 'predict-output'}
              value={locked ? settled.response : text}
            />
          </>
        )}
      </fieldset>

      {hintText !== null && (
        <p className={styles.hint} data-testid="check-hint">
          <span className={styles.hintLabel}>A nudge</span> {hintText}
        </p>
      )}

      {problem !== null && (
        <p className={styles.bad} data-testid="check-problem" role="alert">
          {problem}
        </p>
      )}

      {!locked && (
        <div className={styles.controls}>
          <button
            className={styles.primary}
            data-testid="check-submit"
            disabled={busy}
            onClick={submit}
            type="button"
          >
            {busy ? 'Checking…' : 'Answer'}
          </button>
          {hintText === null && (
            <button
              className={styles.secondary}
              data-testid="check-hint-ask"
              disabled={busy}
              onClick={hintNow}
              type="button"
            >
              Give me a nudge
            </button>
          )}
        </div>
      )}

      {/*
        The verdict, in a region that is already in the document before it has anything to say.

        It used to be inserted into the DOM in the same update as its first and only content,
        which is the one announcement assistive technology is least likely to make — the mistake
        `SessionRunner` documents at length for its own status region and deliberately avoids.
        Rendered empty and visually hidden until there is a verdict, so the region exists when
        the text arrives.
      */}
      <div
        aria-live="polite"
        className={
          !locked
            ? 'visually-hidden'
            : !settled.marked
              ? styles.verdictUnmarked
              : settled.correct
                ? styles.verdictGood
                : styles.verdictBad
        }
        data-testid="check-verdict"
      >
        {locked && (
          <>
            <p
              className={styles.verdictHeading}
              data-testid="check-verdict-heading"
              ref={verdictRef}
              tabIndex={-1}
            >
            {!settled.marked
              ? 'Not marked'
              : settled.correct
                ? settled.partial
                  ? 'Right, with something missing'
                  : 'Right'
                : 'Not right'}
            </p>

            <TutorProse text={settled.feedback} />

            <p className={styles.attribution} data-testid="check-attribution">
              {settled.marked
                ? `${MARKING[settled.markedBy ?? 'deterministic'] ?? 'Marked.'} This helps the tutor decide what to practise next.`
                : 'Nothing has been recorded for this one, so it has not changed what the tutor thinks you know.'}
              {settled.hintDepth > 0 && settled.marked && settled.correct
                ? ' You took a nudge first, which is noted — it counts for a little less than working it out unaided, and never against you.'
                : ''}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
