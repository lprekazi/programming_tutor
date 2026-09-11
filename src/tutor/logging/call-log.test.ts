import { describe, expect, it } from 'vitest'

import { InMemoryCallLog, NULL_CALL_LOG, buildCallLog, type BuildLogInput } from './call-log'

/**
 * What gets recorded about a model call, and — more importantly — what does not.
 */

function input(overrides: Partial<BuildLogInput> = {}): BuildLogInput {
  return {
    at: 1_760_000_000_000,
    strategyId: 'answer.evaluate',
    strategyVersion: '1',
    policyVersion: '1',
    curriculumVersion: '1',
    model: 'gpt-5.6-sol',
    latencyMs: 842,
    streamed: false,
    ok: true,
    usedFallback: false,
    repairAttempted: false,
    repairSucceeded: false,
    failureReason: null,
    problemCodes: [],
    usage: { inputTokens: 1_200, cachedInputTokens: 1_024, outputTokens: 80 },
    ...overrides,
  }
}

describe('what is recorded', () => {
  it('identifies exactly which prompt produced the response', () => {
    // Strategy, prompt, policy and curriculum versions together: without all four, a change
    // in behaviour months later cannot be traced to the change that caused it.
    const log = buildCallLog(input())

    expect(log.strategyId).toBe('answer.evaluate')
    expect(log.strategyVersion).toBe('1')
    expect(log.policyVersion).toBe('1')
    expect(log.curriculumVersion).toBe('1')
  })

  it('records the configured model, latency and token usage', () => {
    const log = buildCallLog(input())

    expect(log.model).toBe('gpt-5.6-sol')
    expect(log.latencyMs).toBe(842)
    expect(log.usage).toEqual({ inputTokens: 1_200, cachedInputTokens: 1_024, outputTokens: 80 })
  })

  it('leaves usage absent rather than guessing when the provider reports none', () => {
    expect(buildCallLog(input({ usage: null })).usage).toBeNull()
  })
})

describe('outcome classification', () => {
  it('distinguishes a clean success from one that needed repairing', () => {
    // The difference between these two is the measurement that says whether the prompts are
    // actually working. Collapsing them to "ok" would erase it.
    expect(buildCallLog(input()).outcome).toBe('ok')
    expect(
      buildCallLog(input({ repairAttempted: true, repairSucceeded: true })).outcome,
    ).toBe('ok-after-repair')
  })

  it('marks a fallback as a fallback, never as a success', () => {
    const log = buildCallLog(
      input({ ok: true, usedFallback: true, repairAttempted: true, failureReason: 'invalid' }),
    )
    expect(log.outcome).toBe('fallback')
  })

  it('records an outright failure with its reason', () => {
    const log = buildCallLog(input({ ok: false, failureReason: 'refused' }))

    expect(log.outcome).toBe('failed')
    expect(log.failureReason).toBe('refused')
  })

  it('records problem codes but not their details', () => {
    // A detail can quote the learner's own text back — "distractorMisconceptions contains
    // ...". The code is enough to count and group by.
    const log = buildCallLog(input({ problemCodes: ['duplicate-options', 'unknown-concept'] }))

    expect(log.problemCodes).toEqual(['duplicate-options', 'unknown-concept'])
    expect(JSON.stringify(log)).not.toContain('contains')
  })
})

describe('content never reaches the log', () => {
  it('has no field for a prompt or a response', () => {
    // Structural, not conventional: there is no parameter through which content could be
    // passed, so it cannot be added at a call site by someone being helpful.
    const log = buildCallLog(input())

    expect(Object.keys(log).sort()).toEqual([
      'at',
      'curriculumVersion',
      'failureReason',
      'latencyMs',
      'model',
      'outcome',
      'policyVersion',
      'problemCodes',
      'repairAttempted',
      'repairSucceeded',
      'strategyId',
      'strategyVersion',
      'streamed',
      'usage',
    ])
  })

  it('contains nothing resembling a key', () => {
    const serialised = JSON.stringify(buildCallLog(input()))
    expect(serialised).not.toMatch(/sk-/)
    expect(serialised).not.toMatch(/api[_-]?key/i)
  })
})

describe('sinks', () => {
  it('collects in order', () => {
    const sink = new InMemoryCallLog()

    sink.record(buildCallLog(input({ strategyId: 'explain' })))
    sink.record(buildCallLog(input({ strategyId: 'hint' })))

    expect(sink.logs.map((log) => log.strategyId)).toEqual(['explain', 'hint'])
  })

  it('can be cleared', () => {
    const sink = new InMemoryCallLog()
    sink.record(buildCallLog(input()))
    sink.clear()
    expect(sink.logs).toEqual([])
  })

  it('discards everything by default, so nothing is recorded unintentionally', () => {
    expect(() => {
      NULL_CALL_LOG.record(buildCallLog(input()))
    }).not.toThrow()
  })
})
