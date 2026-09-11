import type { z } from 'zod'

/**
 * The boundary between the tutor and whatever language model backs it.
 *
 * Everything above this interface is deterministic and testable. Everything below it
 * is non-deterministic, may fail, and produces output that must be treated as
 * untrusted input. Keeping the seam explicit is what allows the entire test suite —
 * unit, integration and end-to-end — to run without an API key.
 */

/**
 * One segment of a composed prompt.
 *
 * `stability` records the author's intent, and the assembler orders stable blocks
 * before dynamic ones so that the unchanging prefix can be reused by the provider's
 * prompt cache. Correctness never depends on a cache hit.
 */
export interface PromptBlock {
  readonly id: string
  readonly role: 'system' | 'user'
  readonly stability: 'stable' | 'dynamic'
  readonly text: string
}

export interface TokenUsage {
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
}

export interface StructuredRequest<T> {
  /** Identifies the tutoring strategy making the call, e.g. `quiz.generate`. */
  readonly strategy: string
  readonly strategyVersion: string
  /** Ordered prompt blocks; the assembler is responsible for stable-first ordering. */
  readonly blocks: readonly PromptBlock[]
  /** Schema the response must satisfy. Output that fails it is never used. */
  readonly schema: z.ZodType<T>
  /** Name given to the schema in the request; must be a stable identifier. */
  readonly schemaName: string
  /** Abandons the call when the learner navigates away or cancels. */
  readonly signal?: AbortSignal | undefined
}

export interface TextRequest {
  readonly strategy: string
  readonly strategyVersion: string
  readonly blocks: readonly PromptBlock[]
}

export type ProviderFailureReason =
  /** The model produced output that did not satisfy the schema, twice. */
  | 'invalid_output'
  /** The model declined to answer. */
  | 'refused'
  /** Network, timeout, rate limit or upstream error. */
  | 'unavailable'
  /** The application is misconfigured, e.g. no credentials. */
  | 'misconfigured'

export interface ProviderFailure {
  readonly reason: ProviderFailureReason
  /** Safe to show a learner: plain, non-technical, actionable where possible. */
  readonly message: string
  /** Technical detail for the log; never rendered. */
  readonly detail?: string
}

export type StructuredResult<T> =
  | {
      readonly ok: true
      readonly value: T
      /** Absent when the provider reported none. Never guessed — the log documents this. */
      readonly usage: TokenUsage | null
      /** True when the first response failed validation and a repair attempt succeeded. */
      readonly repaired: boolean
    }
  | { readonly ok: false; readonly failure: ProviderFailure }

export interface TextChunk {
  readonly delta: string
}

export interface TutorProvider {
  /** A machine-readable call whose result affects application state. */
  structured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>
  /** A prose call whose result is shown to the learner as it arrives. */
  streamText(request: TextRequest, signal?: AbortSignal): AsyncIterable<TextChunk>
}

/** Renders blocks the way a provider sees them. One definition, used by both providers and by tests. */
export function renderPrompt(blocks: readonly { role: string; text: string }[]): string {
  return blocks.map((block) => `<${block.role}>\n${block.text}`).join('\n\n')
}

/**
 * The prefix made entirely of stable blocks: what a provider could reuse between calls.
 *
 * Defined once here. It had been written twice, identically, and two definitions of "the
 * cacheable prefix" is one too many — they can disagree.
 */
export function stablePrefixOf(
  blocks: readonly { role: string; stability: string; text: string }[],
): string {
  const firstDynamic = blocks.findIndex((block) => block.stability === 'dynamic')
  return renderPrompt(firstDynamic === -1 ? blocks : blocks.slice(0, firstDynamic))
}

/** Concatenates a stream into a single string. Convenience for tests and non-streaming callers. */
export async function collectText(stream: AsyncIterable<TextChunk>): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += chunk.delta
  return text
}
