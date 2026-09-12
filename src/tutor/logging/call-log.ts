import type { TokenUsage } from '@/llm/provider'

import type { StrategyFailureReason } from '../validate/run'

/**
 * What is recorded about a call to the model.
 *
 * Two audiences. Operationally, this is how a failing tutor gets diagnosed. For the eventual
 * report, it is the only source of real numbers about how the system behaved — how often
 * output needed repairing, how often repair worked, how much was spent, how much of the
 * prompt the provider reused.
 *
 * **What is deliberately not here: the prompt and the response.**
 *
 * That is a decision, not an oversight. Prompts contain the learner's own words, their code,
 * and a summary of what they are struggling with. Logging all of it by default would mean a
 * complete record of someone's difficulties accumulating on disk as a side effect of using
 * the application — which nobody asked for and nobody would expect from a local tool.
 *
 * The metadata below answers the questions that actually need answering, and answers them
 * without retaining anything the learner wrote. Where a full transcript is genuinely needed —
 * for the M9 tutoring-quality evaluation — it is captured deliberately, into its own store,
 * for a named purpose. Not by leaving this switched on.
 *
 * An API key is never part of any of this. The key is read from the environment inside the
 * provider and never leaves it.
 */

export interface LlmCallLog {
  /** Epoch milliseconds, supplied by the caller. */
  readonly at: number
  readonly strategyId: string
  readonly strategyVersion: string
  /** Version of the shared tutoring policy in force for this call. */
  readonly policyVersion: string
  /** Version of the curriculum vocabulary in force for this call. */
  readonly curriculumVersion: string
  /** Whatever `OPENAI_MODEL` was set to, or `mock`. Never a key. */
  readonly model: string
  /** Wall-clock milliseconds for the whole operation, including any repair attempt. */
  readonly latencyMs: number

  /**
   * `cancelled` is its own outcome, not a failure.
   *
   * A learner pressing Stop was being recorded as `failed`, distinguishable from a real outage
   * only by `failureReason` happening to be null. Any reliability figure computed from this
   * table would have counted ordinary use of the Stop button against the system — and this
   * table is the only source of real numbers about how it behaved.
   */
  readonly outcome: 'ok' | 'ok-after-repair' | 'fallback' | 'failed' | 'cancelled'
  readonly repairAttempted: boolean
  readonly repairSucceeded: boolean
  /** Codes of every validation problem seen, in order. Codes only — details can quote learner text. */
  readonly problemCodes: readonly string[]
  readonly failureReason: StrategyFailureReason | null

  /** Absent when the provider does not report usage, never guessed. */
  readonly usage: TokenUsage | null
  /** True when the call streamed prose rather than returning structured output. */
  readonly streamed: boolean
}

/** Where call logs go. Implemented against the database in a later milestone. */
export interface CallLogSink {
  record(log: LlmCallLog): void
}

/** Collects logs in memory. Used by tests, and by anything that wants the session's calls. */
export class InMemoryCallLog implements CallLogSink {
  readonly #logs: LlmCallLog[] = []

  record(log: LlmCallLog): void {
    this.#logs.push(log)
  }

  get logs(): readonly LlmCallLog[] {
    return this.#logs
  }

  clear(): void {
    this.#logs.length = 0
  }
}

/** Discards everything. The default, so nothing is recorded unless a sink is supplied. */
export const NULL_CALL_LOG: CallLogSink = { record: () => undefined }

export interface BuildLogInput {
  readonly at: number
  readonly strategyId: string
  readonly strategyVersion: string
  readonly policyVersion: string
  readonly curriculumVersion: string
  readonly model: string
  readonly latencyMs: number
  readonly streamed: boolean
  readonly ok: boolean
  readonly usedFallback: boolean
  /** The learner stopped it. Neither a success nor a failure. */
  readonly cancelled?: boolean | undefined
  readonly repairAttempted: boolean
  readonly repairSucceeded: boolean
  readonly failureReason: StrategyFailureReason | null
  readonly problemCodes: readonly string[]
  readonly usage: TokenUsage | null
}

/**
 * Builds a log entry.
 *
 * Takes only the fields above, which is the point: there is no parameter through which a
 * prompt or a response could be passed, so content cannot end up here by someone adding it
 * at a call site.
 */
export function buildCallLog(input: BuildLogInput): LlmCallLog {
  const outcome: LlmCallLog['outcome'] =
    input.cancelled === true
      ? 'cancelled'
      : input.usedFallback
        ? 'fallback'
        : !input.ok
          ? 'failed'
          : input.repairSucceeded
            ? 'ok-after-repair'
            : 'ok'

  return {
    at: input.at,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion,
    policyVersion: input.policyVersion,
    curriculumVersion: input.curriculumVersion,
    model: input.model,
    latencyMs: input.latencyMs,
    outcome,
    repairAttempted: input.repairAttempted,
    repairSucceeded: input.repairSucceeded,
    problemCodes: input.problemCodes,
    failureReason: input.failureReason,
    usage: input.usage,
    streamed: input.streamed,
  }
}
