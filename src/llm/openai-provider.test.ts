import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  OpenAIProvider,
  StreamCancelledError,
  StreamInterruptedError,
  StreamRefusedError,
  buildStructuredRequest,
  buildTextRequest,
  classifyError,
  readParsedResponse,
  toInputItems,
  type OpenAILike,
  type ResponseStreamEventLike,
} from './openai-provider'
import { collectText, type PromptBlock, type StructuredRequest } from './provider'

/**
 * The OpenAI provider, exercised without a network and without a key.
 *
 * Request construction is asserted by capturing what would be sent. Response handling is
 * asserted by feeding in the shapes the SDK declares. No test here reads an environment
 * variable, opens a socket, or needs credentials — which is the point: the whole suite has to
 * run for someone who has never configured the application.
 */

const BLOCKS: readonly PromptBlock[] = [
  { id: 'policy', role: 'system', stability: 'stable', text: 'Policy text.' },
  { id: 'task', role: 'user', stability: 'dynamic', text: 'Task text.' },
]

const schema = z.object({ answer: z.string() }).strict()

function structuredRequest(): StructuredRequest<{ answer: string }> {
  return {
    strategy: 'answer.evaluate',
    strategyVersion: '1',
    blocks: BLOCKS,
    schema,
    schemaName: 'answer',
  }
}

/** Records what was sent and replays a scripted response. */
/** Carries a non-Error rejection value, which the SDK can produce in principle. */
class NonErrorRejection extends Error {
  constructor(readonly value: unknown) {
    super(String(value))
    this.name = 'NonErrorRejection'
  }
}

function fakeClient(options: {
  parsed?: unknown
  parseError?: unknown
  events?: ResponseStreamEventLike[]
}): OpenAILike & { sent: Record<string, unknown>[]; signals: (AbortSignal | undefined)[] } {
  const sent: Record<string, unknown>[] = []
  const signals: (AbortSignal | undefined)[] = []

  return {
    sent,
    signals,
    responses: {
      parse: (body, requestOptions) => {
        sent.push(body)
        signals.push(requestOptions?.signal)
        // Rejects with whatever the test supplied: the provider has to cope with a thrown
        // value that is not an Error, so the fake must be able to produce one.
        if (options.parseError !== undefined) {
          return Promise.reject(
            options.parseError instanceof Error
              ? options.parseError
              : new NonErrorRejection(options.parseError),
          )
        }
        return Promise.resolve(options.parsed)
      },
      create: (body, requestOptions) => {
        sent.push(body)
        signals.push(requestOptions?.signal)
        const events = options.events ?? []
        return Promise.resolve(
          (async function* replay(): AsyncIterable<ResponseStreamEventLike> {
            for (const event of events) {
              await Promise.resolve()
              yield event
            }
          })(),
        )
      },
    },
  }
}

describe('request construction', () => {
  it('sends blocks as input items, in order, with their roles', () => {
    expect(toInputItems(BLOCKS)).toEqual([
      { role: 'system', content: 'Policy text.' },
      { role: 'user', content: 'Task text.' },
    ])
  })

  it('asks for schema-constrained output under text.format', () => {
    // The Responses API takes this under `text.format`; the older Chat Completions API used
    // `response_format`, and sending the wrong one silently loses the constraint.
    const body = buildStructuredRequest('gpt-5.6-sol', structuredRequest())

    expect(body['model']).toBe('gpt-5.6-sol')
    expect(body).toHaveProperty('text')
    expect(body).not.toHaveProperty('response_format')
    expect(body['text']).toHaveProperty('format')
  })

  it('sets a cache key per strategy', () => {
    const body = buildStructuredRequest('gpt-5.6-sol', structuredRequest())
    expect(body['prompt_cache_key']).toBe('answer.evaluate')
  })

  it('does not stream a structured call', () => {
    // A half-arrived JSON object cannot be validated, and validating it is the whole point.
    expect(buildStructuredRequest('m', structuredRequest())['stream']).toBeUndefined()
  })

  it('streams a text call', () => {
    const body = buildTextRequest('m', { strategy: 'explain', strategyVersion: '1', blocks: BLOCKS })
    expect(body['stream']).toBe(true)
    expect(body['prompt_cache_key']).toBe('explain')
  })

  it('never puts a key anywhere in the request', () => {
    const serialised = JSON.stringify(buildStructuredRequest('m', structuredRequest()))
    expect(serialised).not.toMatch(/api[_-]?key/i)
    expect(serialised).not.toMatch(/sk-/)
  })
})

describe('reading a structured response', () => {
  it('returns the parsed value', () => {
    const result = readParsedResponse<{ answer: string }>({
      output_parsed: { answer: 'yes' },
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 } },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.value).toEqual({ answer: 'yes' })
    expect(result.usage).toEqual({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 })
  })

  it('reports a refusal as a refusal, not as invalid output', () => {
    // A refusal is not a fault and must never be repaired: asking again asks the same thing.
    const result = readParsedResponse({
      output: [{ content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.failure.reason).toBe('refused')
  })

  it('treats a response with nothing parsed as invalid output', () => {
    const result = readParsedResponse({ output: [] })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.failure.reason).toBe('invalid_output')
  })

  it('reports usage as absent, not zero, when the provider omits it', () => {
    // A fabricated zero is indistinguishable from a genuinely free call, and the log exists to
    // produce real numbers about what was spent.
    const result = readParsedResponse({ output_parsed: { answer: 'yes' } })
    if (!result.ok) throw new Error('expected success')
    expect(result.usage).toBeNull()
  })
})

describe('classifying errors', () => {
  it('separates a credentials problem from an outage', () => {
    // They need different responses: one is the operator's to fix, the other resolves itself.
    expect(classifyError(Object.assign(new Error('Unauthorized'), { status: 401 })).reason).toBe(
      'misconfigured',
    )
    expect(classifyError(Object.assign(new Error('Forbidden'), { status: 403 })).reason).toBe(
      'misconfigured',
    )
    expect(classifyError(Object.assign(new Error('Bad gateway'), { status: 502 })).reason).toBe(
      'unavailable',
    )
  })

  it('keeps the technical detail out of the learner-facing message', () => {
    const failure = classifyError(new Error('connect ETIMEDOUT 10.0.0.1:443'))
    expect(failure.message).not.toContain('ETIMEDOUT')
    expect(failure.detail).toContain('ETIMEDOUT')
  })

  it('handles something that is not an Error at all', () => {
    expect(classifyError('a string').reason).toBe('unavailable')
  })
})

describe('structured calls', () => {
  it('sends the request and returns the value', async () => {
    const client = fakeClient({ parsed: { output_parsed: { answer: 'yes' } } })
    const provider = new OpenAIProvider({ model: 'gpt-5.6-sol', client })

    const result = await provider.structured(structuredRequest())

    expect(result.ok).toBe(true)
    expect(client.sent[0]?.['model']).toBe('gpt-5.6-sol')
  })

  it('turns a thrown error into a failure rather than propagating it', async () => {
    const client = fakeClient({ parseError: new Error('network down') })
    const provider = new OpenAIProvider({ model: 'm', client })

    const result = await provider.structured(structuredRequest())

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.failure.reason).toBe('unavailable')
  })

  it('passes an abort signal through to the client', async () => {
    const client = fakeClient({ parsed: { output_parsed: { answer: 'yes' } } })
    const provider = new OpenAIProvider({ model: 'm', client })
    const controller = new AbortController()

    await provider.structured({ ...structuredRequest(), signal: controller.signal })

    expect(client.signals[0]).toBe(controller.signal)
  })
})

describe('streaming', () => {
  const textRequest = { strategy: 'explain', strategyVersion: '1', blocks: BLOCKS }

  it('yields text deltas and ends cleanly on completion', async () => {
    const client = fakeClient({
      events: [
        { type: 'response.created' },
        { type: 'response.output_text.delta', delta: 'Hello ' },
        { type: 'response.output_text.delta', delta: 'there.' },
        { type: 'response.completed' },
      ],
    })
    const provider = new OpenAIProvider({ model: 'm', client })

    expect(await collectText(provider.streamText(textRequest))).toBe('Hello there.')
  })

  it('ignores event types it does not consume', async () => {
    const client = fakeClient({
      events: [
        { type: 'response.in_progress' },
        { type: 'response.output_item.added' },
        { type: 'response.output_text.delta', delta: 'ok' },
        { type: 'response.output_text.done' },
        { type: 'response.completed' },
      ],
    })

    expect(
      await collectText(new OpenAIProvider({ model: 'm', client }).streamText(textRequest)),
    ).toBe('ok')
  })

  it('raises a refusal rather than returning a partial answer', async () => {
    const client = fakeClient({
      events: [{ type: 'response.refusal.delta', delta: 'I cannot' }],
    })

    await expect(
      collectText(new OpenAIProvider({ model: 'm', client }).streamText(textRequest)),
    ).rejects.toThrow(StreamRefusedError)
  })

  it('raises when the stream ends without completing', async () => {
    // The documented example handles only delta, completed and error. A stream that simply
    // stops would otherwise hand the learner a truncated explanation as though it were whole.
    const client = fakeClient({
      events: [{ type: 'response.output_text.delta', delta: 'Half a sent' }],
    })

    await expect(
      collectText(new OpenAIProvider({ model: 'm', client }).streamText(textRequest)),
    ).rejects.toThrow(StreamInterruptedError)
  })

  it('raises on a failed or incomplete response', async () => {
    for (const type of ['response.failed', 'response.incomplete']) {
      const client = fakeClient({ events: [{ type }] })
      await expect(
        collectText(new OpenAIProvider({ model: 'm', client }).streamText(textRequest)),
      ).rejects.toThrow(StreamInterruptedError)
    }
  })

  it('raises on an error event, keeping the provider wording out of the message', async () => {
    // The message may be shown to a learner; upstream error text is not written for them. It
    // is kept in `detail` instead, the same discipline `classifyError` follows.
    const client = fakeClient({ events: [{ type: 'error', message: 'upstream exploded' }] })

    let failure: unknown = null
    try {
      await collectText(new OpenAIProvider({ model: 'm', client }).streamText(textRequest))
    } catch (cause: unknown) {
      failure = cause
    }

    expect(failure).toBeInstanceOf(StreamInterruptedError)
    const interrupted = failure as StreamInterruptedError
    expect(interrupted.message).not.toContain('upstream exploded')
    expect(interrupted.detail).toBe('upstream exploded')
  })

  it('reports cancellation distinctly, so truncated text is never mistaken for complete', async () => {
    // Returning quietly would present a half-finished explanation as whole. That is tolerable
    // only while the signal is literally the learner pressing stop — a timeout, a navigation or
    // a composed signal reaches the same code and must not silently truncate.
    const controller = new AbortController()
    const client = fakeClient({
      events: [
        { type: 'response.output_text.delta', delta: 'one' },
        { type: 'response.output_text.delta', delta: 'two' },
        { type: 'response.output_text.delta', delta: 'three' },
      ],
    })
    const provider = new OpenAIProvider({ model: 'm', client })

    let text = ''
    let cancelled: unknown = null
    try {
      for await (const chunk of provider.streamText(textRequest, controller.signal)) {
        text += chunk.delta
        controller.abort()
      }
    } catch (cause: unknown) {
      cancelled = cause
    }

    expect(text).toBe('one')
    expect(cancelled).toBeInstanceOf(StreamCancelledError)
    expect(client.signals[0]).toBe(controller.signal)
  })
})

describe('building from the environment', () => {
  it('returns null when no key is present, rather than throwing', () => {
    // Development and the entire test suite run without a key. That has to be an ordinary
    // path, not an error condition.
    const key = process.env['OPENAI_API_KEY']
    const model = process.env['OPENAI_MODEL']
    try {
      delete process.env['OPENAI_API_KEY']
      process.env['OPENAI_MODEL'] = 'gpt-5.6-sol'
      expect(OpenAIProvider.fromEnvironment()).toBeNull()
    } finally {
      if (key !== undefined) process.env['OPENAI_API_KEY'] = key
      if (model === undefined) delete process.env['OPENAI_MODEL']
      else process.env['OPENAI_MODEL'] = model
    }
  })

  it('returns null when no model is configured', () => {
    const key = process.env['OPENAI_API_KEY']
    const model = process.env['OPENAI_MODEL']
    try {
      process.env['OPENAI_API_KEY'] = 'placeholder-not-a-real-key'
      delete process.env['OPENAI_MODEL']
      expect(OpenAIProvider.fromEnvironment()).toBeNull()
    } finally {
      if (key === undefined) delete process.env['OPENAI_API_KEY']
      else process.env['OPENAI_API_KEY'] = key
      if (model !== undefined) process.env['OPENAI_MODEL'] = model
    }
  })
})
