import { after } from 'next/server'

import { getDb } from '@/db/instance'
import { DatabaseCallLog } from '@/db/repositories/call-log-repository'
import {
  readConceptStates,
  readProfile,
  readRecentMisconceptions,
} from '@/db/repositories/learner-repository'
import {
  finishTutorTurn,
  markTurnStreaming,
  readSessionByTurn,
  recordObservation,
} from '@/db/repositories/session-repository'
import { isConceptId } from '@/domain/curriculum/graph'
import { resolveProvider } from '@/llm/resolve'
import { sessionObserveStrategy } from '@/tutor/strategies/session'
import { prepareTurn, runLoggedStructured, streamTurn } from '@/tutor/session/tutor'
import { tutoringContext } from '@/tutor/session/context'
import { FAILURE_MARKER } from '@/tutor/session/stream-protocol'

/**
 * Streaming one tutor turn.
 *
 * A route handler rather than a server action, because a server action returns a value and
 * this needs to deliver text as it arrives — the whole point of streaming an explanation is
 * that the learner watches it form instead of watching a spinner.
 *
 * The turn it writes into already exists: `reserveTutorTurn` created the row before this was
 * called. So this endpoint never inserts anything, only updates, which is what makes retrying
 * an interrupted stream safe. Calling it twice for the same turn rewrites one row twice.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  context: { readonly params: Promise<{ readonly turnId: string }> },
): Promise<Response> {
  const { turnId } = await context.params
  const db = getDb()
  const now = Date.now()

  const session = readSessionByTurn(db, turnId)
  if (session === null) {
    return new Response('Unknown turn.', { status: 404 })
  }

  /*
   * What this endpoint is allowed to write into.
   *
   * The turn id arrives from the client, and everything below it writes model output into
   * whichever row it names — so without this check, posting a *learner* turn's id would stream
   * a reply into the learner's own message. The row would keep `role = 'learner'`, so the page
   * would show model prose under the learner's name and the next prompt would quote it back as
   * something they had said. Their actual words would be gone.
   *
   * So: the tutor's turn, not yet finished, and the last one in the conversation. Anything else
   * is a stale client or a guessed id, and neither has any business rewriting history.
   */
  const turn = session.turns.find((candidate) => candidate.id === turnId)
  if (turn === undefined) return new Response('Unknown turn.', { status: 404 })

  const isLast = session.turns.every((candidate) => candidate.ordinal <= turn.ordinal)
  if (turn.role !== 'tutor' || turn.status === 'complete' || !isLast) {
    return new Response('That turn is not waiting for a reply.', { status: 409 })
  }

  const resolved = resolveProvider()
  if (resolved === null) {
    // No tutor configured. Nothing is invented and nothing is written as though it came from
    // one; the turn is marked failed so the interface can offer a retry once one exists.
    finishTutorTurn(db, turnId, 'failed', '', now)
    return new Response('unavailable', { status: 503 })
  }

  const profile = readProfile(db)

  // The learner's message is the turn immediately before this one, where there is one. An
  // opening turn has nothing before it, which is what tells `prepareTurn` to explain rather
  // than converse.
  const previous = session.turns.filter((candidate) => candidate.ordinal < turn.ordinal)
  const lastLearnerTurn = [...previous].reverse().find((candidate) => candidate.role === 'learner')
  const message = turn.ordinal === 0 ? null : (lastLearnerTurn?.text ?? null)

  const prepared = prepareTurn({
    conceptId: session.conceptId,
    goal: profile?.goal ?? null,
    states: readConceptStates(db),
    recentMisconceptions: readRecentMisconceptions(db),
    // The turn being written is excluded: it is empty, and a pending turn is not context.
    turns: previous,
    message,
  })

  const controller = new AbortController()
  // The client aborting its fetch tears this down. Whatever arrived is still persisted, in the
  // `finally` below, so a stopped reply keeps the half the learner already read.
  _request.signal.addEventListener('abort', () => {
    controller.abort()
  })

  const encoder = new TextEncoder()

  /*
   * Marked before the first chunk is asked for.
   *
   * Without it a turn being streamed right now is indistinguishable from one nobody has started,
   * so reloading mid-reply — or opening a second tab — had the page open a second stream into the
   * same row. The unique ordinal still prevented a duplicated *message*, but two provider calls
   * were made and paid for, and their two writes raced.
   */
  markTurnStreaming(db, turnId, now)

  const body = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const end = await streamTurn({
        provider: resolved.provider,
        model: resolved.model,
        prepared,
        signal: controller.signal,
        onDelta: (delta) => {
          try {
            streamController.enqueue(encoder.encode(delta))
          } catch {
            // The client has gone. Stop asking the provider for more: nobody is reading it,
            // and on a real provider it is still being paid for.
            controller.abort()
          }
        },
        log: new DatabaseCallLog(db),
        now: () => Date.now(),
      })

      finishTutorTurn(db, turnId, end.kind, end.text, Date.now())

      if (end.kind === 'failed') {
        try {
          // A trailing marker rather than an HTTP status, because the status line has already
          // been sent by the time a stream can fail. The client strips it.
          streamController.enqueue(encoder.encode(FAILURE_MARKER))
        } catch {
          // Nothing to tell.
        }
      }

      streamController.close()

      /*
       * The sidecar runs after the response, not inside it.
       *
       * It was awaited before `close()`, which meant the learner's stream stayed open until a
       * second model call had finished — so the page went on saying the tutor was replying for
       * a second or two after the reply had visibly stopped, over bookkeeping that does not
       * concern them. `after` keeps the work alive without holding the response.
       */
      /*
       * Re-read rather than trusted. `end.kind` says how the stream ended; the stored status
       * says what the learner actually kept. A cancellation arriving while the last chunks were
       * still being consumed means the reply was stopped, and there is nothing to observe about
       * a reply nobody read to the end.
       */
      const stored = readSessionByTurn(db, turnId)?.turns.find((each) => each.id === turnId)

      if (end.kind === 'complete' && message !== null && stored?.status === 'complete') {
        after(
          observeExchange(db, {
            sessionId: session.id,
            turnId,
            conceptId: session.conceptId,
            goal: profile?.goal ?? null,
            message,
            reply: end.text,
          }),
        )
      }
    },
    cancel() {
      controller.abort()
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      // Streaming through a proxy that buffers would defeat the point.
      'x-accel-buffering': 'no',
    },
  })
}

interface ObserveInput {
  readonly sessionId: string
  readonly turnId: string
  readonly conceptId: string
  readonly goal: string | null
  readonly message: string
  readonly reply: string
}

/**
 * Notes what the exchange was about.
 *
 * Explicitly not evidence, and not on the path to any. It fails silently because it must: if
 * the observation cannot be made, the honest outcome is no row, and the learner should not be
 * shown an error about bookkeeping that does not concern them.
 */
async function observeExchange(db: ReturnType<typeof getDb>, input: ObserveInput): Promise<void> {
  const resolved = resolveProvider()
  if (resolved === null || !isConceptId(input.conceptId)) return

  const outcome = await runLoggedStructured(
    resolved.provider,
    sessionObserveStrategy,
    {
      learner: tutoringContext({
        goal: input.goal,
        conceptId: input.conceptId,
        states: readConceptStates(db),
        recentMisconceptions: readRecentMisconceptions(db),
      }),
      conceptId: input.conceptId,
      learnerMessage: input.message,
      tutorReply: input.reply,
    },
    { model: resolved.model, log: new DatabaseCallLog(db), now: () => Date.now() },
  )

  if (!outcome.ok) return

  recordObservation(db, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    conceptsDiscussed: outcome.value.conceptsDiscussed,
    misconceptions: outcome.value.misconceptions,
    note: outcome.value.note,
    at: Date.now(),
  })
}
