'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { MAX_MESSAGE_LENGTH, type Turn } from '@/domain/tutoring/session'
import { FAILURE_MARKER } from '@/tutor/session/stream-protocol'
import { TutorProse } from '@/ui/components/TutorProse'

import { cancelTutorTurn, finishSession, retryTutorTurn, sendMessage } from '../../actions'

import styles from './page.module.css'

/**
 * The conversation, and the four things that can happen to a tutor turn.
 *
 * The turns come from the server; this component streams new text into the last one and then
 * refreshes so the server's version becomes the source of truth again. It deliberately keeps
 * no long-lived copy of the conversation: everything it holds is the reply currently arriving,
 * which by definition has not been stored yet.
 *
 * Four endings, kept apart because they need different things from the learner:
 *
 *   - **complete** — nothing to do.
 *   - **cancelled** — they pressed Stop. Not an error, and not something to apologise for.
 *   - **failed** — the tutor could not be reached. Offer a retry.
 *   - **still pending on load** — the page was reloaded mid-reply. Offer a retry.
 */

interface Props {
  readonly sessionId: string
  readonly conceptTitle: string
  readonly turns: readonly Turn[]
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'streaming'; readonly turnId: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }

const TUTOR_LABEL = 'Tutor'
const LEARNER_LABEL = 'You'

export function SessionRunner({ sessionId, conceptTitle, turns }: Props) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /** Text arriving right now, for the turn named in `phase`. Never the whole conversation. */
  const [live, setLive] = useState('')
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [pendingSend, setPendingSend] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  /** Mirrors `live` so `stop` can report what the learner saw without re-creating itself. */
  const liveRef = useRef('')
  const startedRef = useRef<string | null>(null)
  const statusRef = useRef<HTMLParagraphElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const stored = [...turns].sort((a, b) => a.ordinal - b.ordinal)
  const lastStored = stored.at(-1)

  /** A tutor turn nobody has streamed yet. Only `pending` — a stopped one stays stopped. */
  const awaitingStream =
    lastStored?.role === 'tutor' && lastStored.status === 'pending' ? lastStored : null

  /**
   * The tutor turn the page is currently working on, finished or not.
   *
   * Kept rendered even when it holds nothing yet, so that a reply which is arriving, was
   * stopped, or failed has somewhere to appear. Filtering it out was making a cancelled reply
   * vanish from the page — the learner pressed Stop and the half they had just read
   * disappeared with it.
   */
  const currentTutorTurn =
    lastStored?.role === 'tutor' && lastStored.status !== 'complete' ? lastStored : null

  const run = useCallback(
    async (turnId: string) => {
      const controller = new AbortController()
      abortRef.current = controller
      setPhase({ kind: 'streaming', turnId })
      setLive('')
      setProblem(null)

      let received = ''
      liveRef.current = ''
      try {
        const response = await fetch(`/api/tutor/${turnId}`, {
          method: 'POST',
          signal: controller.signal,
        })

        if (!response.ok || response.body === null) {
          setPhase({
            kind: 'failed',
            message:
              response.status === 503
                ? 'No tutor is configured, so there is nothing to answer with yet.'
                : 'The tutor could not be reached.',
          })
          return
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += decoder.decode(value, { stream: true })

          // The server appends this when a stream dies part-way, because by then the status
          // line has long gone. It is stripped before anything is shown or kept.
          if (received.includes(FAILURE_MARKER)) {
            liveRef.current = received.replaceAll(FAILURE_MARKER, '')
            setLive(liveRef.current)
            setPhase({
              kind: 'failed',
              message: 'The tutor stopped part-way through. Nothing you wrote has been lost.',
            })
            return
          }
          liveRef.current = received
          setLive(received)
        }

        setPhase({ kind: 'idle' })
        // Refreshed rather than reloaded. A full reload would put the stored turn on the page
        // and take the learner's keyboard focus and scroll position with it, after every
        // single reply. `live` is cleared once the stored text has arrived to replace it.
        router.refresh()
      } catch {
        if (controller.signal.aborted) {
          setPhase({ kind: 'cancelled' })
          return
        }
        setPhase({
          kind: 'failed',
          message: 'The connection to the tutor was lost. Nothing you wrote has been lost.',
        })
      }
    },
    [router],
  )

  // Streams whatever turn is waiting, exactly once per turn. The ref is what stops React's
  // development double-invocation from opening two streams into the same row.
  useEffect(() => {
    if (awaitingStream === null) return
    if (startedRef.current === awaitingStream.id) return
    startedRef.current = awaitingStream.id
    void run(awaitingStream.id)
  }, [awaitingStream, run])

  const stop = useCallback(() => {
    if (phase.kind !== 'streaming') return
    abortRef.current?.abort()
    // Stop and Try again both unmount themselves, which drops keyboard focus to the document
    // and leaves the learner tabbing in from the top. The compose box is where they are going
    // next, and it never unmounts.
    inputRef.current?.focus()
    // Told to the server outright, and named by turn id. Aborting a fetch does not reliably
    // reach a streaming route handler, and where it does not, the request finishes and stores
    // the whole reply — so Stop appeared to work until the next reload brought the rest back.
    void cancelTutorTurn(phase.turnId, liveRef.current)
  }, [phase])

  const send = useCallback(() => {
    const text = draft
    setProblem(null)
    setPendingSend(true)

    void sendMessage(sessionId, text)
      .then((result) => {
        if (result.status === 'rejected') {
          // The draft is deliberately left alone. Clearing the box on a rejection would throw
          // away something the learner has just written because the server said no.
          setProblem(result.message)
          return
        }
        setDraft('')
        // Cleared before the refresh, or the text of the *previous* reply would flash in the
        // slot the next one is about to occupy.
        setLive('')
        // Not pre-claimed: the refresh brings the reserved tutor turn down as a prop, and the
        // effect below is what starts streaming it. Claiming it here would make the effect
        // skip the turn it was waiting for.
        router.refresh()
      })
      .catch(() => {
        setProblem('That could not be sent. Your message is still here — try again.')
      })
      .finally(() => {
        setPendingSend(false)
      })
  }, [draft, router, sessionId])

  const retry = useCallback(() => {
    setProblem(null)
    inputRef.current?.focus()
    void retryTutorTurn(sessionId)
      .then((result) => {
        if (result === null) return
        // Claimed *before* streaming, not cleared. Clearing it let the effect below see a
        // pending turn it had not started and open a second stream into the same row.
        startedRef.current = result.turnId
        void run(result.turnId)
      })
      .catch(() => {
        setProblem('That could not be retried just now.')
      })
  }, [run, sessionId])

  const streaming = phase.kind === 'streaming'

  /** What the live region should say, or null when there is nothing to report. */
  const status: string | null =
    phase.kind === 'streaming'
      ? live.length === 0
        ? `The tutor is thinking about ${conceptTitle}…`
        : 'The tutor is replying.'
      : phase.kind === 'cancelled'
        ? 'You stopped the reply. You can ask again below.'
        : phase.kind === 'failed'
          ? phase.message
          : problem
  const visible = stored.filter(
    (turn) => turn.text.trim().length > 0 || turn.id === currentTutorTurn?.id,
  )
  const remaining = MAX_MESSAGE_LENGTH - draft.length

  return (
    <div className={styles.session}>
      <ol className={styles.turns} data-testid="turns">
        {visible.map((turn) => {
          // `live` outlives the stream on purpose: after Stop or a failure it is the only copy
          // of the text that arrived, until a reload replaces it with the stored one.
          const isCurrent = turn.id === currentTutorTurn?.id
          const text = isCurrent && live.length > 0 ? live : turn.text

          return (
            <li
              className={turn.role === 'tutor' ? styles.tutorTurn : styles.learnerTurn}
              data-role={turn.role}
              data-testid={`turn-${String(turn.ordinal)}`}
              // The streaming endpoint is addressed by turn id, so the id is on the page. It is
              // an opaque identifier for a row the learner already owns and can already read;
              // what stops it being useful to anybody is the guard on the endpoint, not the
              // difficulty of finding it — which is what the end-to-end test checks.
              data-turn-id={turn.id}
              key={turn.id}
            >
              <p className={styles.speaker}>{turn.role === 'tutor' ? TUTOR_LABEL : LEARNER_LABEL}</p>
              {turn.role === 'tutor' ? (
                <TutorProse text={text} />
              ) : (
                // The learner's own words, rendered as text. Nothing here interprets them.
                <p className={styles.learnerText}>{text}</p>
              )}
              {(turn.status === 'cancelled' || (isCurrent && phase.kind === 'cancelled')) && (
                <p className={styles.turnNote}>You stopped this reply part-way through.</p>
              )}
            </li>
          )
        })}
      </ol>

      {/*
        One live region for the whole session.
        
        Rendered always, and made *visually* hidden when there is nothing to say rather than
        `hidden`. An element with `display: none` is not in the accessibility tree, so toggling
        `hidden` created the region in the same update as its first message — which is the one
        announcement assistive technology is least likely to make, and the one a non-sighted
        learner most needs. Absolutely positioned when idle, so it costs no layout either.

        It carries the status, never the streaming prose: announcing every delta would read the
        reply aloud several times over.
      */}
      <p
        aria-live="polite"
        className={status === null ? 'visually-hidden' : styles.status}
        data-testid="session-status"
        ref={statusRef}
        tabIndex={-1}
      >
        {status ?? ''}
      </p>

      <div className={styles.controls}>
        {streaming && (
          <button className={styles.secondary} data-testid="stop-reply" onClick={stop} type="button">
            Stop
          </button>
        )}
        {phase.kind === 'failed' && (
          <button className={styles.secondary} data-testid="retry-reply" onClick={retry} type="button">
            Try again
          </button>
        )}
      </div>

      <div className={styles.compose}>
        <label className={styles.label} htmlFor="reply">
          Reply, or ask about this
        </label>
        <p className={styles.help} id="reply-help">
          Say what you are thinking, even if you are not sure. Shift + Enter for a new line.
        </p>
        {/*
          Never disabled. Disabling a focused textarea blurs it, so switching it off while the
          reply arrives took the learner's place away after every single turn — and there is no
          reason to stop them drafting the next question while they read this one. Sending
          twice is prevented by the button's state and by the key handler, neither of which
          touches focus.
        */}
        <textarea
          aria-describedby="reply-help"
          className={styles.input}
          data-testid="reply-input"
          id="reply"
          ref={inputRef}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            // Enter sends and Shift+Enter breaks the line — stated in the help text above,
            // because an unannounced Enter-to-send loses half-written thoughts.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (!streaming && !pendingSend && draft.trim().length > 0) send()
            }
          }}
          rows={3}
          value={draft}
        />

        <div className={styles.composeActions}>
          <button
            className={styles.primary}
            data-testid="send-reply"
            disabled={streaming || pendingSend || draft.trim().length === 0}
            onClick={send}
            type="button"
          >
            {pendingSend ? 'Sending…' : 'Send'}
          </button>

          {remaining < 200 && (
            <span className={styles.counter}>
              {remaining} character{remaining === 1 ? '' : 's'} left
            </span>
          )}

          <form action={finishSession.bind(null, sessionId)} className={styles.done}>
            <button className={styles.quiet} data-testid="finish-session" type="submit">
              Done for now
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
