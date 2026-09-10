'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { PythonRunner, type RunnerStatus } from '@/python/runner'
import type { RunResult } from '@/python/protocol'

import styles from './PythonCheck.module.css'

const EXAMPLES = [
  {
    id: 'greeting',
    label: 'Print a message',
    code: 'print("Hello from Python")\n',
  },
  {
    id: 'error',
    label: 'Raise an error',
    code: 'numbers = [1, 2, 3]\nprint(numbers[7])\n',
  },
  {
    id: 'endless',
    label: 'A program that never ends',
    code: 'total = 0\nwhile True:\n    total += 1\n',
  },
] as const

type Phase = 'idle' | 'running' | 'finished'

/** One line of the transcript, so stdout and stderr stay visually distinguishable. */
interface OutputLine {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

function describe(result: RunResult): { tone: 'good' | 'bad' | 'neutral'; message: string } {
  switch (result.status) {
    case 'ok':
      return { tone: 'good', message: `Finished in ${result.durationMs.toFixed(0)} ms.` }
    case 'error':
      return { tone: 'bad', message: `${result.error.type}: ${result.error.message}` }
    case 'timeout':
      return {
        tone: 'bad',
        message: `Stopped automatically after ${(result.timeoutMs / 1000).toFixed(0)} seconds. The program was still running.`,
      }
    case 'stopped':
      return { tone: 'neutral', message: 'Stopped.' }
    case 'unavailable':
      return { tone: 'bad', message: result.message }
  }
}

export function PythonCheck() {
  const runnerRef = useRef<PythonRunner | null>(null)
  const [code, setCode] = useState<string>(EXAMPLES[0].code)
  const [phase, setPhase] = useState<Phase>('idle')
  const [status, setStatus] = useState<RunnerStatus>('idle')
  const [lines, setLines] = useState<OutputLine[]>([])
  const [summary, setSummary] = useState<{ tone: 'good' | 'bad' | 'neutral'; message: string } | null>(null)
  const [pythonVersion, setPythonVersion] = useState<string | null>(null)

  useEffect(() => {
    const runner = new PythonRunner({ onStatusChange: setStatus })
    runnerRef.current = runner
    // Start loading the interpreter now, not when the learner first presses Run: on a
    // cold start Pyodide is several megabytes and takes seconds.
    runner.warmUp()
    return () => {
      runner.dispose()
      runnerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (status === 'ready') setPythonVersion(runnerRef.current?.pythonVersion ?? null)
  }, [status])

  const handleRun = useCallback(() => {
    const runner = runnerRef.current
    if (runner === null || phase === 'running') return

    setLines([])
    setSummary(null)
    setPhase('running')

    void runner
      .run(code, {
        onOutput: (stream, text) => {
          setLines((previous) => [...previous, { stream, text }])
        },
      })
      .then((result) => {
        setSummary(describe(result))
        setPhase('finished')
        // Stopping and timing out both terminate the worker. Start a replacement now so
        // the learner can run again immediately rather than waiting on their next press.
        // A worker that failed to start is not retried automatically.
        if (result.status === 'stopped' || result.status === 'timeout') runner.warmUp()
      })
  }, [code, phase])

  const handleStop = useCallback(() => {
    runnerRef.current?.stop()
  }, [])

  const running = phase === 'running'
  // Run is offered only once the interpreter can actually honour it. After a run is
  // stopped the worker is gone, so the status returns to 'starting' while a new one boots.
  const canRun = status === 'ready' && !running

  return (
    <div className={styles.check}>
      <div className={styles.examples}>
        <span className={styles.examplesLabel}>Try</span>
        {EXAMPLES.map((example) => (
          <button
            className={styles.example}
            data-testid={`example-${example.id}`}
            key={example.id}
            onClick={() => {
              setCode(example.code)
            }}
            type="button"
          >
            {example.label}
          </button>
        ))}
      </div>

      <label className={styles.editorLabel} htmlFor="python-source">
        Python
      </label>
      <textarea
        className={styles.editor}
        data-testid="python-source"
        id="python-source"
        onChange={(event) => {
          setCode(event.target.value)
        }}
        rows={6}
        spellCheck={false}
        value={code}
      />

      <div className={styles.controls}>
        <button
          className={styles.run}
          data-testid="run"
          disabled={!canRun}
          onClick={handleRun}
          type="button"
        >
          {status === 'ready' || status === 'unavailable' ? 'Run' : 'Starting Python…'}
        </button>
        <button
          className={styles.stop}
          data-testid="stop"
          disabled={!running}
          onClick={handleStop}
          type="button"
        >
          Stop
        </button>
        {pythonVersion !== null && (
          <span className={styles.version} data-testid="python-version">
            Python {pythonVersion}
          </span>
        )}
      </div>

      <div aria-live="polite" className={styles.results}>
        {status === 'starting' && !running && (
          <p className={styles.status} data-testid="interpreter-status">
            Starting the Python interpreter. This takes a few seconds the first time.
          </p>
        )}
        {status === 'unavailable' && (
          <p className={styles.summaryBad} data-testid="interpreter-status">
            Python could not be started, so programming exercises will not run. Reloading the
            page usually fixes this.
          </p>
        )}
        {running && <p className={styles.status}>Running…</p>}

        {lines.length > 0 && (
          <pre className={styles.output} data-testid="output">
            {lines.map((line, index) => (
              <span
                className={line.stream === 'stderr' ? styles.stderr : undefined}
                // Output lines have no identity beyond their position in the transcript.
                key={index}
              >
                {line.text}
              </span>
            ))}
          </pre>
        )}

        {summary !== null && (
          <p
            className={
              summary.tone === 'good'
                ? styles.summaryGood
                : summary.tone === 'bad'
                  ? styles.summaryBad
                  : styles.summaryNeutral
            }
            data-testid="summary"
          >
            {summary.message}
          </p>
        )}
      </div>
    </div>
  )
}
