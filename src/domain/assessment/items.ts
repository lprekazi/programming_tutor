import type { ConceptId, MisconceptionId } from '../curriculum/types'

/**
 * The practice bank: authored questions the tutor asks to check understanding.
 *
 * Separate from the diagnostic bank on purpose. The diagnostic asks the cheapest question that
 * tells it where to start; practice asks the question that tells the learner something. They
 * also must not overlap — a learner who meets the same item twice learns that they have seen it
 * before, not what it was about.
 *
 * **Authored rather than generated, wherever an authored item does the job.** Generation is
 * available (`quiz.generate`, validated through the M2 pipeline) and is used for concepts this
 * bank does not reach. But an item that must genuinely probe a specific misconception is a
 * hard thing to generate reliably, and the cost of getting it wrong is a false diagnosis
 * written into a record about a person. Where an authored item exists it is preferred.
 *
 * Two rules were learned the hard way in the M3 diagnostic audit and are enforced here by
 * tests rather than by care:
 *
 *   - **Every distractor is genuinely wrong**, not merely less idiomatic. Valid Python that
 *     satisfies the question as asked is never a wrong answer. A learner must not receive
 *     negative evidence for writing something that works.
 *   - **Every factual claim was checked by running it.** All forty-one behaviours asserted by
 *     this bank were verified against CPython 3.11 before being written down, including the
 *     ones that are easy to get wrong from memory: `-7 // 2` is `-4`,
 *     `-2 ** 2` is `-4`, and a dict preserves insertion order rather than sorting.
 *
 * Option order is *not* fixed here. It is shuffled per activity when the question is asked
 * (see `shuffle.ts`), so a position pattern cannot exist in what a learner sees and the author
 * does not have to think about it.
 */

export type PracticeItemKind =
  /** Choose one option. Marked deterministically. */
  | 'choice'
  /** Say what the code prints. Marked deterministically against an expected string. */
  | 'predict-output'
  /** Explain something in a sentence or two. Needs a model to read it. */
  | 'short-response'

interface BaseItem {
  readonly id: string
  readonly conceptId: ConceptId
  /**
   * The misconception this item is designed to expose, where it has one.
   *
   * What makes a misconception *probe* rather than a question that happens to touch the
   * concept: the tutor can ask for this item by name when it has reason to think the learner
   * holds this particular wrong idea.
   */
  readonly probes: MisconceptionId | null
  /** Author-assigned difficulty, on the same logit scale as learner ability. Never revised. */
  readonly difficulty: number
  readonly prompt: string
  /** Python to read, where the question involves reading code. */
  readonly code?: string
}

export interface PracticeChoiceItem extends BaseItem {
  readonly kind: 'choice'
  readonly options: readonly string[]
  readonly correctIndex: number
  /**
   * The misconception a learner choosing each option is probably acting on, or null where the
   * option is simply wrong. Same length as `options`.
   *
   * The correct option always carries null: getting it right is not evidence of a confusion.
   */
  readonly optionMisconceptions: readonly (MisconceptionId | null)[]
  /** Why the right answer is right. Shown after answering. */
  readonly explanation: string
}

export interface PracticePredictItem extends BaseItem {
  readonly kind: 'predict-output'
  readonly code: string
  /** Exactly what the program prints, compared after normalising whitespace and commas. */
  readonly expectedOutput: string
  /** Wrong answers seen often enough to be worth recognising, each naming what it shows. */
  readonly knownWrongAnswers: readonly {
    readonly answer: string
    readonly misconception: MisconceptionId
  }[]
  readonly explanation: string
}

export interface PracticeShortItem extends BaseItem {
  readonly kind: 'short-response'
  /** What a good answer contains. Given to the judge; never shown before answering. */
  readonly expectedPoints: string
  /** Shown after answering, whatever the verdict. */
  readonly explanation: string
}

export type PracticeItem = PracticeChoiceItem | PracticePredictItem | PracticeShortItem

const ITEMS: readonly PracticeItem[] = [
  // ---- fundamentals ---------------------------------------------------------
  {
    id: 'p-exec-order',
    kind: 'predict-output',
    conceptId: 'program-execution',
    probes: 'statements-run-out-of-order',
    difficulty: -1.6,
    prompt: 'What does this print?',
    code: 'x = 1\nprint(x)\nx = 2\nprint(x)',
    expectedOutput: '1\n2',
    knownWrongAnswers: [{ answer: '2\n2', misconception: 'statements-run-out-of-order' }],
    explanation:
      'Each print happens when it is reached, using the value x has at that moment. The second assignment cannot reach back and change what the first print already showed.',
  },
  {
    id: 'p-name-before-use',
    kind: 'choice',
    conceptId: 'program-execution',
    probes: 'statements-run-out-of-order',
    difficulty: -1.2,
    prompt: 'What happens when this runs?',
    code: 'print(total)\ntotal = 5',
    options: [
      'It prints 5, because total is given a value in the program',
      'It stops with a NameError on the first line',
      'It prints nothing and stops silently',
      'It prints 0, the default value',
    ],
    correctIndex: 1,
    optionMisconceptions: ['statements-run-out-of-order', null, null, null],
    explanation:
      'Lines run in order. On line 1 the name total has not been given a value yet, so Python raises NameError and stops before line 2 runs.',
  },
  {
    id: 'p-traceback-cause',
    kind: 'choice',
    conceptId: 'errors-and-tracebacks',
    probes: 'error-means-the-last-line',
    difficulty: -0.5,
    prompt: 'The traceback names line 2. Where is the mistake most likely to be?',
    code: 'nums = [1, 2]\nprint(nums[2])',
    options: [
      'Line 2 is where the program stopped; what to reconsider is how many items nums holds',
      'Line 2 is wrong and should be deleted',
      'Line 1 is fine, so the error must be in Python itself',
      'The traceback always names the line that must be changed',
    ],
    correctIndex: 0,
    optionMisconceptions: [null, null, null, 'error-means-the-last-line'],
    explanation:
      'The traceback tells you where execution stopped. Line 2 asks for position 2 of a two-item list, whose valid positions are 0 and 1 — so the thing to reconsider is the list, or the position, not the fact that line 2 exists.',
  },

  // ---- variables and types --------------------------------------------------
  {
    id: 'p-string-concat-int',
    kind: 'choice',
    conceptId: 'type-conversion',
    probes: null,
    difficulty: -0.6,
    prompt: 'What happens when this runs?',
    code: 'print("3" + 4)',
    options: [
      'It prints 34',
      'It prints 7',
      'It raises a TypeError',
      'It prints 3 and then 4 on separate lines',
    ],
    correctIndex: 2,
    optionMisconceptions: [null, null, null, null],
    explanation:
      'Python will not guess whether you meant text or arithmetic. "3" is a str and 4 is an int, and + is not defined between them, so it raises TypeError. int("3") + 4 gives 7; "3" + str(4) gives "34".',
  },
  {
    id: 'p-string-immutable',
    kind: 'choice',
    conceptId: 'strings',
    probes: 'string-immutability-ignored',
    difficulty: 0.2,
    prompt: 'What happens when this runs?',
    code: 's = "cat"\ns[0] = "b"',
    options: [
      'It raises a TypeError',
      's becomes "bat"',
      's becomes "b"',
      'It raises a NameError',
    ],
    correctIndex: 0,
    optionMisconceptions: [null, 'string-immutability-ignored', null, null],
    explanation:
      'Strings cannot be changed in place, so assigning to a position raises TypeError. To get "bat" you build a new string, for instance "b" + s[1:].',
  },
  /*
   * The discriminator is a comparison rather than the letters themselves, and that is the
   * point of the item's shape.
   *
   * It was written as `print(s)` after `s.upper()`, expecting `cat` with `CAT` as the
   * recognised wrong answer — an exact probe of the belief that `upper()` changes the string in
   * place. But an output prediction is compared after normalisation, which folds case, so the
   * marker read `CAT` as `cat` and told a learner who holds precisely this belief that they
   * were right, with positive evidence to match. Options differing only in case hit the same
   * wall from the other side: they are one option to anything that compares them case-blind.
   *
   * Printing the comparison keeps the probe exact and makes the two predictions different
   * strings under any rule: `True` if `s` is untouched, `False` if `upper()` changed it.
   */
  {
    id: 'p-string-method-returns',
    kind: 'predict-output',
    conceptId: 'strings',
    probes: 'string-immutability-ignored',
    difficulty: 0.1,
    prompt: 'What does this print?',
    code: 's = "cat"\ns.upper()\nprint(s == "cat")',
    expectedOutput: 'True',
    knownWrongAnswers: [{ answer: 'False', misconception: 'string-immutability-ignored' }],
    explanation:
      'upper() returns a new string and leaves s alone, and the result was not stored anywhere, so it was thrown away. s is still "cat", so the comparison is True. s = s.upper() is what would change s.',
  },
  {
    id: 'p-bool-of-comparison',
    kind: 'choice',
    conceptId: 'booleans',
    probes: 'map-to-boolean-with-if',
    difficulty: -0.7,
    prompt: 'What is the value of `warm` after this runs?',
    code: 'temperature = 15\nwarm = temperature > 20',
    options: ['True', '15', 'False', 'Nothing — a comparison cannot be stored'],
    correctIndex: 2,
    optionMisconceptions: [null, null, null, 'map-to-boolean-with-if'],
    explanation:
      'A comparison is worked out straight away and produces True or False. 15 is not greater than 20, so warm holds False — no if statement is needed to turn a comparison into a boolean.',
  },

  // ---- expressions ----------------------------------------------------------
  {
    id: 'p-precedence-mult',
    kind: 'predict-output',
    conceptId: 'operator-precedence',
    probes: 'precedence-is-left-to-right',
    difficulty: -0.4,
    prompt: 'What does this print?',
    code: 'print(2 + 3 * 4)',
    expectedOutput: '14',
    knownWrongAnswers: [{ answer: '20', misconception: 'precedence-is-left-to-right' }],
    explanation:
      'Multiplication binds tighter than addition, so 3 * 4 happens first and 2 is added to it. (2 + 3) * 4 is what gives 20.',
  },
  {
    id: 'p-precedence-power',
    kind: 'predict-output',
    conceptId: 'operator-precedence',
    probes: 'precedence-is-left-to-right',
    difficulty: 0.7,
    prompt: 'What does this print?',
    code: 'print(-2 ** 2)',
    expectedOutput: '-4',
    knownWrongAnswers: [{ answer: '4', misconception: 'precedence-is-left-to-right' }],
    explanation:
      '** binds tighter than the leading minus, so this is -(2 ** 2), which is -4. (-2) ** 2 is what gives 4.',
  },
  {
    id: 'p-short-circuit',
    kind: 'predict-output',
    conceptId: 'logical-operators',
    probes: 'no-short-circuit',
    difficulty: 0.6,
    prompt: 'What does this print?',
    code: 'def boom():\n    print("ran")\n    return True\n\nprint(False and boom())',
    expectedOutput: 'False',
    knownWrongAnswers: [{ answer: 'ran\nFalse', misconception: 'no-short-circuit' }],
    explanation:
      'and stops as soon as the answer is settled. The left side is False, so the whole expression is False whatever the right side would give — boom() is never called, so "ran" is never printed.',
  },
  {
    id: 'p-division-kinds',
    kind: 'predict-output',
    conceptId: 'arithmetic-operators',
    probes: 'division-operator-confusion',
    difficulty: -0.3,
    prompt: 'What does this print?',
    code: 'print(10 / 5)\nprint(-7 // 2)',
    expectedOutput: '2.0\n-4',
    knownWrongAnswers: [
      { answer: '2\n-4', misconception: 'division-operator-confusion' },
      { answer: '2.0\n-3', misconception: 'division-operator-confusion' },
    ],
    explanation:
      '/ always gives a float, even when the division is exact, so 10 / 5 is 2.0. // rounds down towards negative infinity rather than towards zero, so -7 // 2 is -4, not -3.',
  },

  // ---- conditionals ---------------------------------------------------------
  {
    id: 'p-elif-one-branch',
    kind: 'predict-output',
    conceptId: 'nested-conditionals',
    probes: 'conditional-is-sequence',
    difficulty: 0.1,
    prompt: 'What does this print?',
    code: 'n = 10\nif n > 5:\n    print("big")\nelif n > 8:\n    print("bigger")\nprint("done")',
    expectedOutput: 'big\ndone',
    knownWrongAnswers: [
      { answer: 'big\nbigger\ndone', misconception: 'conditional-is-sequence' },
    ],
    explanation:
      'An if/elif chain runs at most one branch. The first condition is true, so "big" is printed and the elif is never tested — even though n > 8 is also true.',
  },
  {
    id: 'p-comparison-chain',
    kind: 'choice',
    conceptId: 'comparison-operators',
    probes: null,
    difficulty: 0.4,
    prompt: 'What does `1 < 2 < 3` evaluate to, and why?',
    code: 'print(1 < 2 < 3)',
    options: [
      'True, because Python chains it as (1 < 2) and (2 < 3)',
      'True, because (1 < 2) gives True and True < 3 is also true',
      'It raises a TypeError, because comparisons cannot be chained',
      'False, because only one comparison can be evaluated at a time',
    ],
    correctIndex: 0,
    optionMisconceptions: [null, null, null, null],
    explanation:
      'Python chains comparisons: a < b < c means (a < b) and (b < c), with b evaluated once. It is not left-to-right on the results of earlier comparisons.',
  },

  // ---- loops ----------------------------------------------------------------
  {
    id: 'p-range-two-args',
    kind: 'predict-output',
    conceptId: 'for-loops-and-range',
    probes: 'range-endpoint-inclusive',
    difficulty: 0,
    prompt: 'What does this print?',
    code: 'for i in range(2, 5):\n    print(i)',
    expectedOutput: '2\n3\n4',
    knownWrongAnswers: [
      { answer: '2\n3\n4\n5', misconception: 'range-endpoint-inclusive' },
      { answer: '3\n4\n5', misconception: 'range-endpoint-inclusive' },
    ],
    explanation:
      'range(2, 5) starts at 2 and stops before 5, so it gives 2, 3 and 4 — three values, which is the difference between the two numbers.',
  },
  {
    id: 'p-break-inner-only',
    kind: 'predict-output',
    conceptId: 'loop-control',
    probes: 'break-leaves-all-loops',
    difficulty: 0.9,
    prompt: 'What does this print?',
    code: 'for i in range(2):\n    for j in range(3):\n        if j == 1:\n            break\n        print(i, j)',
    expectedOutput: '0 0\n1 0',
    knownWrongAnswers: [{ answer: '0 0', misconception: 'break-leaves-all-loops' }],
    explanation:
      'break leaves only the loop it is inside. The inner loop stops when j reaches 1, but the outer loop carries on to its next pass and starts the inner loop again.',
  },
  {
    id: 'p-continue-skips',
    kind: 'predict-output',
    conceptId: 'loop-control',
    probes: 'continue-ends-the-loop',
    difficulty: 0.5,
    prompt: 'What does this print?',
    code: 'for i in range(4):\n    if i == 2:\n        continue\n    print(i)',
    expectedOutput: '0\n1\n3',
    knownWrongAnswers: [{ answer: '0\n1', misconception: 'continue-ends-the-loop' }],
    explanation:
      'continue abandons the rest of this pass and goes on to the next one. Only the pass where i is 2 is cut short; the loop itself keeps running and 3 is still printed.',
  },
  {
    id: 'p-nested-count',
    kind: 'predict-output',
    conceptId: 'nested-loops',
    probes: 'inner-loop-runs-once',
    difficulty: 0.8,
    prompt: 'What does this print?',
    code: 'count = 0\nfor i in range(3):\n    for j in range(2):\n        count = count + 1\nprint(count)',
    expectedOutput: '6',
    knownWrongAnswers: [
      { answer: '5', misconception: 'inner-loop-runs-once' },
      { answer: '2', misconception: 'inner-loop-runs-once' },
    ],
    explanation:
      'The inner loop restarts on every pass of the outer one, so its body runs 3 × 2 = 6 times. It does not run through once for the whole program.',
  },
  {
    id: 'p-while-accumulate',
    kind: 'predict-output',
    conceptId: 'while-loops',
    probes: 'accumulator-overwritten',
    difficulty: 0.5,
    prompt: 'What does this print?',
    code: 'n = 3\ntotal = 0\nwhile n > 0:\n    total = total + n\n    n = n - 1\nprint(total)',
    expectedOutput: '6',
    knownWrongAnswers: [{ answer: '1', misconception: 'accumulator-overwritten' }],
    explanation:
      'total keeps its value between passes, so it builds up 3 + 2 + 1 = 6.',
  },

  // ---- functions ------------------------------------------------------------
  {
    id: 'p-default-return-none',
    kind: 'choice',
    conceptId: 'return-values',
    probes: 'print-instead-of-return',
    difficulty: 0.3,
    prompt: 'What does `f()` give back?',
    code: 'def f():\n    x = 1\n\nprint(f())',
    options: ['1', 'It raises an error', 'None', '0'],
    correctIndex: 2,
    optionMisconceptions: ['print-instead-of-return', null, null, null],
    explanation:
      'A function with no return statement gives back None. Computing a value inside it is not the same as handing that value out — return is what does that.',
  },
  {
    id: 'p-nested-call-order',
    kind: 'predict-output',
    conceptId: 'parameters-and-arguments',
    probes: 'outside-in-function-nesting',
    difficulty: 0.6,
    prompt: 'What does this print?',
    code: 'def a(v):\n    print("a", v)\n\ndef b():\n    print("b")\n    return 2\n\na(b())',
    expectedOutput: 'b\na 2',
    knownWrongAnswers: [{ answer: 'a 2\nb', misconception: 'outside-in-function-nesting' }],
    explanation:
      'The inner call runs first, because its result is what the outer call needs. b() finishes and gives back 2, and only then does a start.',
  },
  {
    id: 'p-call-without-parens',
    kind: 'choice',
    conceptId: 'parameters-and-arguments',
    probes: 'parentheses-only-if-argument',
    difficulty: 0.4,
    prompt: 'What does `print(f)` show, given this definition?',
    code: 'def f():\n    return 1\n\nprint(f)',
    options: [
      '1',
      'Something like <function f at 0x…>',
      'It raises a TypeError',
      'An empty line',
    ],
    correctIndex: 1,
    optionMisconceptions: ['parentheses-only-if-argument', null, null, null],
    explanation:
      'The brackets are what makes it a call. Without them, f is the function object itself, and printing it shows a description of it. f() is what runs it and gives 1.',
  },
  {
    id: 'p-scope-local',
    kind: 'choice',
    conceptId: 'variable-scope',
    probes: 'local-name-visible-outside',
    difficulty: 0.8,
    prompt: 'What happens on the last line?',
    code: 'def f():\n    inner = 1\n\nf()\nprint(inner)',
    options: [
      'It prints 1, because the assignment has run',
      'It prints None',
      'It raises a NameError',
      'It prints 0',
    ],
    correctIndex: 2,
    optionMisconceptions: ['local-name-visible-outside', null, null, null],
    explanation:
      'inner belongs to that call of f and is gone when it returns, so the last line raises NameError. To use the value outside, return it and store what comes back.',
  },
  {
    id: 'p-scope-shadow',
    kind: 'predict-output',
    conceptId: 'variable-scope',
    probes: 'local-name-visible-outside',
    difficulty: 1,
    prompt: 'What does this print?',
    code: 'x = 1\n\ndef f():\n    x = 2\n\nf()\nprint(x)',
    expectedOutput: '1',
    knownWrongAnswers: [{ answer: '2', misconception: 'local-name-visible-outside' }],
    explanation:
      'Assigning to x inside f creates a separate local name that happens to share the spelling. The x outside is untouched.',
  },
  {
    id: 'p-explain-return-vs-print',
    kind: 'short-response',
    conceptId: 'return-values',
    probes: 'print-instead-of-return',
    difficulty: 0.7,
    prompt:
      'In your own words: what is the difference between a function printing a value and returning it?',
    code: 'def shout(text):\n    print(text.upper())\n\nresult = shout("hi")',
    expectedPoints:
      'print displays a value for a person to read and gives nothing back to the calling code; return hands the value to the caller so it can be stored or used further. Here shout prints but never returns, so result is None. A good answer distinguishes what the human sees from what the program can use.',
    explanation:
      'print puts a value on the screen; return hands it back to whatever called the function. shout prints and returns nothing, so result is None — the text was shown but never given out.',
  },

  // ---- collections ----------------------------------------------------------
  {
    id: 'p-list-aliasing',
    kind: 'predict-output',
    conceptId: 'list-mutation-and-aliasing',
    probes: 'assignment-copies-object',
    difficulty: 1,
    prompt: 'What does this print?',
    code: 'a = [1]\nb = a\nb.append(2)\nprint(a, b)',
    expectedOutput: '[1, 2] [1, 2]',
    knownWrongAnswers: [{ answer: '[1] [1, 2]', misconception: 'assignment-copies-object' }],
    explanation:
      'b = a copies the reference, not the list, so both names refer to one list. Appending through b is visible through a. list(a) is what makes a separate copy.',
  },
  {
    id: 'p-slice-excludes-end',
    kind: 'predict-output',
    conceptId: 'indexing-and-slicing',
    probes: 'range-endpoint-inclusive',
    difficulty: 0.6,
    prompt: 'What does this print?',
    code: 'print([10, 20, 30, 40][1:3])',
    expectedOutput: '[20, 30]',
    knownWrongAnswers: [
      { answer: '[20, 30, 40]', misconception: 'range-endpoint-inclusive' },
      { answer: '[10, 20, 30]', misconception: 'index-starts-at-one' },
    ],
    explanation:
      'A slice starts at the first position and stops before the second, so [1:3] gives positions 1 and 2 — two items, which is the difference between the numbers.',
  },
  {
    id: 'p-iterate-items',
    kind: 'choice',
    conceptId: 'iterating-collections',
    probes: 'iterating-gives-positions',
    difficulty: 0.5,
    prompt: 'What is `x` on each pass of this loop?',
    code: 'for x in [10, 20, 30]:\n    print(x)',
    options: [
      'Each position in turn: 0, 1, 2',
      'Each item in turn: 10, 20, 30',
      'The whole list each time',
      'The length of the list',
    ],
    correctIndex: 1,
    optionMisconceptions: ['iterating-gives-positions', null, null, null],
    explanation:
      'Looping over a list binds the name to each item, so this prints 10, 20 and 30. If you want positions, use range(len(items)); if you want both, use enumerate(items).',
  },
  {
    id: 'p-dict-order',
    kind: 'predict-output',
    conceptId: 'dictionaries',
    probes: 'dict-is-ordered-by-key',
    difficulty: 0.7,
    prompt: 'What does this print?',
    code: 'd = {"c": 1, "a": 2}\nprint(list(d))',
    expectedOutput: "['c', 'a']",
    knownWrongAnswers: [{ answer: "['a', 'c']", misconception: 'dict-is-ordered-by-key' }],
    explanation:
      'A dict keeps the order its keys were first inserted, not sorted order. sorted(d) is what gives ["a", "c"].',
  },
  {
    id: 'p-dict-missing-key',
    kind: 'choice',
    conceptId: 'dictionaries',
    probes: null,
    difficulty: 0.4,
    prompt: 'What happens when this runs?',
    code: 'd = {"a": 1}\nprint(d["b"])',
    options: [
      'It prints None',
      'It prints 0',
      'It adds "b" with an empty value',
      'It raises a KeyError',
    ],
    correctIndex: 3,
    optionMisconceptions: [null, null, null, null],
    explanation:
      'Reading a key that is not there raises KeyError. d.get("b") gives None instead, and d.get("b", 0) gives a default of your choosing.',
  },

  // ---- objects and classes --------------------------------------------------
  {
    id: 'p-init-returns',
    kind: 'choice',
    conceptId: 'classes-and-objects',
    probes: 'init-returns-object',
    difficulty: 1.2,
    prompt: 'What happens when `P()` runs?',
    code: 'class P:\n    def __init__(self):\n        return 1\n\nP()',
    options: [
      'It raises a TypeError',
      'It gives back 1',
      'It gives back a P, and the 1 is ignored',
      'It raises a NameError',
    ],
    correctIndex: 0,
    optionMisconceptions: [null, 'init-returns-object', null, null],
    explanation:
      '__init__ must return None. Returning anything else raises TypeError. The object is created before __init__ runs, and __init__ is handed it as self to set up — it never returns it.',
  },
  /*
   * A choice, because the belief it probes predicts *an error* rather than a different value,
   * and an error is not something a learner can type as predicted output.
   *
   * As a prediction it recognised one wrong answer, `hi`, attributed to not being able to chain
   * attribute accesses — but a learner who believed that would predict an error, not a
   * lower-case word. Meanwhile the belief the selector picks this item to probe, that an object
   * must be given a name before it can be used, had no answer mapped to it at all, so the item
   * claimed to check something it could not have recorded either way. The printed value is now
   * arithmetic rather than letters, so no two options differ only in case.
   */
  {
    id: 'p-unnamed-instance',
    kind: 'choice',
    conceptId: 'classes-and-objects',
    probes: 'objects-must-be-named',
    difficulty: 1.1,
    prompt: 'What does this print?',
    code: 'class P:\n    def __init__(self):\n        self.count = 2\n\nprint(P().count + 1)',
    options: ['3', 'An error is raised', '2', 'None'],
    correctIndex: 0,
    optionMisconceptions: [null, 'objects-must-be-named', null, null],
    explanation:
      'An instance is a value like any other, so it does not need a name first. P() makes one, .count reads its attribute, and 1 is added to that — all in one expression.',
  },
  {
    id: 'p-self-rebind',
    kind: 'predict-output',
    conceptId: 'methods-and-attributes',
    probes: 'self-assignable',
    difficulty: 1.4,
    prompt: 'What does this print?',
    code: 'class P:\n    def __init__(self):\n        self.n = 1\n    def m(self):\n        self = P()\n        self.n = 99\n\np = P()\np.m()\nprint(p.n)',
    expectedOutput: '1',
    knownWrongAnswers: [{ answer: '99', misconception: 'self-assignable' }],
    explanation:
      'self is an ordinary local name. Rebinding it points that local name at a different object and leaves p alone. Assigning to self.n — an attribute of the object self refers to — is what would change p.',
  },
  {
    id: 'p-explain-self',
    kind: 'short-response',
    conceptId: 'methods-and-attributes',
    probes: 'self-assignable',
    difficulty: 1.3,
    prompt:
      'In your own words: what is `self` inside a method, and where does it come from?',
    code: 'class Counter:\n    def __init__(self):\n        self.n = 0\n    def bump(self):\n        self.n = self.n + 1',
    expectedPoints:
      'self is the object the method was called on. It is passed in automatically as the first argument when you write counter.bump(), so inside the method self refers to that particular instance. Attributes set on self belong to that object and persist after the method returns. A good answer connects the name to the instance the call was made on rather than treating it as a keyword.',
    explanation:
      'self is the object the method was called on, handed in automatically as the first argument. Writing counter.bump() passes counter as self, so self.n reads and writes that object’s own attribute.',
  },
]

export const PRACTICE_ITEMS: readonly PracticeItem[] = Object.freeze(
  ITEMS.map((item) => Object.freeze(item)),
)

export const PRACTICE_ITEMS_BY_ID: ReadonlyMap<string, PracticeItem> = new Map(
  PRACTICE_ITEMS.map((item) => [item.id, item]),
)

export function getPracticeItem(id: string): PracticeItem {
  const item = PRACTICE_ITEMS_BY_ID.get(id)
  if (item === undefined) throw new Error(`Unknown practice item: ${id}`)
  return item
}
/** Items for one concept. */
export function practiceItemsFor(conceptId: ConceptId): readonly PracticeItem[] {
  return PRACTICE_ITEMS.filter((item) => item.conceptId === conceptId)
}

/** Items designed to expose one particular wrong idea. */
export function itemsProbing(misconception: MisconceptionId): readonly PracticeItem[] {
  return PRACTICE_ITEMS.filter((item) => item.probes === misconception)
}
