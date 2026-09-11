import { OpenAIProvider } from './openai-provider'
import type { TutorProvider } from './provider'
import { workingTutor } from './fixtures'

/**
 * Choosing which provider the application talks to.
 *
 * Four cases, and the important one is the last:
 *
 *   - `LLM_PROVIDER=mock`   — the deterministic mock. What the tests and the end-to-end suite
 *                             use, so the whole suite runs for someone who has never
 *                             configured the application.
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

export function resolveProvider(): ResolvedProvider | null {
  if (process.env['LLM_PROVIDER'] === 'mock') {
    return { provider: workingTutor(), model: 'mock' }
  }
  if (process.env['LLM_PROVIDER'] === 'none') return null

  const real = OpenAIProvider.fromEnvironment()
  if (real !== null) return { provider: real, model: real.model }

  return null
}
