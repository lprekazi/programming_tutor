import { OpenAIProvider } from './openai-provider'
import type { TutorProvider } from './provider'
import { flakyTutor, pacedTutor, workingTutor } from './fixtures'

/**
 * Choosing which provider the application talks to.
 *
 * Four cases, and the important one is the last:
 *
 *   - `LLM_PROVIDER=mock`   — the deterministic mock. What the tests and the end-to-end suite
 *                             use, so the whole suite runs for someone who has never
 *                             configured the application. `mock-slow` and `mock-failing` are
 *                             the same mock pacing its output or dropping its first attempt,
 *                             for exercising cancellation and retry.
 *   - `LLM_PROVIDER=none`   — no tutor, deliberately. Someone who wants to see what the
 *                             application does without a model, and how the end-to-end suite
 *                             exercises that path without depending on what is or is not
 *                             configured on the machine running it.
 *   - a key is configured   — the real provider.
 *   - none of the above     — **null**, meaning the tutor cannot be reached.
 *
 * The third case returns null rather than silently substituting the mock. Quietly falling back
 * would mean a learner being marked on fabricated judgements while believing a real tutor had
 * read their answer, which is worse than telling them the tutor is unavailable.
 */

export interface ResolvedProvider {
  readonly provider: TutorProvider
  /** What to record in the call log. Never a key. */
  readonly model: string
}

/**
 * Resolved once per process, per configuration.
 *
 * Not only an optimisation. A provider is allowed to carry state — a retry counter, a
 * connection, a cache — and rebuilding it on every request quietly resets whatever it was
 * keeping. That is how a provider written to fail once and then succeed came to fail for ever.
 *
 * The key covers everything the decision depends on, not just `LLM_PROVIDER`. Keying on that
 * alone meant a changed `OPENAI_MODEL` kept serving the old one — and the model name is written
 * into `session_turn` and `llm_call`, so provenance would have recorded the wrong thing — and a
 * process that started before a key was configured kept reporting "no tutor" afterwards.
 *
 * Only the *presence* of a key is part of the key, never its value.
 */
const resolved = new Map<string, ResolvedProvider | null>()

export function resolveProvider(): ResolvedProvider | null {
  const key = [
    process.env['LLM_PROVIDER'] ?? '',
    process.env['OPENAI_MODEL'] ?? '',
    process.env['OPENAI_API_KEY'] === undefined ? 'no-key' : 'key',
  ].join('|')

  if (resolved.has(key)) return resolved.get(key) ?? null

  const provider = buildProvider()
  resolved.set(key, provider)
  return provider
}

function buildProvider(): ResolvedProvider | null {
  const configured = process.env['LLM_PROVIDER']

  if (configured === 'mock') return { provider: workingTutor(), model: 'mock' }
  /*
   * Two further mock modes, both for exercising things the plain mock cannot reach.
   *
   * `mock-slow` paces its chunks, because a stream that resolves on a microtask leaves no
   * window in which Stop could be pressed. `mock-failing` drops its first attempt at each
   * prose turn and succeeds on the next, which is the transient failure the retry control
   * exists for — counted rather than timed, so a test of it is deterministic.
   *
   * Both announce themselves as mocks through the model name, so the interface says outright
   * that replies are coming from a script.
   */
  if (configured === 'mock-slow') return { provider: pacedTutor(120), model: 'mock' }
  if (configured === 'mock-failing') return { provider: flakyTutor(), model: 'mock' }

  if (configured === 'none') return null

  const real = OpenAIProvider.fromEnvironment()
  if (real !== null) return { provider: real, model: real.model }

  return null
}
