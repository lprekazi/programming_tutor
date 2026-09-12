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
 * A number of entries are marked `unattributed`. Those are this project's own engineering
 * hypotheses: introductory-Python difficulties the tutor needs to be able to name, whose
 * behaviour has been verified against a real interpreter but which have not been traced to a
 * catalogued source. They are labelled as such rather than given borrowed authority, and the
 * distinction is recorded in the evidence ledger.
 *
 * Every claim in a `reality` field was checked by running it, attributed or not. A catalogue
 * the tutor quotes to a learner is no place for a plausible-sounding falsehood.
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
      'total = total + n reads the previous value before storing the new one, so each pass adds to what is already there.',
    // A running total behaves the same way in a while loop as in a for loop, and a learner
    // holding this belief predicts the last value in either. The omission was caught by the
    // practice bank's invariant that an item may only name a misconception its own concept is
    // related to.
    relatedConcepts: [
      'loop-accumulation',
      'variables-and-assignment',
      'for-loops-and-range',
      'while-loops',
    ],
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
    // Stated generally rather than only as index assignment. Two items in the bank probe this
    // idea and they probe it differently — one assigns to a position, one calls a method and
    // expects the string to have changed — and the belief is quoted to the learner as "that
    // answer fits the idea that …", so it has to fit the answer they actually gave.
    belief:
      'A string can be changed in place, by assigning to one of its positions or by calling a method like upper() on it.',
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

  // ---- fundamentals and errors ---------------------------------------------
  {
    id: 'statements-run-out-of-order',
    title: 'Statements run in the order that seems logical',
    belief:
      'The interpreter looks ahead and runs statements in whatever order makes the program work.',
    reality:
      'Statements run strictly top to bottom. A name has to be given a value on an earlier line than the one that uses it; nothing is reordered to make sense of it.',
    relatedConcepts: ['program-execution', 'tracing-execution'],
    source: { kind: 'unattributed' },
  },
  {
    id: 'error-means-the-last-line',
    title: 'The error is always on the line the message names',
    belief: 'The line named at the bottom of a traceback is the line that needs fixing.',
    reality:
      'The named line is where the program stopped, which is often a consequence of something wrong earlier: a name bound to the wrong value, or a list that ended up shorter than expected. A traceback is a trail to follow, not a verdict.',
    relatedConcepts: ['errors-and-tracebacks', 'debugging-strategies', 'tracing-execution'],
    source: { kind: 'unattributed' },
  },
  {
    id: 'reading-instead-of-checking',
    title: 'A bug is found by reading, not by checking',
    belief: 'Finding a bug means looking at the code until the mistake becomes obvious.',
    reality:
      'What locates a bug is comparing what you believe about a value with what it actually is, by printing it or by narrowing down which line first disagrees with your expectation. Reading harder tends to re-confirm the belief that caused the bug.',
    relatedConcepts: ['debugging-strategies', 'tracing-execution'],
    source: { kind: 'unattributed' },
  },

  // ---- more on names and values --------------------------------------------
  {
    id: 'reserved-word-as-name',
    title: 'Any word can be a variable name',
    belief:
      'Every sequence of letters and digits starting with a letter or an underscore can be used as an identifier.',
    reality:
      'Python keeps a set of words for itself, among them class, for, if, return and lambda. Using one as a name is a SyntaxError, and the message rarely says which word was the problem.',
    relatedConcepts: ['variables-and-assignment'],
    source: { kind: 'progmiscon', id: 'NoReservedWords', url: `${PROGMISCON}/NoReservedWords/` },
  },
  {
    id: 'string-literal-needs-str',
    title: 'A literal is not yet an object',
    belief: 'One needs to call str to instantiate a str object from a string literal.',
    reality:
      'A quoted literal already is a str. Calling a string method on it works directly, and wrapping it in str() returns the same string and adds nothing.',
    relatedConcepts: ['strings', 'type-conversion'],
    source: {
      kind: 'progmiscon',
      id: 'StringLiteralNoObject',
      url: `${PROGMISCON}/StringLiteralNoObject/`,
    },
  },

  // ---- more on expressions -------------------------------------------------
  {
    id: 'no-single-logic-and',
    title: 'A single ampersand is the same as and',
    belief: 'The & operator is only a bitwise AND, so & and and are interchangeable on booleans.',
    reality:
      'On two bools & happens to give the same answer: True & False is False. But & always evaluates both sides and, on ints, does bitwise arithmetic, so 6 & 3 is 2 rather than True. The and operator short-circuits and returns one of its operands, so 3 and 5 is 5.',
    relatedConcepts: ['logical-operators', 'booleans'],
    source: { kind: 'progmiscon', id: 'NoSingleLogicAnd', url: `${PROGMISCON}/NoSingleLogicAnd/` },
  },
  {
    id: 'no-atomic-expression',
    title: 'An expression must have more than one part',
    belief: 'Expressions must consist of more than one piece.',
    reality:
      'A single name or literal is a complete expression. Assigning one name to another is valid and does not need an operator to become so.',
    relatedConcepts: ['arithmetic-operators', 'variables-and-assignment'],
    source: {
      kind: 'progmiscon',
      id: 'NoAtomicExpression',
      url: `${PROGMISCON}/NoAtomicExpression/`,
    },
  },
  {
    id: 'precedence-is-left-to-right',
    title: 'Operators apply left to right',
    belief: 'An expression is worked out strictly from left to right, in the order written.',
    reality:
      '2 + 3 * 4 is 14, not 20: multiplication binds tighter than addition. Comparison binds tighter than and and or, and ** binds tighter than a leading minus, so -2 ** 2 is -4. Brackets are what force an order.',
    relatedConcepts: ['operator-precedence', 'arithmetic-operators', 'logical-operators'],
    source: { kind: 'unattributed' },
  },

  // ---- more on loops -------------------------------------------------------
  {
    id: 'break-leaves-all-loops',
    title: 'break leaves every loop',
    belief: 'A break inside nested loops exits all of them.',
    reality:
      'break leaves only the innermost loop containing it. The outer loop carries on with its next pass.',
    relatedConcepts: ['loop-control', 'nested-loops'],
    source: { kind: 'unattributed' },
  },
  {
    id: 'continue-ends-the-loop',
    title: 'continue stops the loop',
    belief: 'continue ends the loop, in the way break does.',
    reality:
      'continue abandons the rest of the current pass and goes on to the next one. The loop keeps running.',
    relatedConcepts: ['loop-control'],
    source: { kind: 'unattributed' },
  },
  {
    id: 'inner-loop-runs-once',
    title: 'The inner loop runs once overall',
    belief: 'In nested loops the inner loop runs through once, not once per pass of the outer one.',
    reality:
      'The inner loop restarts from the beginning on every pass of the outer loop, so its body runs the outer count times the inner count in total.',
    relatedConcepts: ['nested-loops', 'for-loops-and-range'],
    source: { kind: 'unattributed' },
  },

  // ---- more on functions ---------------------------------------------------
  {
    id: 'return-call',
    title: 'return needs brackets',
    belief: 'Return statements need brackets around the return value.',
    reality:
      'return is a statement, not a call. Returning an expression directly is fine, and brackets around the value are only grouping and do nothing.',
    relatedConcepts: ['return-values', 'defining-functions'],
    source: { kind: 'progmiscon', id: 'ReturnCall', url: `${PROGMISCON}/ReturnCall/` },
  },
  {
    id: 'parentheses-only-if-argument',
    title: 'Brackets are optional when there are no arguments',
    belief: 'Brackets are optional for function calls without arguments.',
    reality:
      'The brackets are what makes it a call. Without them the name refers to the function itself, and printing it shows something like <function f at 0x…>; with them it runs and gives its result.',
    relatedConcepts: ['parameters-and-arguments', 'defining-functions'],
    source: {
      kind: 'progmiscon',
      id: 'ParenthesesOnlyIfArgument',
      url: `${PROGMISCON}/ParenthesesOnlyIfArgument/`,
    },
  },
  {
    id: 'outside-in-function-nesting',
    title: 'Nested calls run outside in',
    belief: 'Nested function calls are invoked outside in.',
    reality:
      'The inner call runs first, because its result is what the outer call is given. In outer(inner()), inner finishes before outer starts.',
    relatedConcepts: ['parameters-and-arguments', 'return-values'],
    source: {
      kind: 'progmiscon',
      id: 'OutsideInFunctionNesting',
      url: `${PROGMISCON}/OutsideInFunctionNesting/`,
    },
  },
  {
    id: 'local-name-visible-outside',
    title: 'A name made in a function is visible afterwards',
    belief:
      'A variable assigned inside a function can be used after the call, because the line assigning it has run.',
    reality:
      'Names assigned in a function belong to that call and are gone when it returns. Using one outside raises NameError; to get the value out, return it.',
    relatedConcepts: ['variable-scope', 'return-values', 'defining-functions'],
    source: { kind: 'unattributed' },
  },

  // ---- more on collections -------------------------------------------------
  {
    id: 'dict-is-ordered-by-key',
    title: 'A dictionary sorts itself by key',
    belief: 'A dictionary keeps its keys in sorted order.',
    reality:
      'A dict keeps the order the keys were first inserted. It is not sorted, and reading it back gives insertion order; sorted() is what gives sorted order.',
    relatedConcepts: ['dictionaries', 'iterating-collections'],
    source: { kind: 'unattributed' },
  },
  {
    id: 'iterating-gives-positions',
    title: 'Looping over a collection gives positions',
    belief:
      'A for loop over a list binds the name to each position, so indexing the list with it reaches the item.',
    reality:
      'A for loop over a list binds the name to each item. Positions come from range(len(items)) or from enumerate(items); indexing a list with one of its own items reaches a different item, or raises IndexError, or fails outright if the item is not a number.',
    relatedConcepts: ['iterating-collections', 'lists', 'indexing-and-slicing'],
    source: { kind: 'unattributed' },
  },

  // ---- objects and classes -------------------------------------------------
  {
    id: 'init-creates',
    title: 'The initialiser creates the object',
    belief: 'The __init__ method must create a new object.',
    reality:
      'The object already exists by the time __init__ runs. Evaluating the class expression creates it; __init__ is then handed it as self and sets its attributes up.',
    relatedConcepts: ['classes-and-objects', 'methods-and-attributes'],
    source: { kind: 'progmiscon', id: 'InitCreates', url: `${PROGMISCON}/InitCreates/` },
  },
  {
    id: 'init-returns-object',
    title: 'The initialiser returns the object',
    belief: 'The __init__ method needs to return an object.',
    reality:
      'It cannot. Returning anything but None from __init__ raises TypeError. The value the call gives back is the object itself, and Python arranges that without __init__ returning it.',
    relatedConcepts: ['classes-and-objects', 'methods-and-attributes', 'return-values'],
    source: {
      kind: 'progmiscon',
      id: 'InitReturnsObject',
      url: `${PROGMISCON}/InitReturnsObject/`,
    },
  },
  {
    id: 'no-empty-init',
    title: 'The initialiser has to do something',
    belief: 'The __init__ method must do something, so a class with nothing to set up cannot have one.',
    reality:
      'An __init__ whose body is only pass is valid, and a class with no __init__ at all is valid too. Instances of both can still be created.',
    relatedConcepts: ['classes-and-objects'],
    source: { kind: 'progmiscon', id: 'NoEmptyInit', url: `${PROGMISCON}/NoEmptyInit/` },
  },
  {
    id: 'objects-must-be-named',
    title: 'An object needs a variable',
    belief: 'A variable is needed to instantiate an object.',
    reality:
      'An instance is a value like any other. Creating one, reading an attribute from it and discarding it can all happen in a single expression, with no name involved.',
    relatedConcepts: ['classes-and-objects', 'variables-and-assignment'],
    source: {
      kind: 'progmiscon',
      id: 'ObjectsMustBeNamed',
      url: `${PROGMISCON}/ObjectsMustBeNamed/`,
    },
  },
  {
    id: 'self-assignable',
    title: 'Reassigning self changes the object',
    belief: 'Reassigning self changes the object on which a method is called.',
    reality:
      'self is an ordinary local name holding a reference. Rebinding it inside a method points that local name somewhere else and leaves the object the caller holds untouched; assigning to an attribute of self is what changes the object.',
    relatedConcepts: ['methods-and-attributes', 'variable-scope'],
    source: { kind: 'progmiscon', id: 'SelfAssignable', url: `${PROGMISCON}/SelfAssignable/` },
  },
  {
    id: 'self-no-expression',
    title: 'self is special syntax',
    belief: 'The name self is not an expression.',
    reality:
      'It is an ordinary name. It can be returned, passed to a function, compared, or put in a list, like any other value.',
    relatedConcepts: ['methods-and-attributes'],
    source: { kind: 'progmiscon', id: 'SelfNoExpression', url: `${PROGMISCON}/SelfNoExpression/` },
  },
  {
    id: 'cannot-chain-attribute-accesses',
    title: 'Attribute accesses cannot be chained',
    belief: 'Attribute accesses cannot be chained together, so each step needs its own variable.',
    reality:
      'Each access produces a value that the next one applies to, so reading an attribute and then calling a method on it works in one expression. Chaining reads left to right.',
    relatedConcepts: ['methods-and-attributes', 'classes-and-objects'],
    source: {
      kind: 'progmiscon',
      id: 'CannotChainAttributeAccesses',
      url: `${PROGMISCON}/CannotChainAttributeAccesses/`,
    },
  },
]

export const MISCONCEPTIONS: readonly Misconception[] = Object.freeze(
  MISCONCEPTION_LIST.map((misconception) => Object.freeze(misconception)),
)

/** Fast lookup, built once. */
export const MISCONCEPTIONS_BY_ID: ReadonlyMap<MisconceptionId, Misconception> = new Map(
  MISCONCEPTIONS.map((misconception) => [misconception.id, misconception]),
)
