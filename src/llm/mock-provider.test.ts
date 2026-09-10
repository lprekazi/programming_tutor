import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockProvider, stablePrefixOf } from './mock-provider'
import { collectText, type PromptBlock, type StructuredRequest } from './provider'

const Quiz = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).length(4),
  correctIndex: z.number().int().min(0).max(3),
})

const BLOCKS: readonly PromptBlock[] = [
  { id: 'policy', role: 'system', stability: 'stable', text: 'Tutoring policy.' },
  { id: 'strategy', role: 'system', stability: 'stable', text: 'Write one question.' },
  { id: 'learner', role: 'user', stability: 'dynamic', text: 'Loops: developing.' },
]

function request(overrides: Partial<StructuredRequest<z.infer<typeof Quiz>>> = {}) {
  return {
    strategy: 'quiz.generate',
    strategyVersion: '1',
    blocks: BLOCKS,
    schema: Quiz,
    schemaName: 'quiz',
    ...overrides,
  } satisfies StructuredRequest<z.infer<typeof Quiz>>
}

describe('MockProvider', () => {
  it('returns a fixture that satisfies the schema', async () => {
    const value = {
      question: 'What does range(3) produce?',
      options: ['0 1 2', '1 2 3', '0 1 2 3', '3'],
      correctIndex: 0,
    }
    const provider = new MockProvider().on('quiz.generate', { kind: 'value', value })

    const result = await provider.structured(request())

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.value).toEqual(value)
    expect(result.repaired).toBe(false)
  })

  it('rejects a fixture that violates the schema instead of passing it through', async () => {
    // Two plausible-looking but invalid shapes: a missing field and an out-of-range index.
    const provider = new MockProvider().on('quiz.generate', {
      kind: 'value',
      value: { question: 'What does range(3) produce?', options: ['a', 'b', 'c', 'd'], correctIndex: 9 },
    })

    const result = await provider.structured(request())

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.failure.reason).toBe('invalid_output')
    expect(result.failure.message).not.toContain('correctIndex')
  })

  it('reproduces provider failures on demand', async () => {
    const provider = new MockProvider().on('quiz.generate', {
      kind: 'failure',
      failure: { reason: 'unavailable', message: 'The tutor is not reachable right now.' },
    })

    const result = await provider.structured(request())

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.failure.reason).toBe('unavailable')
  })

  it('throws when a strategy has no registered fixture', async () => {
    const provider = new MockProvider()

    await expect(provider.structured(request())).rejects.toThrow(
      /No mock response registered for strategy "quiz.generate"/,
    )
  })

  it('consumes queued responses in order and then repeats the last one', async () => {
    const first = { question: 'One?', options: ['a', 'b', 'c', 'd'], correctIndex: 0 }
    const second = { question: 'Two?', options: ['a', 'b', 'c', 'd'], correctIndex: 1 }
    const provider = new MockProvider()
      .on('quiz.generate', { kind: 'value', value: first })
      .on('quiz.generate', { kind: 'value', value: second })

    const one = await provider.structured(request())
    const two = await provider.structured(request())
    const three = await provider.structured(request())

    if (!one.ok || !two.ok || !three.ok) throw new Error('expected success')
    expect(one.value.question).toBe('One?')
    expect(two.value.question).toBe('Two?')
    expect(three.value.question).toBe('Two?')
  })

  it('streams prose in chunks and stops when aborted', async () => {
    const provider = new MockProvider().on('converse', {
      kind: 'text',
      chunks: ['What ', 'happens ', 'first?'],
    })

    const text = await collectText(
      provider.streamText({ strategy: 'converse', strategyVersion: '1', blocks: BLOCKS }),
    )
    expect(text).toBe('What happens first?')

    const controller = new AbortController()
    controller.abort()
    const aborted = await collectText(
      provider.streamText({ strategy: 'converse', strategyVersion: '1', blocks: BLOCKS }, controller.signal),
    )
    expect(aborted).toBe('')
  })

  it('records the stable prefix so prompt-cache reuse can be asserted', async () => {
    const provider = new MockProvider().on('quiz.generate', {
      kind: 'value',
      value: { question: 'Q?', options: ['a', 'b', 'c', 'd'], correctIndex: 0 },
    })

    await provider.structured(request())
    await provider.structured(
      request({
        blocks: [
          ...BLOCKS.slice(0, 2),
          { id: 'learner', role: 'user', stability: 'dynamic', text: 'Loops: secure.' },
        ],
      }),
    )

    const [first, second] = provider.calls
    expect(provider.calls).toHaveLength(2)
    // The learner block changed; the policy and strategy prefix did not.
    expect(first?.stablePrefix).toBe(second?.stablePrefix)
    expect(first?.prompt).not.toBe(second?.prompt)
  })
})

describe('stablePrefixOf', () => {
  it('stops at the first dynamic block, even if stable blocks follow it', () => {
    const prefix = stablePrefixOf([
      { role: 'system', stability: 'stable', text: 'A' },
      { role: 'user', stability: 'dynamic', text: 'B' },
      { role: 'system', stability: 'stable', text: 'C' },
    ])

    expect(prefix).toBe('<system>\nA')
  })

  it('is the whole prompt when nothing is dynamic', () => {
    const prefix = stablePrefixOf([
      { role: 'system', stability: 'stable', text: 'A' },
      { role: 'system', stability: 'stable', text: 'B' },
    ])

    expect(prefix).toBe('<system>\nA\n\n<system>\nB')
  })
})
