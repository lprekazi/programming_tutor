/**
 * Message contract between the main thread and a Python worker.
 *
 * Two worker roles share this protocol:
 *   - the learner execution worker, which runs code the learner wrote;
 *   - the verification worker, which checks a generated exercise before it is shown.
 *
 * They are separate worker instances so that neither can observe the other's
 * interpreter state.
 */

/** Maximum captured output per run, in characters. Beyond this, output is truncated. */
export const MAX_OUTPUT_CHARS = 200_000

/** Default wall-clock budget for a single learner run, counted from when Python is ready. */
export const DEFAULT_RUN_TIMEOUT_MS = 10_000

/**
 * How long the interpreter may take to start before it is reported as unavailable.
 *
 * Separate from the run budget, and much longer, because they measure different things. Loading
 * Pyodide is roughly 13 MB on a cold start and varies with the machine and the network; a
 * learner's program is a few lines that finish in milliseconds. Counting one against the other
 * meant a slow start could report a trivial, correct program as having *timed out*.
 */
export const BOOT_TIMEOUT_MS = 60_000

export type OutputStream = 'stdout' | 'stderr'

export interface PythonErrorDetail {
  /** Exception class name, e.g. "ZeroDivisionError". */
  readonly type: string
  /** The exception message without the traceback. */
  readonly message: string
  /** The full formatted traceback as Python produced it. */
  readonly traceback: string
}

/** Sent from the main thread to a worker. */
export type WorkerRequest = {
  readonly type: 'run'
  readonly runId: string
  readonly code: string
}

/** Sent from a worker to the main thread. */
export type WorkerEvent =
  | { readonly type: 'ready'; readonly pythonVersion: string; readonly pyodideVersion: string }
  | { readonly type: 'output'; readonly runId: string; readonly stream: OutputStream; readonly text: string }
  | { readonly type: 'completed'; readonly runId: string; readonly durationMs: number }
  | {
      readonly type: 'failed'
      readonly runId: string
      readonly durationMs: number
      readonly error: PythonErrorDetail
    }
  | { readonly type: 'fatal'; readonly message: string }

/** What a caller gets back from `PythonRunner.run`. */
export type RunResult =
  | { readonly status: 'ok'; readonly stdout: string; readonly stderr: string; readonly truncated: boolean; readonly durationMs: number }
  | {
      readonly status: 'error'
      readonly stdout: string
      readonly stderr: string
      readonly truncated: boolean
      readonly durationMs: number
      readonly error: PythonErrorDetail
    }
  | { readonly status: 'timeout'; readonly stdout: string; readonly stderr: string; readonly truncated: boolean; readonly timeoutMs: number }
  | { readonly status: 'stopped'; readonly stdout: string; readonly stderr: string; readonly truncated: boolean }
  | { readonly status: 'unavailable'; readonly message: string }
