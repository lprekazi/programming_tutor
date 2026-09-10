/**
 * Main-thread client for a Python worker.
 *
 * Cancellation model: the worker is terminated outright. Python executing a tight
 * loop cannot be interrupted cooperatively, so `stop()` and the timeout both kill the
 * worker and let the next run start a fresh one. Output produced before termination
 * is preserved and returned, which is what makes a runaway loop diagnosable rather
 * than just "it stopped".
 */

import {
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  type OutputStream,
  type RunResult,
  type WorkerEvent,
  type WorkerRequest,
} from './protocol'

export interface RunOptions {
  /** Wall-clock budget before the worker is terminated. */
  readonly timeoutMs?: number
  /** Called as output arrives, so the UI can show a long-running program's progress. */
  readonly onOutput?: (stream: OutputStream, text: string) => void
}

/**
 * Lifecycle of the interpreter itself, independent of any particular run.
 *
 * The UI needs this because loading Pyodide takes seconds on a cold start: a learner
 * should be told the interpreter is starting rather than pressing Run into silence.
 */
export type RunnerStatus =
  /** No worker yet. */
  | 'idle'
  /** A worker exists and Pyodide is loading. */
  | 'starting'
  /** The interpreter is up and can run code. */
  | 'ready'
  /** The interpreter could not be started. */
  | 'unavailable'

export interface PythonRunnerOptions {
  /** Overridden in unit tests to substitute a worker stub. */
  readonly createWorker?: WorkerFactory
  /** Notified whenever the interpreter's lifecycle state changes. */
  readonly onStatusChange?: (status: RunnerStatus) => void
}

interface PendingRun {
  readonly runId: string
  readonly settle: (result: RunResult) => void
  readonly onOutput: ((stream: OutputStream, text: string) => void) | undefined
  stdout: string
  stderr: string
  truncated: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

/** How the worker is expected to behave; swapped for a stub in unit tests. */
export type WorkerFactory = () => Worker

/**
 * Where `npm run build:workers` writes the compiled worker.
 *
 * The worker is compiled by `tsc` and served as a static asset rather than bundled by
 * Next.js: Turbopack emits worker chunks as classic scripts and ignores
 * `{ type: 'module' }`, and Pyodide requires a module worker because its Emscripten
 * output is an ES module. Compiling it separately also keeps the most safety-critical
 * part of the application free of bundler-specific behaviour.
 */
const WORKER_URL = '/workers/execution.worker.js'

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(WORKER_URL, { type: 'module', name: 'python-execution' })

export class PythonRunner {
  readonly #createWorker: WorkerFactory
  readonly #onStatusChange: ((status: RunnerStatus) => void) | undefined
  #worker: Worker | null = null
  #pending: PendingRun | null = null
  #status: RunnerStatus = 'idle'
  #pythonVersion: string | null = null
  #nextRunId = 0

  constructor(options: PythonRunnerOptions = {}) {
    this.#createWorker = options.createWorker ?? defaultWorkerFactory
    this.#onStatusChange = options.onStatusChange
  }

  /** Python version reported by the running interpreter, once it has booted. */
  get pythonVersion(): string | null {
    return this.#pythonVersion
  }

  get status(): RunnerStatus {
    return this.#status
  }

  get isReady(): boolean {
    return this.#status === 'ready'
  }

  get isRunning(): boolean {
    return this.#pending !== null
  }

  /**
   * Starts the interpreter without executing anything, so the first real run does not
   * pay the multi-megabyte load cost while the learner waits.
   */
  warmUp(): void {
    this.#ensureWorker()
  }

  async run(code: string, options: RunOptions = {}): Promise<RunResult> {
    if (this.#pending !== null) {
      return { status: 'unavailable', message: 'A program is already running.' }
    }

    const worker = this.#ensureWorker()
    const runId = `run-${String(++this.#nextRunId)}`
    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS

    return await new Promise<RunResult>((resolve) => {
      const pending: PendingRun = {
        runId,
        settle: resolve,
        onOutput: options.onOutput,
        stdout: '',
        stderr: '',
        truncated: false,
        timer: undefined,
      }
      pending.timer = setTimeout(() => {
        this.#finish({
          status: 'timeout',
          stdout: pending.stdout,
          stderr: pending.stderr,
          truncated: pending.truncated,
          timeoutMs,
        })
        this.#destroyWorker()
      }, timeoutMs)

      this.#pending = pending
      const request: WorkerRequest = { type: 'run', runId, code }
      worker.postMessage(request)
    })
  }

  /** Stops a running program by terminating the worker. Safe to call when idle. */
  stop(): void {
    const pending = this.#pending
    if (pending !== null) {
      this.#finish({
        status: 'stopped',
        stdout: pending.stdout,
        stderr: pending.stderr,
        truncated: pending.truncated,
      })
    }
    this.#destroyWorker()
  }

  /** Releases the worker entirely. The next run starts a new one. */
  dispose(): void {
    this.stop()
  }

  #setStatus(status: RunnerStatus): void {
    if (this.#status === status) return
    this.#status = status
    this.#onStatusChange?.(status)
  }

  #ensureWorker(): Worker {
    if (this.#worker !== null) return this.#worker

    const worker = this.#createWorker()
    this.#setStatus('starting')
    worker.addEventListener('message', (event: MessageEvent<WorkerEvent>) => {
      this.#handle(event.data)
    })
    worker.addEventListener('error', (event: ErrorEvent) => {
      this.#handle({ type: 'fatal', message: event.message || 'The Python worker failed to start.' })
    })
    this.#worker = worker
    return worker
  }

  #destroyWorker(): void {
    this.#worker?.terminate()
    this.#worker = null
    // A terminated worker leaves no interpreter behind; the next run starts one.
    this.#setStatus('idle')
  }

  #handle(event: WorkerEvent): void {
    switch (event.type) {
      case 'ready': {
        this.#pythonVersion = event.pythonVersion
        this.#setStatus('ready')
        return
      }
      case 'output': {
        const pending = this.#pending
        if (pending === null || pending.runId !== event.runId) return
        this.#appendOutput(pending, event.stream, event.text)
        return
      }
      case 'completed': {
        const pending = this.#pending
        if (pending === null || pending.runId !== event.runId) return
        this.#finish({
          status: 'ok',
          stdout: pending.stdout,
          stderr: pending.stderr,
          truncated: pending.truncated,
          durationMs: event.durationMs,
        })
        return
      }
      case 'failed': {
        const pending = this.#pending
        if (pending === null || pending.runId !== event.runId) return
        this.#finish({
          status: 'error',
          stdout: pending.stdout,
          stderr: pending.stderr,
          truncated: pending.truncated,
          durationMs: event.durationMs,
          error: event.error,
        })
        return
      }
      case 'fatal': {
        this.#finish({ status: 'unavailable', message: event.message })
        this.#destroyWorker()
        // Reported after the worker is gone, so the status reflects the failure rather
        // than the 'idle' that tearing the worker down would otherwise leave behind.
        this.#setStatus('unavailable')
        return
      }
    }
  }

  #appendOutput(pending: PendingRun, stream: OutputStream, text: string): void {
    const total = pending.stdout.length + pending.stderr.length
    if (total >= MAX_OUTPUT_CHARS) {
      pending.truncated = true
      return
    }

    const room = MAX_OUTPUT_CHARS - total
    const slice = text.length > room ? text.slice(0, room) : text
    if (slice.length < text.length) pending.truncated = true

    if (stream === 'stdout') pending.stdout += slice
    else pending.stderr += slice

    pending.onOutput?.(stream, slice)
  }

  #finish(result: RunResult): void {
    const pending = this.#pending
    if (pending === null) return
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.#pending = null
    pending.settle(result)
  }
}
