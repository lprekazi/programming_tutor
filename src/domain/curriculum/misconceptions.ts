import type { Misconception, MisconceptionId } from './types'

/**
 * The closed catalogue of wrong ideas the tutor is allowed to name.
 *
 * When the tutor diagnoses an attempt it must tag from this set. It cannot invent a
 * misconception, because an invented one could not be checked, could not be counted, and
 * could not be revisited later. Anything outside the set is recorded as free text for
 * analysis but never drives learner state.
 *
 * Most entries are taken from progmiscon.org, a curated inventory of programming-language
 * misconceptions published at ITiCSE '21 (doi:10.1145/3430665.3456343) with a Python
 * collection. Each such entry records the inventory's own identifier so the wording here
 * can be checked against the source.
 *
 * A few entries are marked `unattributed`. They are well-known introductory-Python
 * difficulties that the tutor needs to be able to name, but which this project has not
 * yet traced to a specific catalogued source. That gap is recorded in the evidence ledger
 * rather than papered over.
 */

const PROGMISCON = 'https://progmiscon.org/misconceptions/Python'

const MISCONCEPTION_LIST: readonly Misconception[] = [
  // ---- assignment and variables -------------------------------------------
  {
    id: 'assign-compares',
    title: 'Assignment reads as comparison',
    belief: 'The = operator compares two values to see whether they are equal.',
    reality:
      '= assigns the value on its right to the name on its left. Comparison is written ==.',
    relatedConcepts: ['variables-and-assignment', 'comparison-operators', 'if-statements'],
    source: { kind: 'progmiscon', id: 'AssignCompares', url: `${PROGMISCON}/AssignCompares/` },
  },
  {
    id: 'variables-hold-expressions',
    title: 'A variable stores the expression',
    belief: 'Assignment stores the expression itself, so the variable updates when its parts change.',
    reality:
      'Assignment evaluates the expression once and stores the resulting value. The link to the expression is gone.',
    relatedConcepts: ['variables-and-assignment', 'arithmetic-operators'],
    source: {
      kind: 'progmiscon',
      id: 'VariablesHoldExpressions',
      url: `${PROGMISCON}/VariablesHoldExpressions/`,
    },
  },
  {
    id: 'variables-hold-objects',
    title: 'A variable contains the whole object',
    belief: 'A variable contains the object itself rather than a reference to it.',
    reality: 'A variable holds a reference to an object. Two names can refer to one object.',
    relatedConcepts: ['variables-and-assignment', 'lists', 'list-mutation-and-aliasing'],
    source: {
      kind: 'progmiscon',
      id: 'VariablesHoldObjects',
      url: `${PROGMISCON}/VariablesHoldObjects/`,
    },
  },
  {
    id: 'assignment-copies-object',
    title: 'Assignment makes a copy',
    belief: 'Assigning one variable to another copies the object, so the two are independent.',
    reality:
      'Assignment copies the reference, not the object. When the object can be changed in place, such as a list, a change made through one name is visible through the other. Rebinding a name never affects the other name.',
    relatedConcepts: ['list-mutation-and-aliasing', 'variables-and-assignment', 'lists'],
    source: {
      kind: 'progmiscon',
      id: 'AssignmentCopiesObject',
      url: `${PROGMISCON}/AssignmentCopiesObject/`,
    },
  },

  // ---- expressions and booleans -------------------------------------------
  {
    id: 'comparison-with-bool-literal',
    title: 'Comparing to True or False',
    belief: 'To test whether something is true you must compare it to True or to False.',
    reality: 'A boolean expression can be used directly: `if is_ready:` rather than `== True`.',
    relatedConcepts: ['booleans', 'comparison-operators', 'if-statements'],
    source: {
      kind: 'progmiscon',
      id: 'ComparisonWithBoolLiteral',
      url: `${PROGMISCON}/ComparisonWithBoolLiteral/`,
    },
  },
  {
    id: 'map-to-boolean-with-if',
    title: 'Using if to produce a boolean',
    belief: 'Turning a condition into True or False requires an if statement.',
    reality: 'The condition already is a boolean: `is_small = x < 4` needs no if.',
    relatedConcepts: ['booleans', 'if-statements', 'comparison-operators'],
    source: {
      kind: 'progmiscon',
      id: 'MapToBooleanWithIf',
      url: `${PROGMISCON}/MapToBooleanWithIf/`,
    },
  },
  {
    id: 'no-short-circuit',
    title: 'and / or always evaluate both sides',
    belief: 'Both operands of and / or are always evaluated.',
    reality:
      'The right operand is evaluated only when it is needed, which is what makes guards like `x is not None and x.size > 0` safe.',
    relatedConcepts: ['logical-operators', 'if-statements'],
    source: { kind: 'progmiscon', id: 'NoShortCircuit', url: `${PROGMISCON}/NoShortCircuit/` },
  },
  {
    id: 'division-operator-confusion',
    title: 'Confusing / with //',
    belief: 'Dividing two whole numbers gives a whole number.',
    reality:
      '/ gives a float even when the division is exact: 4 / 2 is 2.0. // rounds the result down towards negative infinity, so 7 // 2 is 3 but -7 // 2 is -4.',
    relatedConcepts: ['arithmetic-operators', 'numeric-types', 'type-conversion'],
    source: { kind: 'unattributed' },
  },

  // ---- conditionals --------------------------------------------------------
  {
    id: 'conditional-is-sequence',
    title: 'if/else is the same as two ifs',
    belief: 'An if/else behaves like two separate if statements one after the other.',
    reality:
      'if/else runs exactly one branch and tests the condition once. Two ifs test twice and can run both bodies.',
    relatedConcepts: ['if-statements', 'nested-conditionals'],
    source: {
      kind: 'progmiscon',
      id: 'ConditionalIsSequence',
      url: `${PROGMISCON}/ConditionalIsSequence/`,
    },
  },
  {
    id: 'if-is-loop',
    title: 'An if repeats',
    belief: 'The body of an if statement runs repeatedly while its condition holds.',
    reality: 'An if runs its body at most once. Repetition needs a loop.',
    relatedConcepts: ['if-statements', 'while-loops'],
    source: { kind: 'progmiscon', id: 'IfIsLoop', url: `${PROGMISCON}/IfIsLoop/` },
  },

  // ---- loops ----------------------------------------------------------------
  {
    id: 'range-endpoint-inclusive',
    title: 'range includes its endpoint',
    belief: 'range(n) counts up to and including n.',
    reality:
      'range(n) stops just before n: range(5) gives 0 to 4. When n is zero or negative it produces nothing at all.',
    relatedConcepts: ['for-loops-and-range', 'loop-accumulation', 'indexing-and-slicing'],
    source: { kind: 'unattributed' },
  },
  {
    id: 'accumulator-overwritten',
    title: 'A running total keeps only the last value',
    belief:
      'A variable assigned inside a loop is replaced on every pass, so it ends up holding only the value from the final one.',
    reality:
      'total = total + n reads the previous value before storing the new one, so each pass adds to what is already there. A learner holding this belief predicts the last item rather than the sum.',
    relatedConcepts: ['loop-accumulation', 'variables-and-assignment', 'for-loops-and-range'],
    source: { kind: 'unattributed' },
  },

  // ---- functions ------------------------------------------------------------
  {
    id: 'deferred-return',
    title: 'return does not stop the function',
    belief: 'A return in the middle of a function does not end it; later lines still run.',
    reality: 'return exits the function immediately. Anything after it in that call is skipped.',
    relatedConcepts: ['return-values', 'defining-functions', 'nested-conditionals'],
    source: { kind: 'progmiscon', id: 'DeferredReturn', url: `${PROGMISCON}/DeferredReturn/` },
  },
  {
    id: 'return-unwinds-multiple-frames',
    title: 'One return exits several calls',
    belief: 'A single return can unwind more than one call at once.',
    reality: 'return pops exactly one call and hands control back to its immediate caller.',
    relatedConcepts: ['return-values', 'problem-decomposition', 'tracing-execution'],
    source: {
      kind: 'progmiscon',
      id: 'ReturnUnwindsMultipleFrames',
      url: `${PROGMISCON}/ReturnUnwindsMultipleFrames/`,
    },
  },
  {
    id: 'multiple-values-return',
    title: 'A function returns several values',
    belief: 'A function can return more than one value.',
    reality: 'A function returns one value. `return a, b` returns a single tuple holding both.',
    relatedConcepts: ['return-values', 'variables-and-assignment'],
    source: {
      kind: 'progmiscon',
      id: 'MultipleValuesReturn',
      url: `${PROGMISCON}/MultipleValuesReturn/`,
    },
  },
  {
    id: 'print-instead-of-return',
    title: 'Printing instead of returning',
    belief: 'A function that prints its answer has produced that answer for the caller.',
    reality:
      'print shows a value on screen; it gives nothing back. A caller can only use what is returned.',
    relatedConcepts: ['return-values', 'output-with-print', 'problem-decomposition'],
    source: { kind: 'unattributed' },
  },

  // ---- collections ----------------------------------------------------------
  {
    id: 'string-immutability-ignored',
    title: 'Changing a string in place',
    belief: 'An individual character of a string can be replaced by assigning to its position.',
    reality: 'Strings cannot be changed. Operations on them build a new string.',
    relatedConcepts: ['strings', 'indexing-and-slicing', 'list-mutation-and-aliasing'],
    source: { kind: 'unattributed' },
  },
  {
    id: 'index-starts-at-one',
    title: 'Counting positions from one',
    belief: 'The first item of a sequence is at position 1.',
    reality:
      'Positions start at 0: names[0] is the first item and names[1] is the second. Negative indices count from the end, so names[-1] is the last.',
    relatedConcepts: ['indexing-and-slicing', 'lists', 'strings'],
    source: { kind: 'unattributed' },
  },
]

export const MISCONCEPTIONS: readonly Misconception[] = Object.freeze(
  MISCONCEPTION_LIST.map((misconception) => Object.freeze(misconception)),
)

/** Fast lookup, built once. */
export const MISCONCEPTIONS_BY_ID: ReadonlyMap<MisconceptionId, Misconception> = new Map(
  MISCONCEPTIONS.map((misconception) => [misconception.id, misconception]),
)
