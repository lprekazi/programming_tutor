import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_OUTPUT_CHARS, type WorkerEvent, type WorkerRequest } from './protocol'
import { PythonRunner, type WorkerFactory } from './runner'

/**
 * Stands in for a real Web Worker so the runner's cancellation and lifecycle logic can
 * be tested deterministically, without loading Pyodide.
 */
class FakeWorker {
  static instances: FakeWorker[] = []

  readonly received: WorkerRequest[] = []
  terminated = false
  #listeners: ((event: { data: WorkerEvent }) => void)[] = []

  constructor() {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === 'message') this.#listeners.push(listener as (event: { data: WorkerEvent }) => void)
  }

  postMessage(request: WorkerRequest): void {
    this.received.push(request)
  }

  terminate(): void {
    this.terminated = true
  }

  /** Pushes an event to the runner as if the worker had sent it. */
  emit(event: WorkerEvent): void {
    for (const listener of this.#listeners) listener({ data: event })
  }

  get lastRunId(): string {
    const last = this.received[this.received.length - 1]
    if (last === undefined) throw new Error('No run has been requested.')
    return last.runId
  }
}

const createWorker: WorkerFactory = () => new FakeWorker() as unknown as Worker

/** Lets the runner's promise callbacks settle before assertions. */
const flush = async (): Promise<void> => {
  await Promise.resolve()
}

describe('PythonRunner', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports stdout and the run duration on success', async () => {
    const runner = new PythonRunner({ createWorker })
    const pending = runner.run('print("hi")')
    await flush()

    const worker = FakeWorker.instances[0]!
    worker.emit({ type: 'ready', pythonVersion: '3.13.0', pyodideVersion: '314.0.6' })
    worker.emit({ type: 'output', runId: worker.lastRunId, stream: 'stdout', text: 'hi\n' })
    worker.emit({ type: 'completed', runId: worker.lastRunId, durationMs: 12 })

    const result = await pending
    expect(result).toEqual({
      status: 'ok',
      stdout: 'hi\n',
      stderr: '',
      truncated: false,
      durationMs: 12,
    })
    expect(runner.pythonVersion).toBe('3.13.0')
  })

  it('surfaces the exception type, message and traceback on failure', async () => {
    const runner = new PythonRunner({ createWorker })
    const pending = runner.run('1 / 0')
    await flush()

    const worker = FakeWorker.instances[0]!
    worker.emit({
      type: 'failed',
      runId: worker.lastRunId,
      durationMs: 3,
      error: {
        type: 'ZeroDivisionError',
        message: 'division by zero',
        traceback: 'Traceback...\nZeroDivisionError: division by zero',
      },
    })

    const result = await pending
    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('expected an error result')
    expect(result.error.type).toBe('ZeroDivisionError')
    expect(result.error.message).toBe('division by zero')
  })

  it('terminates the worker on timeout and keeps the output produced so far', async () => {
    const runner = new PythonRunner({ createWorker })
    const pending = runner.run('while True: print(1)', { timeoutMs: 1000 })
    await flush()

    const worker = FakeWorker.instances[0]!
    worker.emit({ type: 'output', runId: worker.lastRunId, stream: 'stdout', text: 'x\n' })
    vi.advanceTimersByTime(1000)

    const result = await pending
    expect(result.status).toBe('timeout')
    if (result.status !== 'timeout') throw new Error('expected a timeout result')
    expect(result.stdout).toBe('x\n')
    expect(result.timeoutMs).toBe(1000)
    expect(worker.terminated).toBe(true)
  })

  it('terminates the worker when stopped and keeps the output produced so far', async () => {
    const runner = new PythonRunner({ createWorker })
    const pending = runner.run('while True: pass')
    await flush()

    const worker = FakeWorker.instances[0]!
    worker.emit({ type: 'output', runId: worker.lastRunId, stream: 'stdout', text: 'partial\n' })
    runner.stop()

    const result = await pending
    expect(result.status).toBe('stopped')
    if (result.status !== 'stopped') throw new Error('expected a stopped result')
    expect(result.stdout).toBe('partial\n')
    expect(worker.terminated).toBe(true)
  })

  it('starts a fresh worker after a termination, so the learner can run again', async () => {
    const runner = new PythonRunner({ createWorker })
    const first = runner.run('while True: pass')
    await flush()
    runner.stop()
    await first

    const second = runner.run('print("again")')
    await flush()
    expect(FakeWorker.instances).toHaveLength(2)

    const worker = FakeWorker.instances[1]!
    expect(worker.terminated).toBe(false)
    worker.emit({ type: 'completed', runId: worker.lastRunId, durationMs: 1 })
    expect((await second).status).toBe('ok')
  })

  it('refuses a second concurrent run rather than interleaving output', async () => {
    const runner = new PythonRunner({ createWorker })
    const first = runner.run('print(1)')
    await flush()

    const second = await runner.run('print(2)')
    expect(second).toEqual({ status: 'unavailable', message: 'A program is already running.' })

    const worker = FakeWorker.instances[0]!
    worker.emit({ type: 'completed', runId: worker.lastRunId, durationMs: 1 })
    await first
  })

  it('caps captured output and flags it as truncated', async () => {
    const runner = new PythonRunner({ createWorker })
    const pending = runner.run('print("a" * 1000000000)')
    await flush()

    const worker = FakeWorker.instances[0]!
    const runId = worker.lastRunId
    worker.emit({ type: 'output', runId, stream: 'stdout', text: 'a'.repeat(MAX_OUTPUT_CHARS + 500) })
    worker.emit({ type: 'output', runId, stream: 'stdout', text: 'ignored' })
    worker.emit({ type: 'completed', runId, durationMs: 5 })

    const result = await pending
    if (result.status !== 'ok') throw new Error('expected an ok result')
    expect(result.stdout).toHaveLength(MAX_OUTPUT_CHARS)
    expect(result.truncated).toBe(true)
  })

  it('ignores output belonging to a run that has already finished', async () => {
    const runner = new PythonRunner({ createWorker })
    const pending = runner.run('print("first")')
    await flush()

    const worker = FakeWorker.instances[0]!
    const runId = worker.lastRunId
    worker.emit({ type: 'completed', runId, durationMs: 1 })
    worker.emit({ type: 'output', runId, stream: 'stdout', text: 'late\n' })

    const result = await pending
    if (result.status !== 'ok') throw new Error('expected an ok result')
    expect(result.stdout).toBe('')
  })

  it('reports the interpreter as unavailable when the worker cannot start', async () => {
    const runner = new PythonRunner({ createWorker })
    const pending = runner.run('print("hi")')
    await flush()

    const worker = FakeWorker.instances[0]!
    worker.emit({ type: 'fatal', message: 'Failed to fetch pyodide.mjs' })

    const result = await pending
    expect(result).toEqual({ status: 'unavailable', message: 'Failed to fetch pyodide.mjs' })
    expect(worker.terminated).toBe(true)
  })

  describe('status lifecycle', () => {
    // The UI enables Run from this status, so its transitions are load-bearing rather
    // than merely informational.
    it('goes idle → starting → ready as the interpreter boots', () => {
      const seen: string[] = []
      const runner = new PythonRunner({ createWorker, onStatusChange: (s) => seen.push(s) })
      expect(runner.status).toBe('idle')

      runner.warmUp()
      expect(seen).toEqual(['starting'])

      FakeWorker.instances[0]!.emit({
        type: 'ready',
        pythonVersion: '3.14.2',
        pyodideVersion: '314.0.6',
      })
      expect(seen).toEqual(['starting', 'ready'])
      expect(runner.isReady).toBe(true)
    })

    it('returns to idle when the worker is terminated, because no interpreter remains', () => {
      const runner = new PythonRunner({ createWorker })
      runner.warmUp()
      FakeWorker.instances[0]!.emit({
        type: 'ready',
        pythonVersion: '3.14.2',
        pyodideVersion: '314.0.6',
      })

      runner.stop()

      expect(runner.status).toBe('idle')
      expect(runner.isReady).toBe(false)
    })

    it('ends at unavailable, not idle, when the worker fails to start', async () => {
      const runner = new PythonRunner({ createWorker })
      const pending = runner.run('print("hi")')
      await flush()

      FakeWorker.instances[0]!.emit({ type: 'fatal', message: 'Failed to fetch pyodide.mjs' })
      await pending

      expect(runner.status).toBe('unavailable')
    })

    it('does not report a status change when nothing changed', () => {
      const seen: string[] = []
      const runner = new PythonRunner({ createWorker, onStatusChange: (s) => seen.push(s) })

      runner.warmUp()
      runner.warmUp()

      expect(seen).toEqual(['starting'])
    })
  })
})
