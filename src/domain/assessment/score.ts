import { getMisconception } from '../curriculum/graph'
import type { MisconceptionId } from '../curriculum/types'
import { normaliseAnswer } from '../diagnostic/score'

/**
 * Marking an answer, and deciding whether it is evidence at all.
 *
 * Two things live here and the separation between them is the point of the file.
 *
 * **Marking** is deterministic wherever it can be. A multiple choice has a correct index; an
 * output prediction has an expected string. Neither needs a model, neither can drift, and
 * neither costs anything. Only a written explanation needs reading.
 *
 * **Whether a verdict counts as evidence** is decided here, in the domain, rather than by
 * whatever produced the verdict. That matters most for the model path: a judge that cannot tell
 * produces no evidence rather than a guess, and the decision to treat "cannot tell" that way is
 * the domain's, not the model's.
 */

/** How an answer came to be marked. Recorded, and shown to the learner. */
export type MarkingSource =
  /** Compared against the item's own answer. No model involved. */
  | 'deterministic'
  /** Read by a language model. A judgement, not a fact. */
  | 'model'

/**
 * What was decided about an answer.
 *
 * `unmarked` is the important one. An answer that could not be marked — the judge was
 * unreachable, refused, or said it could not tell — is kept, shown to the learner as unmarked,
 * and produces no evidence. A safe unmarked result is better than false evidence, and this is
 * the type that makes the difference representable rather than a special case somebody has to
 * remember to handle.
 */
export type Marking =
  | {
      readonly kind: 'marked'
      readonly correct: boolean
      /**
       * True when the answer was right but the reasoning was incomplete.
       *
       * Treated as correct — it is still a success — but attenuated in the same way a hinted
       * success is, because a learner who got there without fully articulating why has
       * demonstrated less than one who did. See ADR-0005.
       */
      readonly partial: boolean
      readonly source: MarkingSource
      readonly misconceptions: readonly MisconceptionId[]
    }
  | {
      readonly kind: 'unmarked'
      /** Why, in words the learner can be shown. */
      readonly reason: string
    }

/** A multiple choice, marked against the shuffled order the learner actually saw. */
export function markChoice(
  answer: string,
  presented: { readonly correctIndex: number; readonly optionMisconceptions: readonly (MisconceptionId | null)[] },
): Marking {
  /*
   * Parsed strictly, not with `parseInt`.
   *
   * `parseInt('1.5', 10)` is 1, and `parseInt('2abc', 10)` is 2 — so a malformed submission was
   * being silently coerced into a choice the learner never made, and then marked. What arrives
   * here has to be digits and nothing else, once surrounding whitespace is dropped. `'01'` and
   * `'2 '` are accepted because they name one option unambiguously; `'1.5'`, `'2abc'`, `'+1'`,
   * `'1e0'` and a non-ASCII digit are not answers, and are marked as unreadable rather than
   * wrong.
   */
  const chosen = /^\d+$/.test(answer.trim()) ? Number(answer.trim()) : Number.NaN

  if (
    !Number.isInteger(chosen) ||
    chosen < 0 ||
    chosen >= presented.optionMisconceptions.length
  ) {
    // Not a wrong answer — a malformed submission. Recording it as incorrect would put
    // evidence against the learner for something they did not do.
    return {
      kind: 'unmarked',
      reason: 'That answer could not be read, so nothing has been recorded for it.',
    }
  }

  const correct = chosen === presented.correctIndex
  const named = presented.optionMisconceptions[chosen] ?? null

  return {
    kind: 'marked',
    correct,
    partial: false,
    source: 'deterministic',
    // A correct answer carries no misconception, whatever the data says. The correct option
    // should have null anyway — asserted by an invariant — but getting it right is never
    // evidence of a confusion, so the guard is here too.
    misconceptions: correct || named === null ? [] : [named],
  }
}

/** An output prediction, marked against the expected string after normalisation. */
export function markPrediction(
  answer: string,
  item: {
    readonly expectedOutput: string
    readonly knownWrongAnswers: readonly {
      readonly answer: string
      readonly misconception: MisconceptionId
    }[]
  },
): Marking {
  const given = normaliseAnswer(answer)

  if (given.length === 0) {
    return { kind: 'unmarked', reason: 'Nothing was written, so nothing has been recorded.' }
  }

  if (given === normaliseAnswer(item.expectedOutput)) {
    return { kind: 'marked', correct: true, partial: false, source: 'deterministic', misconceptions: [] }
  }

  const recognised = item.knownWrongAnswers.find(
    (wrong) => normaliseAnswer(wrong.answer) === given,
  )

  return {
    kind: 'marked',
    correct: false,
    partial: false,
    source: 'deterministic',
    // An unrecognised wrong answer is simply wrong. Guessing at which misconception it shows
    // would be a fabricated diagnosis, and it would be acted on later.
    misconceptions: recognised === undefined ? [] : [recognised.misconception],
  }
}

/**
 * A model's verdict on a written answer, turned into a marking.
 *
 * The model reports one of four verdicts rather than a boolean, and this is where that choice
 * earns itself: `cannot-tell` becomes an unmarked answer instead of a coin flip. A boolean
 * forces a judge with no opinion to invent one, and the invented one becomes evidence.
 *
 * `partially-correct` is treated as a success with the same attenuation a hinted success gets.
 * It is not a third band and it is not a half-mark — the learner got there, and the record says
 * they got there with something missing.
 */
export function markJudgement(judgement: {
  readonly verdict: 'correct' | 'partially-correct' | 'incorrect' | 'cannot-tell'
  readonly misconceptions: readonly MisconceptionId[]
}): Marking {
  if (judgement.verdict === 'cannot-tell') {
    return {
      kind: 'unmarked',
      reason:
        'The tutor could not tell from that answer whether the idea had landed, so nothing has been recorded for it.',
    }
  }

  const correct = judgement.verdict !== 'incorrect'

  return {
    kind: 'marked',
    correct,
    partial: judgement.verdict === 'partially-correct',
    source: 'model',
    // Same rule as the deterministic path: a correct answer is not evidence of a confusion.
    // The strategy's own invariants reject this combination too; this is the second lock.
    misconceptions: correct ? [] : judgement.misconceptions,
  }
}

/**
 * Feedback composed from the item's own data, without a model call.
 *
 * The reasoning is worth stating. Feedback for a wrong multiple choice could be generated, and
 * a generated paragraph would read more warmly. But the item already knows why the right answer
 * is right, and the distractor the learner picked already names the wrong idea it represents.
 * Composing from those gives feedback that is specific, instant, free, and **cannot contradict
 * the marking**, which a separately generated paragraph can and eventually would.
 *
 * Two sources, each doing one job: the catalogue supplies the *belief* — what the chosen answer
 * suggests they think, which the item cannot know — and the item supplies the correction, about
 * the code actually in front of them.
 *
 * The catalogue's `reality` field is deliberately *not* used here, and that is a correction. It
 * is written to be true in general, so stitching it onto a particular question produced
 * sentences about code the learner had never seen (`range(n)` explained under a question about
 * slices), advice with no bearing on the answer given, and — worst — the full answer to a
 * *different* item on the same concept, handed over in the feedback for this one. General truth
 * and specific correction are not interchangeable. It stays as the fallback for an item with no
 * explanation of its own, because something specific is better than nothing.
 *
 * What it deliberately is not: "Incorrect. Try again." Every branch below says what was wrong,
 * or what was right, and what to think about instead.
 */
export function composeFeedback(input: {
  readonly marking: Marking
  /** The item's own explanation of the right answer. */
  readonly explanation: string
  /** Where a model read the answer, its own words. Used in place of a composed paragraph. */
  readonly judgeExplanation?: string | undefined
}): string {
  if (input.marking.kind === 'unmarked') return input.marking.reason

  if (input.judgeExplanation !== undefined && input.judgeExplanation.trim().length > 0) {
    /*
     * The judge read the specific thing they wrote, which composition cannot do — so its words
     * lead. The item's explanation still follows, because a short-response item documents its
     * explanation as shown "whatever the verdict" and it was the one part of the answer nobody
     * could have got wrong: it was authored, reviewed, and is the same every time.
     */
    return input.explanation.length === 0
      ? input.judgeExplanation
      : `${input.judgeExplanation.trim()} ${input.explanation}`
  }

  const parts: string[] = []

  if (input.marking.correct) {
    // Brief. Excessive praise for one question is both hollow and, over a session, tiring.
    parts.push(input.marking.partial ? 'That is broadly right.' : 'That is right.')
    if (input.explanation.length > 0) parts.push(input.explanation)
    return parts.join(' ')
  }

  parts.push('Not quite.')

  const named = input.marking.misconceptions[0]
  if (named !== undefined) {
    // What the chosen answer suggests they believe. The catalogue is the only thing that knows
    // this; the item knows only which option was picked.
    parts.push(`That answer fits the idea that ${lowerFirst(getMisconception(named).belief)}`)
  }

  if (input.explanation.length > 0) {
    // The correction, about the code they just read.
    parts.push(input.explanation)
  } else if (named !== undefined) {
    // No explanation of its own, so the general statement is better than silence.
    parts.push(getMisconception(named).reality)
  }

  return parts.join(' ')
}

function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1)
}
