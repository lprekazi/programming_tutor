'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, useTransition } from 'react'

import { buildTestProgram, parseTestReport, type TestReport } from '@/domain/diagnostic/harness'
import type { PresentedItem } from '@/domain/diagnostic/present'
import type { RunResult } from '@/python/protocol'
import { PythonRunner, type RunnerStatus } from '@/python/runner'
import { AuthoredText } from '@/ui/components/AuthoredText'

import { skipDiagnosticItem, submitDiagnosticAnswer, type AnswerResult } from '../actions'
import styles from './DiagnosticRunner.module.css'

/**
 * One diagnostic question, and what happens after it is answered.
 *
 * The component knows how to collect an answer and, for the practical question, how to run it.
 * It does not know whether the answer is right: that is decided on the server, against material
 * this component was never sent. What comes back is a verdict plus how it was reached, and the
 * distinction is shown rather than smoothed over — a learner should be able to see that their
 * multiple choice was marked against a fixed answer while their written explanation was read by
 * a language model.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *   - **A run belongs to the code that produced it.** Editing the editor discards the previous
 *     result, so an answer can never be marked from a run of different code.
 *   - **Every path ends somewhere.** A model that cannot be reached, an interpreter that will
 *     not start, a request that fails — each has a visible outcome and a way forward, because
 *     a learner stuck on question three of the first thing they ever did here is a learner who
 *     closes the application.
 */

interface Props {
  readonly item: PresentedItem
  /** True when answering this question will certainly end the diagnostic. */
  readonly isLast: boolean
}

/** What the practical question produced locally, before anything is submitted. */
interface LocalRun {
  readonly result: RunResult
  readonly report: TestReport
  /** The exact source this result came from, so a later edit can invalidate it. */
  readonly source: string
}

/**
 * How the answer was marked, said plainly.
 *
 * The learner is told which of three very different things happened — a fixed answer, their
 * own code running, or a model reading their words — because those carry different weight and
 * pretending otherwise would be dishonest. What they are *not* told is how the tutor stores it:
 * "recorded as one piece of evidence" is the application describing its own database, which
 * tells a learner nothing they can act on.
 */
const MARKING: Readonly<Record<string, string>> = {
  deterministic: 'Checked against the expected answer.',
  execution: 'Checked by running your code against the checks.',
  model: 'Read by the tutor, which is a judgement rather than a fixed answer.',
}

function runSummary(result: RunResult): string {
  switch (result.status) {
    case 'ok':
      return 'Your program ran to the end.'
    case 'error':
      return `Your program stopped with an error: ${result.error.type}: ${result.error.message}`
    case 'timeout':
      return `Your program was still running after ${(result.timeoutMs / 1000).toFixed(0)} seconds and was stopped. That usually means a loop that never ends.`
    case 'stopped':
      return 'Stopped.'
    case 'unavailable':
      return result.message
  }
}

export function DiagnosticRunner({ item, isLast }: Props) {
  const router = useRouter()
  const [choice, setChoice] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [code, setCode] = useState(item.kind === 'code' ? item.starterCode : '')
  const [outcome, setOutcome] = useState<AnswerResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  // Refreshing is a transition so that React keeps the current question on screen until the
  // next one has arrived, rather than blanking it. `sending` is tracked separately because a
  // submission is a plain promise, and a transition around one that merely *starts* a promise
  // settles immediately — leaving the button enabled and unlabelled while the request is still
  // in flight, which is how a learner ends up submitting the same answer twice.
  const [refreshing, startRefresh] = useTransition()
  const busy = sending || refreshing

  const runnerRef = useRef<PythonRunner | null>(null)
  const verdictRef = useRef<HTMLParagraphElement | null>(null)
  const [pythonStatus, setPythonStatus] = useState<RunnerStatus>('idle')
  const [running, setRunning] = useState(false)
  const [localRun, setLocalRun] = useState<LocalRun | null>(null)

  useEffect(() => {
    if (item.kind !== 'code') return undefined

    const runner = new PythonRunner({ onStatusChange: setPythonStatus })
    runnerRef.current = runner
    // Loading Pyodide takes seconds on a cold start, so it begins while the learner is still
    // reading the question rather than after they press Run.
    runner.warmUp()
    return () => {
      runner.dispose()
      runnerRef.current = null
    }
  }, [item.kind])

  const handleRun = useCallback(() => {
    const runner = runnerRef.current
    if (runner === null || running || item.kind !== 'code') return

    const source = code
    setRunning(true)
    setLocalRun(null)
    setProblem(null)

    void runner
      .run(buildTestProgram(source, item.tests))
      .then((result) => {
        const stdout = 'stdout' in result ? result.stdout : ''
        setLocalRun({ result, report: parseTestReport(stdout, item.tests), source })
        // Both of these terminate the worker, so a replacement is started now rather than
        // making the learner wait for it on their next press.
        if (result.status === 'stopped' || result.status === 'timeout') runner.warmUp()
      })
      .catch((cause: unknown) => {
        setProblem(
          `Your code could not be run: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      })
      .finally(() => {
        setRunning(false)
      })
  }, [code, item, running])

  const handleStop = useCallback(() => {
    runnerRef.current?.stop()
  }, [])

  const submit = useCallback(() => {
    setProblem(null)

    let answer: string
    if (item.kind === 'choice') {
      if (choice === null) {
        setProblem('Choose one of the options first.')
        return
      }
      answer = String(choice)
    } else if (item.kind === 'code') {
      if (localRun === null) {
        setProblem('Run your code first — this question is judged on what the checks do.')
        return
      }
      answer = code
    } else {
      if (text.trim().length === 0) {
        setProblem('Write an answer first.')
        return
      }
      answer = text
    }

    const execution =
      item.kind === 'code' && localRun !== null
        ? {
            allTestsPassed: localRun.report.allTestsPassed,
            failedTests: localRun.report.failedTests,
            output: localRun.report.visibleOutput,
          }
        : null

    setSending(true)
    submitDiagnosticAnswer(item.id, answer, execution)
      .then((result) => {
        if (result.status === 'not-current') {
          // A stale tab, or the same answer arriving twice by another route. The page is
          // rebuilt from what is stored rather than guessing what the learner should see.
          startRefresh(() => {
            router.refresh()
          })
          return
        }
        setOutcome(result)
      })
      .catch((cause: unknown) => {
        // Never silent. The learner is told that nothing was recorded, which is true: the
        // server derives evidence only from an answer it managed to store.
        setProblem(
          `That could not be sent, so nothing has been recorded. ${
            cause instanceof Error ? cause.message : 'Try again.'
          }`,
        )
      })
      .finally(() => {
        setSending(false)
      })
  }, [choice, code, item, localRun, router, text])

  const goNext = useCallback(() => {
    startRefresh(() => {
      router.refresh()
    })
  }, [router])

  const skip = useCallback(() => {
    setSending(true)
    skipDiagnosticItem(item.id)
      .then(() => {
        startRefresh(() => {
          router.refresh()
        })
      })
      .catch(() => {
        setProblem('That could not be sent. Reloading the page will pick up where you are.')
      })
      .finally(() => {
        setSending(false)
      })
  }, [item.id, router])

  const judged = outcome !== null && (outcome.status === 'recorded' || outcome.status === 'already-answered')

  // Moving focus to the verdict does two jobs: a screen-reader user hears it, and a keyboard
  // user is left beside the control that comes next instead of back at the top of the page,
  // which is where the browser puts them when the Submit button they pressed is unmounted.
  useEffect(() => {
    if (judged) verdictRef.current?.focus()
  }, [judged])

  /*
   * The practical question is the one whose marking depends on the browser working. When the
   * interpreter will not start, the question cannot be marked at all, and offering a way past
   * it matters more than the theoretical possibility of someone claiming that falsely to skip
   * it: a set-aside question records nothing, so the only person affected is the learner, who
   * gets a narrower profile. Being stuck on it forever is far worse.
   */
  const cannotRun = item.kind === 'code' && pythonStatus === 'unavailable'
  const canSetAside = (outcome?.status === 'cannot-judge') || cannotRun

  return (
    <div className={styles.runner} data-item-id={item.id} data-testid="diagnostic-item">
      <p className={styles.prompt} data-testid="item-prompt">
        <AuthoredText value={item.prompt} />
      </p>

      {item.code !== null && (
        <pre className={styles.code} data-testid="item-code">
          <code>{item.code}</code>
        </pre>
      )}

      <fieldset className={styles.fieldset} disabled={judged || busy}>
        <legend className="visually-hidden">Your answer</legend>

        {item.kind === 'choice' && (
          <div aria-label="Options" className={styles.options} role="radiogroup">
            {item.options.map((option, index) => (
              <label className={styles.option} key={option}>
                <input
                  checked={choice === index}
                  data-testid={`option-${String(index)}`}
                  name="choice"
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

        {item.kind === 'predict-output' && (
          <>
            <label className={styles.label} htmlFor="answer">
              What it prints
            </label>
            <p className={styles.help} id="answer-help">
              One line per line of output. Capitalisation and the spaces around commas are not
              checked.
            </p>
            <textarea
              aria-describedby="answer-help"
              className={styles.textarea}
              data-testid="answer-input"
              id="answer"
              onChange={(event) => {
                setText(event.target.value)
              }}
              rows={4}
              spellCheck={false}
              value={text}
            />
          </>
        )}

        {item.kind === 'explain' && (
          <>
            <label className={styles.label} htmlFor="answer">
              Your answer
            </label>
            <p className={styles.help} id="answer-help">
              A sentence or two is plenty.
            </p>
            <textarea
              aria-describedby="answer-help"
              className={styles.textarea}
              data-testid="answer-input"
              id="answer"
              onChange={(event) => {
                setText(event.target.value)
              }}
              rows={5}
              value={text}
            />
          </>
        )}

        {item.kind === 'code' && (
          <>
            <label className={styles.label} htmlFor="answer">
              Your Python
            </label>
            <p className={styles.help} id="answer-help">
              Runs in your browser. Nothing you write is sent anywhere to be executed.
            </p>
            <textarea
              aria-describedby="answer-help"
              className={styles.editor}
              data-testid="answer-input"
              id="answer"
              onChange={(event) => {
                setCode(event.target.value)
                // The previous result described different code. Keeping it would let an
                // answer be marked from a run that never saw it.
                setLocalRun(null)
              }}
              rows={10}
              spellCheck={false}
              value={code}
            />

            <div className={styles.controls}>
              <button
                className={styles.secondary}
                data-testid="run-code"
                disabled={pythonStatus !== 'ready' || running}
                onClick={handleRun}
                type="button"
              >
                {running ? 'Running…' : 'Run the checks'}
              </button>
              <button
                className={styles.secondary}
                data-testid="stop-code"
                disabled={!running}
                onClick={handleStop}
                type="button"
              >
                Stop
              </button>
              {pythonStatus === 'starting' && <span className={styles.quiet}>Starting Python…</span>}
            </div>
          </>
        )}
      </fieldset>

      {/*
        Always mounted, so a screen reader is watching the region before anything appears in
        it. A live region inserted already populated is not reliably announced.
      */}
      <div aria-live="polite" className={styles.runResult} data-testid="run-result" hidden={localRun === null}>
        {localRun !== null && (
          <>
            <h2 className={styles.sectionHeading}>What happened when it ran</h2>
            <p className={localRun.result.status === 'ok' ? styles.quiet : styles.bad}>
              {runSummary(localRun.result)}
            </p>

            {localRun.report.visibleOutput.length > 0 && (
              <pre className={styles.output} data-testid="run-output">
                {localRun.report.visibleOutput}
              </pre>
            )}

            {'error' in localRun.result && (
              <pre className={styles.traceback} data-testid="run-traceback">
                {localRun.result.error.traceback}
              </pre>
            )}

            <h2 className={styles.sectionHeading}>Checks</h2>
            <ul className={styles.tests} data-testid="test-results">
              {localRun.report.results.map((test) => (
                <li className={test.passed ? styles.testPass : styles.testFail} key={test.name}>
                  <span aria-hidden="true" className={styles.testMark}>
                    {test.passed ? '✓' : '✗'}
                  </span>
                  <span className="visually-hidden">{test.passed ? 'Passed: ' : 'Failed: '}</span>
                  {test.name}
                  {test.error !== null && (
                    <span className={styles.testError}>
                      {' — '}
                      {test.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {localRun.report.incomplete && (
              <p className={styles.quiet}>
                Some checks never ran, because the program stopped first. A check that did not
                run counts as not passed.
              </p>
            )}
          </>
        )}
      </div>

      {problem !== null && (
        <p className={styles.bad} data-testid="answer-problem" role="alert">
          {problem}
        </p>
      )}

      {cannotRun && (
        <p className={styles.bad} data-testid="python-unavailable" role="alert">
          Python could not start in this browser, so this question cannot be marked. Reloading
          usually fixes it. If it does not, leave this one out — nothing will be assumed about
          it either way.
        </p>
      )}

      {outcome?.status === 'cannot-judge' && (
        <p className={styles.bad} data-testid="cannot-judge" role="alert">
          {outcome.message}
        </p>
      )}

      {outcome?.status === 'failed' && (
        <p className={styles.bad} role="alert">
          {outcome.message}
        </p>
      )}

      <div
        aria-live="polite"
        className={judged && outcome.correct ? styles.verdictGood : styles.verdictBad}
        data-testid="verdict"
        hidden={!judged}
      >
        {judged && (
          <>
            <p
              className={styles.verdictHeading}
              data-testid="verdict-heading"
              ref={verdictRef}
              tabIndex={-1}
            >
              {outcome.correct ? 'That is right.' : 'Not quite.'}
            </p>

            {outcome.correctAnswer !== null && !outcome.correct && (
              <p className={styles.expected}>
                The answer was <code data-testid="expected-answer">{outcome.correctAnswer}</code>.
              </p>
            )}

            {outcome.explanation.length > 0 && (
              <p className={styles.explanation} data-testid="verdict-explanation">
                <AuthoredText value={outcome.explanation} />
              </p>
            )}

            <p className={styles.attribution} data-testid="verdict-source">
              {MARKING[outcome.verdictSource] ?? 'Checked.'}{' '}
              {outcome.status === 'already-answered'
                ? 'You had already answered this one, so your answer is unchanged.'
                : 'This helps the tutor decide what to practise with you next.'}
            </p>
          </>
        )}
      </div>

      <div className={styles.actions}>
        {judged ? (
          <button
            className={styles.primary}
            data-testid="next-item"
            disabled={busy}
            onClick={goNext}
            type="button"
          >
            {isLast ? 'Finish' : 'Next question'}
          </button>
        ) : (
          <>
            <button
              className={styles.primary}
              data-testid="submit-answer"
              disabled={busy || cannotRun}
              onClick={submit}
              type="button"
            >
              {busy ? 'Checking…' : 'Submit'}
            </button>
            {canSetAside && (
              <button
                className={styles.secondary}
                data-testid="skip-item"
                disabled={busy}
                onClick={skip}
                type="button"
              >
                Leave this one out and carry on
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
