import type { ConceptId, MisconceptionId } from '../curriculum/types'

/**
 * The diagnostic item bank.
 *
 * Hand-authored, and deliberately so. The diagnostic decides what the tutor believes about a
 * learner before it knows anything about them, which makes it the worst possible place to
 * depend on a language model being available and in a good mood. Coverage, targeting and
 * scoring are all deterministic; a model is used later, and only where semantic judgement is
 * genuinely required.
 *
 * Most items are scored without a model at all. A multiple choice has a correct index. An
 * output prediction has an expected string. A practical task has tests that either pass or
 * not. Only a free-text explanation needs judging, and only one item is of that kind.
 *
 * Difficulties are author-assigned priors on the same logit scale as learner ability, and are
 * never revised from one learner's answers (ADR-0004).
 */

export type DiagnosticItemKind =
  /** Choose one option. Scored deterministically. */
  | 'choice'
  /** Say what the code prints. Scored deterministically against an expected string. */
  | 'predict-output'
  /** Explain something in a sentence or two. Needs a model to judge. */
  | 'explain'
  /** Write Python. Scored by running the learner's code against tests. */
  | 'code'

interface BaseItem {
  readonly id: string
  readonly conceptId: ConceptId
  /** Author-assigned difficulty, on the ability scale. */
  readonly difficulty: number
  /** Shown above the item: what is being asked. */
  readonly prompt: string
  /** Python to read, where the item involves code. */
  readonly code?: string
}

export interface ChoiceItem extends BaseItem {
  readonly kind: 'choice'
  readonly options: readonly string[]
  readonly correctIndex: number
  /**
   * The misconception a learner choosing each option is probably acting on, or `null` where
   * the option is simply wrong. Same length as `options`.
   */
  readonly optionMisconceptions: readonly (MisconceptionId | null)[]
  /** Shown after answering. */
  readonly explanation: string
}

export interface PredictOutputItem extends BaseItem {
  readonly kind: 'predict-output'
  readonly code: string
  /** Exactly what the program prints, compared after normalising whitespace. */
  readonly expectedOutput: string
  /**
   * Wrong answers seen often enough to be worth recognising, each naming what they show.
   * Nothing is inferred from an unrecognised wrong answer beyond it being wrong.
   */
  readonly knownWrongAnswers: readonly { readonly answer: string; readonly misconception: MisconceptionId }[]
  readonly explanation: string
}

export interface ExplainItem extends BaseItem {
  readonly kind: 'explain'
  /** What a good answer contains. Given to the judge; never shown before answering. */
  readonly expectedPoints: string
}

export interface CodeItem extends BaseItem {
  readonly kind: 'code'
  readonly starterCode: string
  /** Run against the learner's code in the browser. Each raises when behaviour is wrong. */
  readonly tests: readonly { readonly name: string; readonly code: string }[]
  readonly explanation: string
}

export type DiagnosticItem = ChoiceItem | PredictOutputItem | ExplainItem | CodeItem

/**
 * The bank.
 *
 * Ordered easiest first. Around twenty items for a diagnostic that asks ten to twelve, so
 * there is room to choose by concept and difficulty rather than marching through a list.
 */
const ITEMS: readonly DiagnosticItem[] = [
  // ---- fundamentals ------------------------------------------------------
  {
    id: 'exec-order',
    kind: 'predict-output',
    conceptId: 'program-execution',
    difficulty: -1.8,
    prompt: 'What does this program print?',
    code: 'print("first")\nprint("second")',
    expectedOutput: 'first\nsecond',
    knownWrongAnswers: [],
    explanation: 'Statements run top to bottom, so "first" is printed before "second".',
  },
  {
    id: 'print-value',
    kind: 'choice',
    conceptId: 'output-with-print',
    difficulty: -1.6,
    prompt: 'Which line displays the number stored in `count`?',
    // `display(count)` used to sit here and was dropped: it is a NameError in a plain Python
    // program but genuinely works in a notebook, so a learner who had only ever used Jupyter
    // could be marked wrong for knowing something true. `print count` is wrong everywhere, and
    // wrong for a reason worth surfacing — it is the Python 2 form.
    options: ['print("count")', 'print(count)', 'count.print()', 'print count'],
    correctIndex: 1,
    optionMisconceptions: [null, null, null, null],
    explanation:
      '`print(count)` shows the value. Quoting the name prints the word `count` instead, and `print count` is the Python 2 form, which is a syntax error in Python 3.',
  },
  {
    id: 'read-traceback',
    kind: 'choice',
    conceptId: 'errors-and-tracebacks',
    difficulty: -1.1,
    prompt: 'This program stops with an error. What went wrong?',
    code: 'numbers = [1, 2, 3]\nprint(numbers[5])',
    options: [
      'The list has the wrong type',
      'print cannot show a list item',
      'There is no item at position 5',
      'Lists start counting at 1, not 0',
    ],
    correctIndex: 2,
    optionMisconceptions: [null, null, null, null],
    explanation:
      'The list has three items, at positions 0, 1 and 2. Asking for position 5 raises an `IndexError`.',
  },

  // ---- variables and types ------------------------------------------------
  {
    id: 'assign-vs-compare',
    kind: 'choice',
    conceptId: 'variables-and-assignment',
    difficulty: -1.3,
    prompt: 'Which line checks whether `total` is equal to 10?',
    options: ['total = 10', 'total equals 10', 'total := 10', 'total == 10'],
    correctIndex: 3,
    // Only the wrong answer carries a misconception: getting it right demonstrates the absence
    // of the confusion, not its presence.
    optionMisconceptions: ['assign-compares', null, null, null],
    explanation:
      '`==` compares. A single `=` assigns, which would set `total` to 10 instead of checking it.',
  },
  {
    id: 'reassignment',
    kind: 'predict-output',
    conceptId: 'variables-and-assignment',
    difficulty: -1,
    prompt: 'What does this print?',
    code: 'x = 2\ny = x + 1\nx = 10\nprint(y)',
    expectedOutput: '3',
    knownWrongAnswers: [{ answer: '11', misconception: 'variables-hold-expressions' }],
    explanation:
      'y was worked out once, when x was 2, so y is 3. Changing x afterwards does not change y.',
  },
  {
    id: 'division-result',
    kind: 'predict-output',
    conceptId: 'arithmetic-operators',
    difficulty: -0.7,
    prompt: 'What does this print?',
    code: 'print(7 / 2)\nprint(7 // 2)',
    expectedOutput: '3.5\n3',
    knownWrongAnswers: [{ answer: '3\n3', misconception: 'division-operator-confusion' }],
    explanation: '/ gives a float, so 3.5. // rounds down towards negative infinity, giving 3.',
  },

  // ---- expressions and conditionals ---------------------------------------
  /*
   * This item used to ask which of four ways to write `if` was "the clearest", with
   * `if is_ready:` as the answer and `if is_ready == True:` among the distractors.
   *
   * All four options were valid Python and, for a boolean, all four behaved identically —
   * verified by running them. The item measured which convention the author preferred, and
   * marked three-quarters of learners wrong for choosing working code. A diagnostic that
   * lowers an estimate over a style preference is measuring the wrong thing, and the evidence
   * it writes is not recoverable later.
   *
   * Replaced with the fact that actually underlies the concept: a comparison is an expression
   * that produces a value, and that value is a boolean.
   */
  {
    id: 'boolean-value',
    kind: 'choice',
    conceptId: 'booleans',
    difficulty: -0.8,
    prompt: 'What does `warm` hold after this runs?',
    code: 'temperature = 15\nwarm = temperature > 20',
    options: ['True', '15', 'False', 'Nothing — a comparison cannot be stored'],
    correctIndex: 2,
    optionMisconceptions: [null, null, null, null],
    explanation:
      'A comparison is worked out straight away and produces `True` or `False`. 15 is not greater than 20, so `warm` holds `False`.',
  },
  {
    id: 'if-else-once',
    kind: 'predict-output',
    conceptId: 'if-statements',
    difficulty: -0.3,
    prompt: 'What does this print?',
    code: 'score = 5\nif score > 3:\n    print("high")\nelse:\n    print("low")\nprint("done")',
    expectedOutput: 'high\ndone',
    knownWrongAnswers: [{ answer: 'high\nlow\ndone', misconception: 'conditional-is-sequence' }],
    explanation: 'if/else runs exactly one branch. "done" runs afterwards either way.',
  },
  {
    id: 'if-not-loop',
    kind: 'predict-output',
    conceptId: 'if-statements',
    difficulty: 0,
    prompt: 'What does this print?',
    code: 'n = 3\nif n > 0:\n    print(n)\n    n = n - 1\nprint("end")',
    expectedOutput: '3\nend',
    knownWrongAnswers: [{ answer: '3\n2\n1\nend', misconception: 'if-is-loop' }],
    explanation: 'An if runs its body at most once. Repeating would need a loop.',
  },

  // ---- loops ---------------------------------------------------------------
  {
    id: 'range-values',
    kind: 'predict-output',
    conceptId: 'for-loops-and-range',
    difficulty: 0.1,
    prompt: 'What does this print?',
    code: 'for i in range(3):\n    print(i)',
    expectedOutput: '0\n1\n2',
    knownWrongAnswers: [
      { answer: '0\n1\n2\n3', misconception: 'range-endpoint-inclusive' },
      { answer: '1\n2\n3', misconception: 'range-endpoint-inclusive' },
    ],
    explanation: 'range(3) starts at 0 and stops before 3, giving 0, 1 and 2.',
  },
  {
    id: 'accumulator',
    kind: 'predict-output',
    conceptId: 'loop-accumulation',
    difficulty: 0.4,
    prompt: 'What does this print?',
    code: 'total = 0\nfor n in [2, 3, 4]:\n    total = total + n\nprint(total)',
    expectedOutput: '9',
    knownWrongAnswers: [{ answer: '4', misconception: 'accumulator-overwritten' }],
    explanation: 'total keeps its value between passes, so it builds up to 2 + 3 + 4 = 9.',
  },
  {
    id: 'while-termination',
    kind: 'choice',
    conceptId: 'while-loops',
    difficulty: 0.3,
    prompt: 'Why does this loop never finish?',
    code: 'n = 5\nwhile n > 0:\n    print(n)',
    // Shortened from "n is never changed, so the condition stays true", which was by some way
    // the longest option — and picking the longest option is a test-taking habit, not
    // programming knowledge. All four now sit within three characters of each other.
    options: [
      'Nothing in the loop changes n',
      'A while loop always needs a break',
      'print stops n from being updated',
      'The condition should use >= not >',
    ],
    correctIndex: 0,
    optionMisconceptions: [null, null, null, null],
    explanation: 'Nothing inside the loop changes `n`, so `n > 0` is true for ever.',
  },

  // ---- collections ---------------------------------------------------------
  {
    id: 'list-index',
    kind: 'predict-output',
    conceptId: 'indexing-and-slicing',
    difficulty: 0.4,
    prompt: 'What does this print?',
    code: 'names = ["ada", "bob", "cleo"]\nprint(names[1])',
    expectedOutput: 'bob',
    knownWrongAnswers: [{ answer: 'ada', misconception: 'index-starts-at-one' }],
    explanation: 'Positions start at 0, so names[1] is the second item.',
  },
  {
    id: 'list-aliasing',
    kind: 'predict-output',
    conceptId: 'list-mutation-and-aliasing',
    difficulty: 1.1,
    prompt: 'What does this print?',
    code: 'a = [1, 2]\nb = a\nb.append(3)\nprint(a)',
    expectedOutput: '[1, 2, 3]',
    knownWrongAnswers: [{ answer: '[1, 2]', misconception: 'assignment-copies-object' }],
    explanation:
      'b = a copies the reference, not the list, so a and b are the same list. Appending through b shows in a.',
  },

  // ---- functions -----------------------------------------------------------
  {
    id: 'return-vs-print',
    kind: 'choice',
    conceptId: 'return-values',
    difficulty: 0.6,
    prompt: 'What does `result` hold after this runs?',
    code: 'def double(n):\n    print(n * 2)\n\nresult = double(4)',
    options: ['8', 'None', 'The text "8"', 'An error is raised'],
    correctIndex: 1,
    optionMisconceptions: ['print-instead-of-return', null, 'print-instead-of-return', null],
    explanation:
      '`double` prints but never returns, so the call gives back `None`. `print` shows a value; it does not hand one back.',
  },
  {
    id: 'return-exits',
    kind: 'predict-output',
    conceptId: 'return-values',
    difficulty: 0.8,
    prompt: 'What does this print?',
    code: 'def check(n):\n    if n > 0:\n        return "positive"\n    return "not positive"\n\nprint(check(5))',
    expectedOutput: 'positive',
    knownWrongAnswers: [{ answer: 'positive\nnot positive', misconception: 'deferred-return' }],
    explanation: 'return exits the function immediately, so the second return never runs.',
  },
  {
    id: 'explain-scope',
    kind: 'explain',
    conceptId: 'variable-scope',
    difficulty: 1,
    prompt:
      'This raises a NameError on the last line. In your own words, why can the last line not see `total`?',
    code: 'def add_up(numbers):\n    total = 0\n    for n in numbers:\n        total = total + n\n    return total\n\nadd_up([1, 2])\nprint(total)',
    expectedPoints:
      'total is created inside the function and exists only while that call runs; it is local to add_up and is not visible outside it. The value would have to be returned and stored to be used outside.',
  },

  // ---- practical -----------------------------------------------------------
  {
    id: 'code-count-evens',
    kind: 'code',
    conceptId: 'loop-accumulation',
    difficulty: 0.5,
    prompt:
      'Write count_evens so that it returns how many numbers in the list are even. Run it to check, then submit.',
    starterCode:
      'def count_evens(numbers):\n    """Return how many numbers in the list are even."""\n    pass\n',
    tests: [
      { name: 'counts evens in a mixed list', code: 'assert count_evens([1, 2, 3, 4]) == 2' },
      { name: 'returns zero for an empty list', code: 'assert count_evens([]) == 0' },
      { name: 'handles negative numbers', code: 'assert count_evens([-2, -1]) == 1' },
    ],
    explanation:
      'One way: keep a running total, add one for each number where n % 2 == 0, and return the total.',
  },
]

export const DIAGNOSTIC_ITEMS: readonly DiagnosticItem[] = Object.freeze(
  ITEMS.map((item) => Object.freeze(item)),
)

export const DIAGNOSTIC_ITEMS_BY_ID: ReadonlyMap<string, DiagnosticItem> = new Map(
  DIAGNOSTIC_ITEMS.map((item) => [item.id, item]),
)

export function getDiagnosticItem(id: string): DiagnosticItem {
  const item = DIAGNOSTIC_ITEMS_BY_ID.get(id)
  if (item === undefined) throw new Error(`Unknown diagnostic item: ${id}`)
  return item
}

/** Whether this kind of item can be scored without asking a model. */
export function isDeterministic(item: DiagnosticItem): boolean {
  return item.kind !== 'explain'
}
