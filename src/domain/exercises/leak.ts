/**
 * Whether a piece of text gives away a reference solution.
 *
 * The M2 heuristic `looksLikeASolution` catches a whole function definition with a body. It does
 * not catch the same lines with the `def` left off, or a solution spread across a hint in prose
 * with the code inlined — and a hint that lists every line of the answer is the answer, whatever
 * shape it arrives in.
 *
 * This compares against the actual reference solution for the exercise in hand, which the M2
 * check never had. It counts how many of the solution's substantive lines appear in the text.
 * Most is a leak; one or two is the "small fragment" a third hint is allowed to show.
 *
 * Compared with all whitespace removed and a leading `return` dropped, so `range(1, n+1)` matches
 * `range(1, n + 1)` and a hint that quotes a one-line solution without its `return` is still that
 * solution (M6 review finding F-09). A line reduced to a bare name — `return total` — is not
 * counted, since the name alone appears in ordinary prose.
 *
 * What it does not catch, stated: a solution rewritten with different names or different but
 * equivalent operators (`total += number` for `total = total + number`), or described step
 * by step in words. The first is a paraphrase of the answer and the second is what a final hint
 * is meant to do, so the line is drawn at *copyable code*, which is the thing a learner could
 * paste without having understood anything.
 */

/** Lines that say nothing specific about this solution: headers, docstrings, blank, comments. */
function substantiveLines(code: string): readonly string[] {
  const withoutDocstrings = code.replace(/("""|''')[\s\S]*?\1/g, '')

  return withoutDocstrings
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#'))
    .filter((line) => !/^(def|class)\s/.test(line))
    .map((line) => squash(line.replace(/^return\s+/, '')))
    .filter((line) => !/^(pass|else:|try:|finally:)$/.test(line))
    // A bare name, or something as short, is not specific to anybody's solution.
    .filter((line) => line.length >= 5 && !/^\w+$/.test(line))
}

/** Whitespace removed entirely, so spacing around operators cannot hide a match. */
function squash(text: string): string {
  return text.replace(/\s+/g, '')
}

/** The proportion of substantive lines at which text counts as containing the solution. */
const LEAK_PROPORTION = 0.6

/**
 * Never fewer than this many — so a two-line solution can still be hinted at with one of its lines
 * — unless the whole solution is shorter than that, in which case all of it is the leak.
 */
const MIN_LEAKED_LINES = 2

export function revealsReference(text: string, referenceSolution: string): boolean {
  const lines = substantiveLines(referenceSolution)
  if (lines.length === 0) return false

  const haystack = squash(text)
  const present = lines.filter((line) => haystack.includes(line)).length
  const threshold = Math.min(
    lines.length,
    Math.max(MIN_LEAKED_LINES, Math.ceil(lines.length * LEAK_PROPORTION)),
  )

  return present >= threshold
}
