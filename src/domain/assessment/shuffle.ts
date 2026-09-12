/**
 * Putting the options in an order the learner cannot predict.
 *
 * The M3 diagnostic audit found every multiple-choice item in the bank with its correct answer
 * at index 0 — a learner who noticed could have scored full marks without reading a question.
 * That was fixed by varying the positions by hand and asserting the distribution, which works
 * but puts the burden on whoever authors the next item, and does nothing at all for a question
 * the model generated.
 *
 * So the order is decided here instead, per activity. An author writes options in whatever
 * order reads most clearly and does not think about position; a generator can put the answer
 * wherever it likes; and what reaches the learner is shuffled either way. There is no position
 * pattern to notice, because position carries no information.
 *
 * **Deterministic**, from a seed the caller supplies — in practice the activity's own id. The
 * same activity always presents the same order, so a reload does not reshuffle the question
 * under the learner, and a test can assert an exact arrangement. The domain forbids
 * `Math.random` for precisely this reason (`architecture.test.ts`), and a seeded shuffle is
 * what replaces it.
 */

/**
 * A small, fast, well-distributed string hash.
 *
 * FNV-1a, 32-bit. Chosen because it is four lines, has no dependencies, and its avalanche
 * behaviour is good enough that two activity ids differing by one character give unrelated
 * orders. Nothing here is security-sensitive: the seed is a UUID the learner already has.
 */
function hashOf(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** A deterministic 32-bit generator. Mulberry32 — again, small and adequately distributed. */
function generatorFrom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ShuffledOptions {
  /** The options in the order the learner will see them. */
  readonly options: readonly string[]
  /** Where the correct answer ended up. */
  readonly correctIndex: number
  /** Per-option misconceptions, reordered to match. */
  readonly optionMisconceptions: readonly (string | null)[]
}

export interface OptionSet {
  readonly options: readonly string[]
  readonly correctIndex: number
  readonly optionMisconceptions: readonly (string | null)[]
}

/**
 * Reorders a question's options, keeping the answer and the per-option misconceptions attached
 * to the options they belong to.
 *
 * A Fisher–Yates shuffle over the indices, so every arrangement is reachable and the
 * misconception mapping cannot come apart from the option it describes — which is the failure
 * that would matter here, because a misaligned mapping would record the wrong diagnosis about a
 * learner.
 */
export function shuffleOptions(set: OptionSet, seed: string): ShuffledOptions {
  const next = generatorFrom(hashOf(seed))
  const order = set.options.map((_, index) => index)

  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    const held = order[index]
    const other = order[swap]
    if (held === undefined || other === undefined) continue
    order[index] = other
    order[swap] = held
  }

  return {
    options: order.map((from) => set.options[from] ?? ''),
    correctIndex: order.indexOf(set.correctIndex),
    optionMisconceptions: order.map((from) => set.optionMisconceptions[from] ?? null),
  }
}
