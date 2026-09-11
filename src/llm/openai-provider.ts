import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'

import type {
  ProviderFailure,
  StructuredRequest,
  StructuredResult,
  TextChunk,
  TextRequest,
  TokenUsage,
  TutorProvider,
} from './provider'

/**
 * The real provider, over the OpenAI Responses API.
 *
 * Everything above this file is deterministic; everything below it is not. So this is kept
 * as thin as it can be: build a request, make the call, classify what came back. No retries,
 * no repair, no validation policy — those belong in the tutor layer where they can be tested
 * without a network.
 *
 * The API key is read here from the environment and goes no further. It is not passed in, not
 * logged, and not exposed on any returned value. The file never reads a `.env` file itself;
 * Next.js has already loaded one into `process.env` by the time this runs.
 *
 * Request construction is separated from sending (`buildStructuredRequest`,
 * `buildTextRequest`) so that what this sends can be asserted in tests without a live call.
 */

/** Client surface actually used, so tests can substitute a double. */
export interface OpenAILike {
  readonly responses: {
    parse: (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>
    create: (
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ) => Promise<AsyncIterable<ResponseStreamEventLike>>
  }
}

/** The stream events consumed, named exactly as the SDK declares them. */
export interface ResponseStreamEventLike {
  readonly type: string
  readonly delta?: string
  readonly message?: string
  readonly response?: { readonly usage?: RawUsage }
}

interface RawUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly input_tokens_details?: { readonly cached_tokens?: number }
}

export interface OpenAIProviderOptions {
  readonly model: string
  readonly client: OpenAILike
}

/** Renders composed blocks into Responses API input items. */
export function toInputItems(
  blocks: readonly { role: 'system' | 'user'; text: string }[],
): { role: string; content: string }[] {
  return blocks.map((block) => ({ role: block.role, content: block.text }))
}

/**
 * JSON Schema keywords Structured Outputs does not support.
 *
 * Official guidance is that these are **not enforced** by the model, and some are rejected
 * outright. Either way they cannot be relied on, and sending them risks a 400 that would
 * surface as an outage on every structured call in the product.
 *
 * They are removed from the emitted schema and enforced by the application's own validator
 * instead — which is where the guidance says such checks belong. The Zod schema keeps them,
 * so `runStructured` still applies every one.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
] as const

/** Removes unsupported keywords, in place, throughout a JSON Schema. */
export function stripUnsupportedKeywords(node: unknown): void {
  if (Array.isArray(node)) {
    for (const entry of node) stripUnsupportedKeywords(entry)
    return
  }
  if (typeof node !== 'object' || node === null) return

  const record = node as Record<string, unknown>
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (!(keyword in record)) continue
    // Reflect.deleteProperty rather than `delete record[keyword]`: the effect is the same, and
    // the key genuinely has to be absent — leaving it as undefined would still serialise.
    Reflect.deleteProperty(record, keyword)
  }
  for (const value of Object.values(record)) stripUnsupportedKeywords(value)
}

/**
 * Builds a structured request.
 *
 * `prompt_cache_key` is the strategy id, so the provider can associate this call's stable
 * prefix with other calls of the same strategy. Correctness never depends on a cache hit.
 */
export function buildStructuredRequest<T>(
  model: string,
  request: StructuredRequest<T>,
): Record<string, unknown> {
  const format = zodTextFormat(request.schema as never, request.schemaName)
  // Mutated in place rather than cloned: the format object carries the SDK's parser, which a
  // clone would lose. Only the JSON Schema beneath it is touched.
  stripUnsupportedKeywords((format as unknown as { schema?: unknown }).schema)

  return {
    model,
    input: toInputItems(request.blocks),
    text: { format },
    prompt_cache_key: request.strategy,
  }
}

export function buildTextRequest(model: string, request: TextRequest): Record<string, unknown> {
  return {
    model,
    input: toInputItems(request.blocks),
    stream: true,
    prompt_cache_key: request.strategy,
  }
}

function readUsage(raw: RawUsage | undefined): TokenUsage | null {
  if (raw === undefined) return null
  return {
    inputTokens: raw.input_tokens ?? 0,
    cachedInputTokens: raw.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
  }
}

/**
 * Whether a thrown error means "the model's output was unusable" rather than "the call
 * failed".
 *
 * This distinction decides whether the one repair attempt happens at all. The SDK's `parse`
 * helper applies the Zod schema itself and **throws** when it fails, and throws a
 * `SyntaxError` when the response is not valid JSON. Without recognising those, a model that
 * simply wrote too much text would be reported to the learner as a network outage, no repair
 * would be attempted, and the call log's repair rate would read zero by construction.
 */
function isOutputValidationError(cause: unknown): boolean {
  if (cause instanceof SyntaxError) return true
  if (typeof cause !== 'object' || cause === null) return false

  const named = cause as { name?: unknown; issues?: unknown }
  // Matched by name as well as by `issues`, so a Zod instance from a different copy of the
  // library — a real possibility with a bundled dependency — is still recognised.
  return named.name === 'ZodError' || Array.isArray(named.issues)
}

/**
 * Classifies a thrown error.
 *
 * The error's own message is never shown to a learner; it goes in `detail`, which the log
 * records by code only.
 */
export function classifyError(cause: unknown): ProviderFailure {
  const status = typeof cause === 'object' && cause !== null && 'status' in cause
    ? (cause as { status?: unknown }).status
    : undefined
  const detail = cause instanceof Error ? cause.message : String(cause)

  if (isOutputValidationError(cause)) {
    return {
      reason: 'invalid_output',
      message: 'The tutor could not put together a usable response just now.',
      detail,
    }
  }

  if (status === 401 || status === 403) {
    return {
      reason: 'misconfigured',
      message: 'The tutor is not configured correctly. Check the application settings.',
      detail,
    }
  }
  if (cause instanceof Error && cause.name === 'AbortError') {
    return { reason: 'unavailable', message: 'The request was cancelled.', detail }
  }
  return {
    reason: 'unavailable',
    message: 'The tutor is not reachable at the moment. Your progress is saved.',
    detail,
  }
}

/** Reads a parsed Responses API result, distinguishing a refusal from a usable value. */
export function readParsedResponse<T>(raw: unknown): StructuredResult<T> {
  const response = raw as {
    output_parsed?: unknown
    output?: { content?: { type?: string; refusal?: string }[] }[]
    usage?: RawUsage
  }

  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'refusal') {
        return {
          ok: false,
          failure: {
            reason: 'refused',
            message: 'The tutor declined to answer that one.',
            detail: content.refusal ?? '',
          },
        }
      }
    }
  }

  if (response.output_parsed === undefined || response.output_parsed === null) {
    return {
      ok: false,
      failure: {
        reason: 'invalid_output',
        message: 'The tutor could not put together a usable response just now.',
        detail: 'The response contained no parsed output.',
      },
    }
  }

  return {
    ok: true,
    value: response.output_parsed as T,
    // Absent rather than zero: a fabricated zero is indistinguishable from a genuinely free
    // call, and the log exists to produce real numbers about what was spent.
    usage: readUsage(response.usage),
    repaired: false,
  }
}

export class OpenAIProvider implements TutorProvider {
  readonly #client: OpenAILike
  readonly #model: string

  constructor(options: OpenAIProviderOptions) {
    this.#client = options.client
    this.#model = options.model
  }

  /**
   * Builds a provider from the environment.
   *
   * Returns `null` rather than throwing when no key is present, so the caller can fall back
   * to the mock. Development and the whole test suite run without a key, and that has to be
   * an ordinary path rather than an error condition.
   */
  static fromEnvironment(): OpenAIProvider | null {
    const apiKey = process.env['OPENAI_API_KEY']
    const model = process.env['OPENAI_MODEL']
    if (apiKey === undefined || apiKey.length === 0 || model === undefined || model.length === 0) {
      return null
    }
    return new OpenAIProvider({
      model,
      client: new OpenAI({ apiKey }) as unknown as OpenAILike,
    })
  }

  get model(): string {
    return this.#model
  }

  async structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    try {
      const raw = await this.#client.responses.parse(
        buildStructuredRequest(this.#model, request),
        request.signal === undefined ? undefined : { signal: request.signal },
      )
      return readParsedResponse<T>(raw)
    } catch (cause: unknown) {
      return { ok: false, failure: classifyError(cause) }
    }
  }

  streamText(request: TextRequest, signal?: AbortSignal): AsyncIterable<TextChunk> {
    const client = this.#client
    const body = buildTextRequest(this.#model, request)

    return (async function* stream(): AsyncIterable<TextChunk> {
      let events: AsyncIterable<ResponseStreamEventLike>
      try {
        events = await client.responses.create(body, signal === undefined ? undefined : { signal })
      } catch (cause: unknown) {
        // Opening the stream fails the same ways a structured call does — bad credentials, a
        // rate limit, a dead connection — so it is classified the same way. Without this the
        // consumer would receive a raw SDK error and could render its body to the learner.
        throw new StreamFailedError(classifyError(cause))
      }

      let completed = false

      for await (const event of events) {
        // Breaking out of the loop abandons the iterator; the signal is what actually
        // cancels the request, which is why both are used.
        if (signal?.aborted === true) throw new StreamCancelledError()

        switch (event.type) {
          case 'response.output_text.delta': {
            if (event.delta !== undefined) yield { delta: event.delta }
            break
          }
          case 'response.refusal.delta':
          case 'response.refusal.done': {
            throw new StreamRefusedError()
          }
          case 'response.failed':
          case 'response.incomplete': {
            throw new StreamInterruptedError(event.type)
          }
          case 'error': {
            throw new StreamInterruptedError('the provider reported an error', event.message)
          }
          case 'response.completed': {
            completed = true
            break
          }
          default:
            break
        }
      }

      if (signal?.aborted === true) throw new StreamCancelledError()

      // A stream that stops without a terminal event was cut off. Returning quietly here
      // would hand the learner a truncated explanation as though it were the whole thing.
      if (!completed) {
        throw new StreamInterruptedError('the stream ended without completing')
      }
    })()
  }
}

export class StreamRefusedError extends Error {
  constructor() {
    super('The tutor declined to answer that one.')
    this.name = 'StreamRefusedError'
  }
}

/**
 * The stream stopped before the response was complete.
 *
 * Carries the provider's own wording in `detail`, never in `message`: the message may be shown
 * to a learner, and upstream error text is not written for them.
 */
export class StreamInterruptedError extends Error {
  readonly detail: string | undefined

  constructor(reason: string, detail?: string) {
    super(`The response was interrupted: ${reason}`)
    this.name = 'StreamInterruptedError'
    this.detail = detail
  }
}

/** The stream could not be opened. Carries the same classification a structured call would get. */
export class StreamFailedError extends Error {
  readonly failure: ProviderFailure

  constructor(failure: ProviderFailure) {
    super(failure.message)
    this.name = 'StreamFailedError'
    this.failure = failure
  }
}

/**
 * The caller cancelled.
 *
 * Distinct from an interruption because the caller needs to tell them apart: text collected so
 * far is incomplete either way, but only one of them is a fault. Returning quietly instead
 * would present a half-finished explanation as though it were whole — which is exactly what a
 * timeout, a navigation, or a composed signal would then do silently.
 */
export class StreamCancelledError extends Error {
  constructor() {
    super('The response was cancelled.')
    this.name = 'StreamCancelledError'
  }
}
