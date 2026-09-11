import type { ProviderFailure, PromptBlock, TutorProvider } from '@/llm/provider'

import { strategyContext } from '../strategies/shared'
import type { InvariantProblem, StructuredStrategy } from '../strategies/types'

/**
 * The path every structured response takes before anything acts on it.
 *
 *   provider → schema (here) → domain invariants → one repair attempt → safe fallback
 *
 * The repair budget is exactly one, and it is not a retry loop. A model that produced
 * something invalid once will often fix it when shown what was wrong; a model that gets it
 * wrong twice is not going to converge, and retrying past that point burns money and makes
 * the learner wait for a worse outcome than failing cleanly would have been.
 *
 * Nothing is coerced. A response with two correct options is not quietly reduced to one, and
 * a response naming a concept that does not exist does not have it stripped out — both change
 * what the response *means*, and a silently repaired meaning is worse than a visible failure.
 * Invalid output is rejected whole.
 */

/** Why a structured call did not produce a usable result. */
export type StrategyFailureReason =
  /** The response never satisfied the schema or the invariants, even after repair. */
  | 'invalid'
  /** The model declined. Not a fault, and never repaired. */
  | 'refused'
  /** Network, timeout, rate limit, upstream error. */
  | 'unavailable'
  /** Missing credentials or bad configuration. */
  | 'misconfigured'

/** Where a usable value came from. */
export type OutcomeSource = 'model' | 'fallback'

/**
 * The result of a structured call.
 *
 * A discriminated union, deliberately. With a plain `{ ok: boolean; value: T | null }` a
 * caller could write `if (outcome.ok) use(outcome.value)` and silently consume a fallback
 * produced because the model was never reached. Here, a usable value always arrives with the
 * `source` that produced it, and the compiler makes the caller look at it.
 */
export type StrategyOutcome<Output> =
  | {
      readonly ok: true
      readonly source: OutcomeSource
      readonly value: Output
      readonly repairAttempted: boolean
      readonly repairSucceeded: boolean
      readonly problems: readonly InvariantProblem[]
    }
  | {
      readonly ok: false
      readonly value: null
      readonly failureReason: StrategyFailureReason
      /** Safe to show a learner. */
      readonly message: string
      readonly repairAttempted: boolean
      readonly repairSucceeded: false
      readonly problems: readonly InvariantProblem[]
    }

export interface RunOptions {
  readonly signal?: AbortSignal | undefined
}

/**
 * Builds the block appended for a repair attempt.
 *
 * States what was wrong and asks for the whole response again. It deliberately does not
 * include the previous response, nor any text the provider echoed back from it: re-sending
 * invalid output invites the model to edit around it rather than reconsider, and provider
 * error text can quote model-chosen field names straight back into the next prompt.
 *
 * Only `detail` strings this codebase wrote are used, which is why `schema-violation` carries
 * a fixed sentence rather than the parser's message.
 */
function repairBlock(problems: readonly InvariantProblem[]): PromptBlock {
  const list = problems.map((problem) => `- ${problem.detail}`).join('\n')
  return {
    id: 'repair',
    role: 'user',
    stability: 'dynamic',
    text: `Your previous response could not be used:\n\n${list}\n\nProduce the whole response again, correcting these. Do not explain the correction; return only the corrected response.`,
  }
}

/** A fixed sentence, so provider text never rides back into the next prompt. */
const SCHEMA_VIOLATION: InvariantProblem = {
  code: 'schema-violation',
  detail:
    'The response did not have the required shape. Return exactly the fields described, with no extra fields, and keep every text field within a reasonable length.',
}

function describeFailure(failure: ProviderFailure): StrategyFailureReason {
  switch (failure.reason) {
    case 'invalid_output':
      return 'invalid'
    case 'refused':
      return 'refused'
    case 'misconfigured':
      return 'misconfigured'
    case 'unavailable':
      return 'unavailable'
  }
}

const LEARNER_MESSAGES: Readonly<Record<StrategyFailureReason, string>> = {
  invalid: 'The tutor could not put together a usable response just now. Try again in a moment.',
  refused: 'The tutor declined to answer that one.',
  unavailable: 'The tutor is not reachable at the moment. Your progress is saved.',
  misconfigured: 'The tutor is not configured correctly. Check the application settings.',
}

/**
 * Runs one structured strategy end to end.
 *
 * Never throws for a model or network failure — those are expected and are returned as an
 * outcome the caller can act on. It throws only for a programming error, such as a strategy
 * being handed input it cannot build a prompt from.
 */
export async function runStructured<Input, Output>(
  provider: TutorProvider,
  strategy: StructuredStrategy<Input, Output>,
  input: Input,
  options: RunOptions = {},
): Promise<StrategyOutcome<Output>> {
  const context = strategyContext()
  const problems: InvariantProblem[] = []
  const blocks = strategy.buildBlocks(input)

  type Attempt = { value: Output } | { problems: InvariantProblem[] } | { failure: ProviderFailure }

  /**
   * One call, validated here.
   *
   * The schema is applied in this function rather than being left to the provider. The
   * provider applies one too, but a provider is exactly the component whose behaviour cannot
   * be assumed: the constraints that matter most — text lengths, array sizes, index ranges —
   * are not enforced by Structured Outputs at all, and a different provider, a cached
   * response or a decoding quirk could bypass it entirely. Validating here makes the
   * provider's own check an optimisation rather than the guarantee.
   */
  const attempt = async (withBlocks: readonly PromptBlock[]): Promise<Attempt> => {
    const result = await provider.structured({
      strategy: strategy.id,
      strategyVersion: strategy.version,
      blocks: withBlocks,
      schema: strategy.schema,
      schemaName: strategy.schemaName,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })

    if (!result.ok) return { failure: result.failure }

    const parsed = strategy.schema.safeParse(result.value)
    if (!parsed.success) return { problems: [SCHEMA_VIOLATION] }

    const invariantProblems = strategy.checkInvariants(parsed.data, input, context)
    return invariantProblems.length === 0 ? { value: parsed.data } : { problems: [...invariantProblems] }
  }

  const first = await attempt(blocks)

  if ('value' in first) {
    return usable(first.value, 'model', { repairAttempted: false, repairSucceeded: false, problems })
  }
  if ('failure' in first) {
    // A refusal or an outage is not something a repair can fix: the model did not produce
    // something wrong, it produced nothing. Retrying would just ask again.
    if (first.failure.reason !== 'invalid_output') {
      return failed(describeFailure(first.failure), problems, false)
    }
    problems.push(SCHEMA_VIOLATION)
  } else {
    problems.push(...first.problems)
  }

  // Cancellation between the two attempts must not still spend a second call.
  if (options.signal?.aborted === true) {
    return failed('unavailable', problems, false)
  }

  const second = await attempt([...blocks, repairBlock(problems)])

  if ('value' in second) {
    return usable(second.value, 'model', { repairAttempted: true, repairSucceeded: true, problems })
  }
  if ('failure' in second) {
    if (second.failure.reason !== 'invalid_output') {
      return failed(describeFailure(second.failure), problems, true)
    }
    problems.push(SCHEMA_VIOLATION)
  } else {
    problems.push(...second.problems)
  }

  return withFallback('invalid', problems, strategy, input)
}

function usable<Output>(
  value: Output,
  source: OutcomeSource,
  meta: { repairAttempted: boolean; repairSucceeded: boolean; problems: readonly InvariantProblem[] },
): StrategyOutcome<Output> {
  return {
    ok: true,
    source,
    value,
    repairAttempted: meta.repairAttempted,
    repairSucceeded: meta.repairSucceeded,
    problems: meta.problems,
  }
}

function failed<Output>(
  reason: StrategyFailureReason,
  problems: readonly InvariantProblem[],
  repairAttempted: boolean,
): StrategyOutcome<Output> {
  return {
    ok: false,
    value: null,
    failureReason: reason,
    message: LEARNER_MESSAGES[reason],
    repairAttempted,
    repairSucceeded: false,
    problems,
  }
}

/**
 * Falls back, but only when the model actually produced something unusable.
 *
 * A refusal, an outage or a missing API key says nothing whatever about the learner's
 * attempt, so substituting an observation about it would be inventing evidence about a
 * person because the network was down. Fallbacks exist for the case where the model
 * responded and its response could not be used — nothing else.
 */
function withFallback<Input, Output>(
  reason: StrategyFailureReason,
  problems: readonly InvariantProblem[],
  strategy: StructuredStrategy<Input, Output>,
  input: Input,
): StrategyOutcome<Output> {
  const fallback = strategy.safeFallback(input)
  if (fallback === null) return failed(reason, problems, true)

  return usable(fallback, 'fallback', {
    repairAttempted: true,
    repairSucceeded: false,
    problems,
  })
}
