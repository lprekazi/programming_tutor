'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { ExerciseView, SubmissionView } from '@/domain/exercises/view'
import { learnerTraceback } from '@/domain/exercises/traceback'
import { runChecks } from '@/python/practical'
import { PythonRunner, type RunnerStatus } from '@/python/runner'
import type { RunResult } from '@/python/protocol'
import { TutorProse } from '@/ui/components/TutorProse'

import { askExerciseHint, saveExerciseDraft, submitExercise } from '../../exercise-actions'
import { CodeEditor } from './CodeEditor'
import styles from './page.module.css'

/**
 * One programming exercise, inside the conversation.
 *
 * A single readable column: the task, the checks it will be run against, one editor, a small
 * output area, and the result. No file tree, no terminal, no tabs — the brief asked for a focused
 * place to write a few lines of Python, not a small IDE.
 *
 * Two actions are kept firmly apart, because they mean different things:
 *
 *   - **Run** is for trying things. It executes the code in the browser and shows what happened.
 *     It is never recorded, never marked, and changes nothing about the learner.
 *   - **Submit** runs the checks and records the result. The first submission that can be marked
 *     is the one that counts; later ones are marked so the learner can see their code working.
 *
 * All Python runs in a Web Worker in this browser tab (ADR-0007). A program that never ends is
 * stopped by terminating the worker, and a fresh one is started straight away, so one runaway loop
 * never needs a page reload.
 */

interface Props {
  readonly view: ExerciseView
}

/** How long typing has to pause before the code is saved. */
const SAVE_AFTER_MS = 800

/**
 * `checking` runs the checks in the browser and can still be stopped; `recording` has handed the
 * result to the server and cannot.
 */
type Phase = 'idle' | 'running' | 'checking' | 'recording'

/** Where focus goes after something the learner did changes the page under them. */
type FocusTarget = 'status' | 'result' | 'hint' | 'problem'

interface RunDisplay {
  readonly output: string
  readonly traceback: string | null
  readonly note: string
}

function describeRun(result: RunResult): RunDisplay {
  switch (result.status) {
    case 'ok':
      return { output: result.stdout, traceback: null, note: 'Finished.' }
    case 'error':
      return {
        output: result.stdout,
        traceback: learnerTraceback(result.error.traceback),
        note: `It stopped with ${result.error.type}.`,
      }
    case 'timeout':
      return {
        output: result.stdout,
        traceback: null,
        note: `Stopped after ${String(Math.round(result.timeoutMs / 1000))} seconds, because it was still running. If it has a loop, check that the loop can end.`,
      }
    case 'stopped':
      return { output: result.stdout, traceback: null, note: 'Stopped.' }
    case 'unavailable':
      return { output: '', traceback: null, note: result.message }
  }
}

const RESULT_HEADING: Readonly<Record<SubmissionView['state'], string>> = {
  passed: 'Every check passes',
  failed: 'Not yet',
  crashed: 'It stopped with an error',
  unmarked: 'Not marked',
}

export function Exercise({ view: initialView }: Props) {
  const exercise = initialView.exercise
  const [view, setView] = useState(initialView)
  const [code, setCode] = useState(initialView.code)
  const [phase, setPhase] = useState<Phase>('idle')
  const [interpreter, setInterpreter] = useState<RunnerStatus>('idle')
  const [run, setRun] = useState<RunDisplay | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [hintBusy, setHintBusy] = useState(false)
  // A counter as well as a target, so the same target taking focus twice in a row still moves it.
  const [focusRequest, setFocusRequest] = useState<{ readonly target: FocusTarget; readonly nonce: number } | null>(null)

  const runnerRef = useRef<PythonRunner | null>(null)
  const submittingRef = useRef(false)
  const resultRef = useRef<HTMLHeadingElement | null>(null)
  const statusRef = useRef<HTMLParagraphElement | null>(null)
  const problemRef = useRef<HTMLParagraphElement | null>(null)
  const newestHintRef = useRef<HTMLLIElement | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<{ code: string; editedAt: number } | null>(null)

  const ids = {
    title: `exercise-title-${exercise.id}`,
    editorLabel: `exercise-editor-label-${exercise.id}`,
    editorHelp: `exercise-editor-help-${exercise.id}`,
  }

  useEffect(() => {
    const runner = new PythonRunner({ onStatusChange: setInterpreter })
    runnerRef.current = runner
    // Loaded as soon as the exercise is on the page, not on the first press of Run.
    runner.warmUp()
    return () => {
      runner.dispose()
      runnerRef.current = null
    }
  }, [])

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    const pending = pendingSaveRef.current
    pendingSaveRef.current = null
    if (pending === null) return
    try {
      await saveExerciseDraft(exercise.id, pending.code, pending.editedAt)
    } catch {
      // A failed save costs at most the last few keystrokes of a draft, and the next edit or run
      // tries again. It is not worth interrupting the learner for.
    }
  }, [exercise.id])

  // Saved when the learner is not done, flushed before anything that reads the stored code, and
  // flushed on the way out. Never evidence of anything.
  useEffect(() => () => void flushSave(), [flushSave])

  const onChange = useCallback(
    (next: string) => {
      setCode(next)
      pendingSaveRef.current = { code: next, editedAt: Date.now() }
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => void flushSave(), SAVE_AFTER_MS)
    },
    [flushSave],
  )

  const moveFocus = useCallback((target: FocusTarget) => {
    setFocusRequest((current) => ({ target, nonce: (current?.nonce ?? 0) + 1 }))
  }, [])

  // The button a keyboard user pressed often disappears or is disabled by what it did — Stop turns
  // back into Run, Submit is disabled while checking, the hint button goes when the ladder ends —
  // which drops focus to the top of the page. Focus goes instead to what changed: the result, the
  // newest hint, the problem, or the status line saying what happened (M6 review finding F-16).
  useEffect(() => {
    if (focusRequest === null) return
    const element = {
      status: statusRef.current,
      result: resultRef.current,
      hint: newestHintRef.current,
      problem: problemRef.current,
    }[focusRequest.target]
    element?.focus()
  }, [focusRequest])

  const runCode = useCallback(() => {
    const runner = runnerRef.current
    if (runner === null || phase !== 'idle') return

    setPhase('running')
    setProblem(null)
    setRun({ output: '', traceback: null, note: '' })
    setStatus('Running your code.')

    let streamed = ''
    void runner
      .run(code, {
        onOutput: (_stream, text) => {
          streamed += text
          setRun({ output: streamed, traceback: null, note: '' })
        },
      })
      .then((result) => {
        const display = describeRun(result)
        setRun(display)
        setStatus(display.note)
        // A stopped or timed-out run took the worker with it. Start its replacement now, so the
        // next Run does not wait for Python to load from scratch.
        if (result.status === 'stopped' || result.status === 'timeout') {
          runner.warmUp()
          moveFocus('status')
        }
      })
      .finally(() => {
        setPhase('idle')
      })
  }, [code, moveFocus, phase])

  const stop = useCallback(() => {
    runnerRef.current?.stop()
  }, [])

  const submit = useCallback(() => {
    const runner = runnerRef.current
    // A ref, not state: two clicks in one frame both see the same state, and only one may submit.
    if (runner === null || submittingRef.current || phase !== 'idle') return
    submittingRef.current = true

    setPhase('checking')
    setProblem(null)
    setStatus('Running the checks.')

    void (async () => {
      try {
        await flushSave()
        const checked = await runChecks(runner, code, exercise.checks)

        if (checked.status === 'stopped') {
          setStatus('Stopped. Nothing was submitted.')
          runner.warmUp()
          moveFocus('status')
          return
        }
        if (checked.status === 'unavailable') {
          setProblem(`${checked.message} Nothing was submitted.`)
          setStatus(null)
          moveFocus('problem')
          return
        }

        setRun({
          output: checked.output,
          traceback: checked.traceback,
          note: checked.outcome.kind === 'timeout' ? 'It did not finish in time.' : '',
        })
        if (checked.outcome.kind === 'timeout') runner.warmUp()

        // From here the result is with the server. Stopping now would stop nothing.
        setPhase('recording')
        setStatus('Recording the result.')
        const result = await submitExercise(exercise.id, code, checked.outcome, checked.output)

        if (result.status === 'rejected') {
          setProblem(result.message)
          setStatus(null)
          moveFocus('problem')
          return
        }

        const latest = result.view.submissions.at(-1)
        setView(result.view)
        // Also when the same code was submitted again and the result is unchanged.
        if (latest !== undefined) moveFocus('result')
        setStatus(latest === undefined ? null : `${RESULT_HEADING[latest.state]}. ${latest.checksLine}`)
      } catch {
        setProblem('That could not be submitted just now. Your code is still here — try again.')
        setStatus(null)
        moveFocus('problem')
      } finally {
        submittingRef.current = false
        setPhase('idle')
      }
    })()
  }, [code, exercise.checks, exercise.id, flushSave, moveFocus, phase])

  const askHint = useCallback(() => {
    if (hintBusy) return
    setHintBusy(true)
    setProblem(null)

    const depth = view.hints.length + 1
    askExerciseHint(exercise.id, depth, code)
      .then((result) => {
        if (result.status === 'given') {
          setView((current) =>
            current.hints.some((hint) => hint.depth === result.depth)
              ? current
              : { ...current, hints: [...current.hints, { depth: result.depth, text: result.text }] },
          )
          setStatus(`Hint ${String(result.depth)} of ${String(view.hintLadderLength)} added below the editor.`)
          moveFocus('hint')
        } else {
          setProblem(result.message)
          moveFocus('problem')
        }
      })
      .catch(() => {
        setProblem('A hint could not be fetched just now.')
        moveFocus('problem')
      })
      .finally(() => {
        setHintBusy(false)
      })
  }, [code, exercise.id, hintBusy, moveFocus, view.hintLadderLength, view.hints.length])

  // Python that failed to start is offered another go, rather than a page reload (F-12).
  const restartPython = useCallback(() => {
    runnerRef.current?.warmUp()
  }, [])

  const ready = interpreter === 'ready'
  const busy = phase !== 'idle'
  const latest = view.submissions.at(-1) ?? null
  const earlier = view.submissions.slice(0, -1)
  const hintsLeft = view.hintLadderLength - view.hints.length

  return (
    <section aria-labelledby={ids.title} className={styles.exercise} data-exercise-id={exercise.id} data-testid="exercise">
      <p className={styles.speaker}>Exercise</p>
      <p className={styles.checkGround} data-testid="exercise-ground">
        {exercise.ground}
      </p>
      <h3 className={styles.exerciseTitle} data-testid="exercise-title" id={ids.title}>
        {exercise.title}
      </h3>
      <p className={styles.brief} data-testid="exercise-brief">
        {exercise.brief}
      </p>

      <div className={styles.checkList}>
        <p className={styles.label}>Your code will be checked for</p>
        <ul data-testid="exercise-checks">
          {exercise.checks.map((check) => (
            <li key={check.name}>{check.name}</li>
          ))}
        </ul>
      </div>

      <div className={styles.editorBlock}>
        <p className={styles.label} id={ids.editorLabel}>
          Your code
        </p>
        <p className={styles.help} id={ids.editorHelp}>
          Tab indents. To move on from the editor with the keyboard, press Escape and then Tab.
        </p>
        <CodeEditor
          describedBy={ids.editorHelp}
          initialCode={initialView.code}
          labelledBy={ids.editorLabel}
          onChange={onChange}
          readOnly={phase === 'checking' || phase === 'recording'}
          testId="exercise-editor"
        />
      </div>

      <div className={styles.runControls}>
        {/* Stop stands in for Run while anything of the learner's is running, checks included (F-13). */}
        {phase === 'running' || phase === 'checking' ? (
          <button className={styles.secondary} data-testid="exercise-stop" onClick={stop} type="button">
            Stop
          </button>
        ) : (
          <button
            className={styles.secondary}
            data-testid="exercise-run"
            disabled={!ready || busy}
            onClick={runCode}
            type="button"
          >
            Run
          </button>
        )}
        {!view.finished && (
          <button
            className={styles.primary}
            data-testid="exercise-submit"
            disabled={!ready || busy}
            onClick={submit}
            type="button"
          >
            {phase === 'checking' || phase === 'recording' ? 'Checking…' : 'Submit'}
          </button>
        )}
        {!view.finished && hintsLeft > 0 && (
          <button
            className={styles.quietButton}
            data-testid="exercise-hint-ask"
            disabled={hintBusy}
            onClick={askHint}
            type="button"
          >
            {view.hints.length === 0
              ? 'Give me a hint'
              : `Another hint (${String(view.hints.length + 1)} of ${String(view.hintLadderLength)})`}
          </button>
        )}
        {interpreter !== 'ready' && (
          <span className={styles.interpreter} data-testid="exercise-interpreter">
            {interpreter === 'unavailable' ? 'Python could not start in this browser.' : 'Python is starting…'}
          </span>
        )}
        {interpreter === 'unavailable' && !busy && (
          <button className={styles.quietButton} data-testid="exercise-restart" onClick={restartPython} type="button">
            Try starting Python again
          </button>
        )}
      </div>

      {/* Always in the document, so its first message is announced. */}
      <p
        aria-live="polite"
        className={status === null ? 'visually-hidden' : styles.exerciseStatus}
        data-testid="exercise-status"
        ref={statusRef}
        tabIndex={-1}
      >
        {status ?? ''}
      </p>

      {problem !== null && (
        <p className={styles.bad} data-testid="exercise-problem" ref={problemRef} role="alert" tabIndex={-1}>
          {problem}
        </p>
      )}

      {view.hints.length > 0 && (
        <ol className={styles.hints} data-testid="exercise-hints">
          {view.hints.map((hint, index) => (
            <li
              className={styles.hint}
              data-testid={`exercise-hint-${String(hint.depth)}`}
              key={hint.depth}
              ref={index === view.hints.length - 1 ? newestHintRef : undefined}
              tabIndex={-1}
            >
              <span className={styles.hintLabel}>
                Hint {hint.depth} of {view.hintLadderLength}
              </span>{' '}
              {hint.text}
            </li>
          ))}
        </ol>
      )}

      <div className={styles.outputBlock}>
        <p className={styles.label}>What happened when it ran</p>
        {run === null ? (
          <p className={styles.outputEmpty} data-testid="exercise-output-empty">
            Output appears here when you run your code.
          </p>
        ) : (
          <>
            {/* The learner's own output, as text. Nothing here interprets it. */}
            <pre className={styles.output} data-testid="exercise-output">
              {run.output.length === 0 && run.traceback === null ? '(no output)' : run.output}
            </pre>
            {run.traceback !== null && (
              <pre className={styles.traceback} data-testid="exercise-traceback">
                {run.traceback}
              </pre>
            )}
            {run.note.length > 0 && (
              <p className={styles.runNote} data-testid="exercise-run-note">
                {run.note}
              </p>
            )}
          </>
        )}
      </div>

      {latest !== null && (
        <div
          className={
            latest.state === 'passed'
              ? styles.verdictGood
              : latest.state === 'unmarked'
                ? styles.verdictUnmarked
                : styles.verdictBad
          }
          data-testid="exercise-result"
        >
          <h4 className={styles.verdictHeading} data-testid="exercise-result-heading" ref={resultRef} tabIndex={-1}>
            {RESULT_HEADING[latest.state]}
          </h4>
          <p data-testid="exercise-checks-line">{latest.checksLine}</p>

          {latest.checks.length > 0 && (
            <ul className={styles.checkResults}>
              {latest.checks.map((check, index) => (
                <li data-outcome={check.outcome} data-testid={`exercise-check-${String(index)}`} key={check.name}>
                  <span className={styles.checkWord}>{check.outcome === 'pass' ? 'Passes' : 'Does not pass'}</span>{' '}
                  {check.name}
                  {check.outcome === 'fail' && check.error !== null && check.error !== 'AssertionError' && (
                    <span className={styles.checkError}> — raised {check.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {latest.feedbackStatus === 'given' && latest.feedback !== null && (
            <div className={styles.notes} data-testid="exercise-feedback">
              <p className={styles.notesLabel}>The tutor’s notes</p>
              <TutorProse text={latest.feedback.summary} />
              {latest.feedback.observations.map((observation) => (
                <p key={`${observation.where}-${observation.what}`}>
                  <strong>{observation.where}:</strong> {observation.what}
                </p>
              ))}
              <p>
                <strong>Next:</strong> {latest.feedback.nextStep}
              </p>
            </div>
          )}
          {latest.feedbackStatus === 'pending' && (
            <p className={styles.attribution} data-testid="exercise-feedback-pending">
              The tutor’s notes are still being written. The checks above are the result; reload in a moment to see
              the notes.
            </p>
          )}
          {latest.feedbackStatus === 'unavailable' && (
            <p className={styles.attribution} data-testid="exercise-feedback-unavailable">
              Detailed feedback is not available right now. The checks above are the result.
            </p>
          )}

          <p className={styles.attribution} data-testid="exercise-attribution">
            {attributionFor(latest)}
          </p>
        </div>
      )}

      {earlier.length > 0 && (
        <details className={styles.earlier}>
          <summary>Earlier submissions</summary>
          <ol>
            {earlier.map((submission) => (
              <li key={submission.id}>
                {RESULT_HEADING[submission.state]} — {submission.checksLine}
                {submission.counted ? ' This is the one that counted.' : ''}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}

/**
 * What the submission did, said plainly. Never "+1", never a score.
 *
 * The rule the learner most needs to know is also the least obvious one: only the first markable
 * submission counts. Saying so on every later submission is what stops the second, passing one
 * reading like it changed something.
 */
function attributionFor(submission: SubmissionView): string {
  if (submission.state === 'unmarked') {
    return 'Nothing has been recorded for this one, so it has not changed what the tutor thinks you know.'
  }

  const how = 'Marked by running your code against the checks.'

  if (!submission.counted) {
    return `${how} Your first marked submission is the one that counted; this one is for you, so you can see it working.`
  }

  const hints =
    submission.state === 'passed' && submission.hintsTaken > 0
      ? ` You took ${submission.hintsTaken === 1 ? 'a hint' : `${String(submission.hintsTaken)} hints`} first, which is noted — it counts for a little less than working it out unaided, and never against you.`
      : ''

  return `${how} This helps the tutor decide what to practise next.${hints}`
}
