/// <reference lib="webworker" />

/**
 * Python execution worker.
 *
 * Runs learner-supplied (or generated) Python through Pyodide, entirely inside the
 * browser. Nothing here ever touches the Node server.
 *
 * The worker has no cancellation of its own: Python running a tight loop blocks this
 * thread completely. That is deliberate — the main thread cancels by terminating the
 * whole worker, which cannot be ignored by any code running inside it. See
 * ADR-0007 for why this was chosen over `setInterruptBuffer`, which would require
 * SharedArrayBuffer and therefore cross-origin isolation of the whole application.
 */

import type { loadPyodide as LoadPyodide, PyodideAPI } from 'pyodide'
import type { PyProxy } from 'pyodide/ffi'
import type { WorkerEvent, WorkerRequest } from './protocol'

declare const self: DedicatedWorkerGlobalScope

/** Where `scripts/copy-pyodide.mjs` places the runtime. */
const PYODIDE_BASE = '/pyodide/'

function post(event: WorkerEvent): void {
  self.postMessage(event)
}

interface PyodideModule {
  readonly loadPyodide: typeof LoadPyodide
  readonly version: string
}

/**
 * Loads `pyodide.mjs` from our own origin at runtime.
 *
 * The specifier is built dynamically so that the bundler treats it as an external
 * URL rather than trying to resolve and inline Pyodide's Emscripten output, which it
 * cannot do correctly.
 */
async function importPyodide(): Promise<PyodideModule> {
  const url = new URL(`${PYODIDE_BASE}pyodide.mjs`, self.location.origin).href
  return (await import(/* webpackIgnore: true */ /* @vite-ignore */ url)) as PyodideModule
}

let currentRunId: string | null = null

function emitOutput(stream: 'stdout' | 'stderr', text: string): void {
  if (currentRunId === null) return
  post({ type: 'output', runId: currentRunId, stream, text: `${text}\n` })
}

async function boot(): Promise<PyodideAPI> {
  const { loadPyodide, version } = await importPyodide()
  const pyodide = await loadPyodide({
    indexURL: new URL(PYODIDE_BASE, self.location.origin).href,
    stdout: (message) => { emitOutput('stdout', message) },
    stderr: (message) => { emitOutput('stderr', message) },
  })
  const pythonVersion = pyodide.runPython('import sys; sys.version.split()[0]') as string
  post({ type: 'ready', pythonVersion, pyodideVersion: version })
  return pyodide
}

const booting = boot().catch((cause: unknown) => {
  post({ type: 'fatal', message: cause instanceof Error ? cause.message : String(cause) })
  return null
})

/**
 * Splits a Pyodide `PythonError` message into its parts.
 *
 * Pyodide puts the whole formatted traceback in `error.message`, whose final
 * non-empty line is `ExceptionType: message`.
 */
function describeError(cause: unknown): { type: string; message: string; traceback: string } {
  const traceback = cause instanceof Error ? cause.message : String(cause)
  const lines = traceback.trimEnd().split('\n')
  const lastLine = lines[lines.length - 1] ?? ''
  const separator = lastLine.indexOf(': ')

  if (separator > 0) {
    return {
      type: lastLine.slice(0, separator),
      message: lastLine.slice(separator + 2),
      traceback,
    }
  }
  return { type: lastLine || 'Error', message: lastLine, traceback }
}

/**
 * Anything can be posted to a worker, so the payload is narrowed at runtime rather
 * than trusted to match the declared type.
 */
function asRunRequest(data: unknown): WorkerRequest | null {
  if (typeof data !== 'object' || data === null) return null
  const candidate = data as Partial<WorkerRequest>
  if (candidate.type !== 'run') return null
  if (typeof candidate.runId !== 'string' || typeof candidate.code !== 'string') return null
  return { type: 'run', runId: candidate.runId, code: candidate.code }
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  void (async () => {
    const request = asRunRequest(event.data)
    if (request === null) return

    const pyodide = await booting
    if (pyodide === null) return

    currentRunId = request.runId
    const startedAt = performance.now()

    // A fresh namespace per run: variables defined by an earlier attempt must not
    // silently keep a later, broken attempt working.
    //
    // `__name__` is set because a script run as a file has it, and without it the lookup falls
    // through to the builtins module and reads "builtins" — so a learner's
    // `if __name__ == "__main__":` block silently never ran (M6 review finding F-11).
    const namespace = pyodide.toPy({ __name__: '__main__' }) as PyProxy
    try {
      await pyodide.runPythonAsync(request.code, { globals: namespace, filename: 'main.py' })
      post({ type: 'completed', runId: request.runId, durationMs: performance.now() - startedAt })
    } catch (cause: unknown) {
      /*
       * Only a Python exception is the program's failure. Anything else — Pyodide itself having
       * failed and refusing further work — is the interpreter's, and reporting it as the
       * program's would let a dead interpreter mark a learner's correct code as having crashed
       * (M6 review finding F-15). It is reported as fatal instead, so the runner discards this
       * worker and the next run starts a fresh one.
       */
      if (!(cause instanceof pyodide.ffi.PythonError)) {
        post({ type: 'fatal', message: cause instanceof Error ? cause.message : String(cause) })
        return
      }
      post({
        type: 'failed',
        runId: request.runId,
        durationMs: performance.now() - startedAt,
        error: describeError(cause),
      })
    } finally {
      namespace.destroy()
      currentRunId = null
    }
  })()
})
