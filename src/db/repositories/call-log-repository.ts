import { randomUUID } from 'node:crypto'

import type { CallLogSink, LlmCallLog } from '@/tutor/logging/call-log'

import type { Db } from '../client'
import { llmCall } from '../schema'
import { LEARNER_ID } from './learner-repository'

/**
 * Somewhere for the M2 call log to live.
 *
 * The shape was designed in M2 with no columns for a prompt or a response, and the table
 * matches it exactly — so there is no parameter anywhere on this path through which the
 * learner's words could reach an operational log. What accumulates on disk is how long calls
 * took, whether they worked, and what they cost.
 *
 * The conversation itself is stored once, in `session_turn`, where the learner can read it and
 * where deleting their data deletes it.
 */
export class DatabaseCallLog implements CallLogSink {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  record(log: LlmCallLog): void {
    this.#db
      .insert(llmCall)
      .values({
        id: randomUUID(),
        learnerId: LEARNER_ID,
        strategyId: log.strategyId,
        strategyVersion: log.strategyVersion,
        policyVersion: log.policyVersion,
        curriculumVersion: log.curriculumVersion,
        model: log.model,
        latencyMs: log.latencyMs,
        outcome: log.outcome,
        repairAttempted: log.repairAttempted,
        repairSucceeded: log.repairSucceeded,
        problemCodes: [...log.problemCodes],
        failureReason: log.failureReason,
        // Absent rather than zero when the provider reported nothing. A fabricated zero would
        // be indistinguishable from a call that genuinely used no tokens.
        inputTokens: log.usage?.inputTokens ?? null,
        cachedInputTokens: log.usage?.cachedInputTokens ?? null,
        outputTokens: log.usage?.outputTokens ?? null,
        streamed: log.streamed,
        at: new Date(log.at),
      })
      .run()
  }
}
