import type {
  ProviderFailure,
  StructuredRequest,
  StructuredResult,
  TextChunk,
  TextRequest,
  TutorProvider,
} from './provider'

/**
 * A deterministic stand-in for the real model.
 *
 * Every automated test runs against this, so the suite needs no API key, produces the
 * same result every time, and can reproduce failure modes — malformed output, refusal,
 * an unavailable upstream — on demand rather than by chance.
 *
 * Responses are registered per strategy. A strategy with no registered response fails
 * loudly rather than silently returning something plausible, so a missing fixture
 * cannot be mistaken for a passing test.
 */

/** What the mock should do when a strategy is called. */
export type MockResponse =
  /** Return this value. It is still validated against the request's schema. */
  | { readonly kind: 'value'; readonly value: unknown }
  /**
   * Work the value out from the prompt, as a real model would.
   *
   * For the handful of strategies whose output must *agree* with something in the prompt — an
   * observation has to name the concept the session is about — a fixed value can only ever be
   * right for one situation. Deriving it keeps the fixture correct wherever it is used, instead
   * of silently failing validation when the scheduler picks a different concept.
   */
  | { readonly kind: 'derive'; readonly from: (prompt: string) => unknown }
  /** Return this text, optionally split into chunks, from `streamText`. */
  | { readonly kind: 'text'; readonly chunks: readonly string[] }
  /** Simulate a provider-level failure. */
  | { readonly kind: 'failure'; readonly failure: ProviderFailure }

export interface RecordedCall {
  readonly strategy: string
  readonly strategyVersion: string
  readonly prompt: string
  /** Prompt text up to the first dynamic block: the part a prompt cache could reuse. */
  readonly stablePrefix: string
}

/** The mock makes no calls, so it has no usage to report. */
const NO_USAGE = null

/** Renders blocks the way a provider would see them, for assertions on prompt assembly. */
export function renderPrompt(blocks: readonly { role: string; text: string }[]): string {
  return blocks.map((block) => `<${block.role}>\n${block.text}`).join('\n\n')
}

/** The prompt prefix made up entirely of stable blocks. */
export function stablePrefixOf(
  blocks: readonly { role: string; stability: string; text: string }[],
): string {
  const firstDynamic = blocks.findIndex((block) => block.stability === 'dynamic')
  const stable = firstDynamic === -1 ? blocks : blocks.slice(0, firstDynamic)
  return renderPrompt(stable)
}

/**
 * How many recorded calls to keep.
 *
 * Bounded because the provider is now resolved once per process, so an unbounded array would
 * retain the full text of every prompt — including every learner message and their goal — for
 * as long as the server ran. Tests assert on the last call or two; nothing needs the hundredth.
 */
const MAX_RECORDED_CALLS = 20

export class MockProvider implements TutorProvider {
  readonly #responses = new Map<string, MockResponse[]>()
  readonly #calls: RecordedCall[] = []

  /** Every call made so far, in order. */
  get calls(): readonly RecordedCall[] {
    return this.#calls
  }

  /**
   * Queues a response for a strategy. Queued responses are consumed in order; the last
   * one is reused if the strategy is called again, which keeps simple tests short.
   */
  on(strategy: string, response: MockResponse): this {
    const queue = this.#responses.get(strategy)
    if (queue === undefined) this.#responses.set(strategy, [response])
    else queue.push(response)
    return this
  }

  reset(): void {
    this.#responses.clear()
    this.#calls.length = 0
  }

  structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // A misconfigured mock is a test-authoring error, but it still has to surface
    // through the promise the interface promises, not as a synchronous throw.
    try {
      return Promise.resolve(this.#structured(request))
    } catch (cause: unknown) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }

  #structured<T>(request: StructuredRequest<T>): StructuredResult<T> {
    const response = this.#take(request.strategy, request)

    if (response.kind === 'failure') return { ok: false, failure: response.failure }
    if (response.kind === 'text') {
      throw new Error(
        `Mock strategy "${request.strategy}" was given a text response but called via structured().`,
      )
    }

    const value =
      response.kind === 'derive' ? response.from(renderPrompt(request.blocks)) : response.value

    // The mock is held to the same contract as the real provider: a fixture that does
    // not satisfy the schema is a failure, not a silent pass.
    const parsed = request.schema.safeParse(value)
    if (!parsed.success) {
      return {
        ok: false,
        failure: {
          reason: 'invalid_output',
          message: 'The tutor could not produce a usable response.',
          detail: parsed.error.message,
        },
      }
    }

    return { ok: true, value: parsed.data, usage: NO_USAGE, repaired: false }
  }

  streamText(request: TextRequest, signal?: AbortSignal): AsyncIterable<TextChunk> {
    const response = this.#take(request.strategy, request)

    if (response.kind !== 'text') {
      throw new Error(
        `Mock strategy "${request.strategy}" was not given a text response but called via streamText().`,
      )
    }

    return (async function* stream(): AsyncIterable<TextChunk> {
      for (const delta of response.chunks) {
        // Yield on a microtask so the mock delivers chunks asynchronously, as a real
        // network stream does. Without it, a consumer could accidentally come to depend
        // on the first chunk being available synchronously.
        await Promise.resolve()
        if (signal?.aborted === true) return
        yield { delta }
      }
    })()
  }

  #take(
    strategy: string,
    request: { strategyVersion: string; blocks: readonly { role: string; stability: string; text: string }[] },
  ): MockResponse {
    this.#calls.push({
      strategy,
      strategyVersion: request.strategyVersion,
      prompt: renderPrompt(request.blocks),
      stablePrefix: stablePrefixOf(request.blocks),
    })
    if (this.#calls.length > MAX_RECORDED_CALLS) this.#calls.shift()

    const queue = this.#responses.get(strategy)
    // The last queued response is reused rather than consumed, so a test that only
    // cares about one call does not have to queue one per call.
    const next = queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0]
    if (next === undefined) {
      throw new Error(
        `No mock response registered for strategy "${strategy}". Register one with provider.on(...).`,
      )
    }
    return next
  }
}
