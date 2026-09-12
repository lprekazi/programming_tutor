import type { ConceptId, MisconceptionId } from '@/domain/curriculum/types'
import type { ConceptState } from '@/domain/learner-model/state'
import { focusFor, type SessionFocus, type Turn } from '@/domain/tutoring/session'
import type { PromptBlock, TutorProvider } from '@/llm/provider'

import { buildCallLog, type CallLogSink } from '../logging/call-log'
import { converseStrategy, explainStrategy } from '../strategies/prose'
import { versionOf } from '../strategies/shared'
import type { StructuredStrategy } from '../strategies/types'
import { runStructured, type StrategyOutcome } from '../validate/run'

import { conversationFor, trimmedNote, tutoringContext } from './context'

/**
 * Assembling one tutoring turn.
 *
 * The decisions that make a session feel like teaching rather than a chat window are made
 * here, before the model is involved:
 *
 *   - **which strategy.** Opening a concept is an explanation; replying to something the
 *     learner said is a conversation. They want different instructions, and choosing between
 *     them from the shape of the session is more reliable than one prompt trying to be both.
 *   - **how deep.** Taken from what the learner has demonstrated, never from the model's
 *     impression of them.
 *   - **how much conversation.** Bounded, with the tutor told when the thread runs back
 *     further than it can see.
 */

export interface TurnRequest {
  readonly conceptId: ConceptId
  readonly goal: string | null
  readonly states: readonly ConceptState[]
  readonly recentMisconceptions: readonly MisconceptionId[]
  /** Everything said so far, oldest first. Empty for an opening turn. */
  readonly turns: readonly Turn[]
  /** What the learner has just written, or null when this is the opening turn. */
  readonly message: string | null
}

export interface PreparedTurn {
  readonly blocks: readonly PromptBlock[]
  readonly strategyId: string
  readonly strategyVersion: string
}

export function prepareTurn(request: TurnRequest): PreparedTurn {
  const learner = tutoringContext({
    goal: request.goal,
    conceptId: request.conceptId,
    states: request.states,
    recentMisconceptions: request.recentMisconceptions,
  })

  if (request.message === null) {
    const state = request.states.find((candidate) => candidate.conceptId === request.conceptId)
    const focus = state === undefined ? null : focusFor(state)

    return {
      blocks: explainStrategy.buildBlocks({
        learner,
        conceptId: request.conceptId,
        depth: focus?.pitch ?? 'introduce',
        focus: focus === null ? null : openingFocus(focus),
      }),
      strategyId: explainStrategy.id,
      strategyVersion: explainStrategy.version,
    }
  }

  const conversation = conversationFor(request.turns)

  return {
    blocks: converseStrategy.buildBlocks({
      learner,
      history: conversation.history,
      message: request.message,
      // Not a task in the exercise sense — there is no exercise in this milestone. What it
      // carries is the standing instruction to stay on the concept, plus the warning when
      // part of the thread is out of view.
      activeTask: conversation.trimmed ? trimmedNote(request.conceptId) : null,
    }),
    strategyId: converseStrategy.id,
    strategyVersion: converseStrategy.version,
  }
}

/**
 * The extra line of context on an opening turn.
 *
 * Derived from the pitch, which is derived from the band. An earlier version keyed it off
 * "has any prior evidence" and said *"They have worked on this before and it did not go
 * well"* to every returning learner — so a secure learner coming back for review was told
 * their last attempt had gone badly, and a learner whose single prior answer was *correct*
 * got that sentence in the same prompt as "They have not worked on this before. Start from a
 * concrete example."
 *
 * Two contradictory statements in one prompt is worse than neither. So the pitch is the only
 * thing that speaks, and `returning` only refines the case where the pitch alone is ambiguous.
 */
function openingFocus(focus: SessionFocus): string | null {
  switch (focus.pitch) {
    case 'introduce':
      // `introduce` covers both a first meeting and someone who has answered once or twice
      // and got it right — the depth instruction is the same, but "welcome back" and "here is
      // something new" are not, so the difference is stated.
      return focus.returning
        ? 'They have answered on this once or twice and got it right, but not enough to build on. Do not present it as something they have never met.'
        : null
    case 'clarify':
      return 'They have attempted this and it is going wrong somewhere. Pick up from what is likely going wrong rather than starting over.'
    case 'deepen':
      // The depth instruction already says to go to the edge case. All this adds is that it is
      // a revisit, so the tutor does not re-teach the basics it is meant to be building on.
      return 'They are coming back to this after a gap, and were solid on it. Treat it as a revisit, not a first lesson.'
  }
}

/**
 * Runs a structured call and records what it cost.
 *
 * `runStructured` deliberately knows nothing about logging — it is the validation pipeline, and
 * M2 left the recording to whoever made the call. This is that, for the tutoring layer, so a
 * sidecar observation shows up in the call log beside the streamed turn it followed rather than
 * being the one call nobody can account for.
 */
export async function runLoggedStructured<Input, Output>(
  provider: TutorProvider,
  strategy: StructuredStrategy<Input, Output>,
  input: Input,
  options: { readonly model: string; readonly log: CallLogSink; readonly now: () => number },
): Promise<StrategyOutcome<Output>> {
  const started = options.now()
  const outcome = await runStructured(provider, strategy, input)

  options.log.record(
    buildCallLog({
      at: started,
      ...versionOf(strategy.id, strategy.version),
      model: options.model,
      latencyMs: options.now() - started,
      streamed: false,
      ok: outcome.ok,
      usedFallback: outcome.ok && outcome.source === 'fallback',
      repairAttempted: outcome.repairAttempted,
      repairSucceeded: outcome.ok && outcome.repairSucceeded,
      failureReason: outcome.ok ? null : outcome.failureReason,
      problemCodes: outcome.problems.map((problem) => problem.code),
      usage: null,
    }),
  )

  return outcome
}

export type StreamEnd =
  /** Finished normally. */
  | { readonly kind: 'complete'; readonly text: string }
  /** The learner stopped it. Whatever arrived is kept. */
  | { readonly kind: 'cancelled'; readonly text: string }
  /** Something went wrong. Whatever arrived is kept and it can be retried. */
  | { readonly kind: 'failed'; readonly text: string; readonly message: string }

export interface StreamTurnOptions {
  readonly provider: TutorProvider
  readonly model: string
  readonly prepared: PreparedTurn
  readonly signal: AbortSignal
  readonly onDelta: (delta: string) => void
  readonly log: CallLogSink
  readonly now: () => number
}

/**
 * Runs a prose turn, reporting deltas as they arrive and classifying how it ended.
 *
 * The three endings are kept apart deliberately. A learner who pressed Stop should not be told
 * something went wrong, and a learner whose connection dropped should not be left thinking
 * they cancelled it — they need different things from the interface, and one of them needs a
 * retry button.
 *
 * Whatever text arrived before the end is returned in every case, so the caller can store it.
 * A reply the learner half-read should not vanish.
 */
export async function streamTurn(options: StreamTurnOptions): Promise<StreamEnd> {
  const started = options.now()
  let text = ''

  const finish = (
    ok: boolean,
    reason: 'unavailable' | null,
    cancelled = false,
  ): void => {
    options.log.record(
      buildCallLog({
        at: started,
        ...versionOf(options.prepared.strategyId, options.prepared.strategyVersion),
        model: options.model,
        latencyMs: options.now() - started,
        streamed: true,
        ok,
        usedFallback: false,
        repairAttempted: false,
        repairSucceeded: false,
        cancelled,
        failureReason: reason,
        problemCodes: [],
        // Streaming responses report no usage through this provider interface. Recorded as
        // absent rather than as zero, which would be indistinguishable from a free call.
        usage: null,
      }),
    )
  }

  try {
    for await (const chunk of options.provider.streamText(
      {
        strategy: options.prepared.strategyId,
        strategyVersion: options.prepared.strategyVersion,
        blocks: options.prepared.blocks,
      },
      options.signal,
    )) {
      if (options.signal.aborted) break
      text += chunk.delta
      options.onDelta(chunk.delta)
    }
  } catch {
    // An abort surfacing as a throw is still a cancellation, not a failure. Which one it is
    // decides what the learner is told and whether they are offered a retry.
    if (options.signal.aborted) {
      // Recorded as cancelled, not failed: the learner stopping a reply is not the system
      // going wrong, and counting it as one would overstate the failure rate.
      finish(false, null, true)
      return { kind: 'cancelled', text }
    }

    finish(false, 'unavailable')
    return {
      kind: 'failed',
      text,
      // Deliberately not the provider's own message, which can carry model-chosen text,
      // internal endpoints or a stack.
      message: 'The tutor could not be reached. Nothing you wrote has been lost.',
    }
  }

  if (options.signal.aborted) {
    finish(false, null, true)
    return { kind: 'cancelled', text }
  }

  finish(true, null)
  return { kind: 'complete', text }
}
