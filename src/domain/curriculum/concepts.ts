import type { Concept, ConceptId } from './types'

/**
 * The concept graph: a CS1 Python curriculum as a prerequisite DAG.
 *
 * Sequencing lives entirely in `prerequisites`. There is no separate ordering, no
 * "week 3", and no linear syllabus — the scheduler decides what is reachable from what
 * the learner has actually demonstrated. That is what lets two learners take genuinely
 * different routes through the same material.
 *
 * `baselineDifficulty` is a declared prior on the same logit scale as learner ability,
 * and is never revised from a learner's answers (ADR-0004).
 *
 * Invariants enforced by `validateCurriculum` and asserted in tests: ids are unique,
 * every prerequisite exists, the graph is acyclic, and every concept is reachable from a
 * concept with no prerequisites.
 */
// Frozen, not merely `readonly`: TypeScript's readonly erases at build time, so without
// this a consumer could rewrite a declared difficulty prior at runtime — the one thing
// ADR-0004 exists to prevent.
const CONCEPT_LIST: readonly Concept[] = [
  // ---- fundamentals ------------------------------------------------------
  {
    id: 'program-execution',
    title: 'How a program runs',
    area: 'fundamentals',
    summary: 'A program is a sequence of statements the computer carries out in order.',
    prerequisites: [],
    baselineDifficulty: -1.8,
  },
  {
    id: 'output-with-print',
    title: 'Showing output',
    area: 'fundamentals',
    summary: 'Using print to make a program show a value.',
    prerequisites: ['program-execution'],
    baselineDifficulty: -1.7,
  },
  {
    id: 'errors-and-tracebacks',
    title: 'Reading errors',
    area: 'fundamentals',
    summary: 'Understanding what Python tells you when something goes wrong.',
    prerequisites: ['output-with-print'],
    baselineDifficulty: -1.2,
  },

  // ---- variables and types -----------------------------------------------
  {
    id: 'variables-and-assignment',
    title: 'Variables and assignment',
    area: 'variables-and-types',
    summary: 'Storing a value under a name so you can use it later.',
    prerequisites: ['program-execution'],
    baselineDifficulty: -1.5,
  },
  {
    id: 'numeric-types',
    title: 'Whole numbers and decimals',
    area: 'variables-and-types',
    summary: 'The difference between integers and floating-point numbers.',
    prerequisites: ['variables-and-assignment'],
    baselineDifficulty: -1.1,
  },
  {
    id: 'strings',
    title: 'Text',
    area: 'variables-and-types',
    summary: 'Working with sequences of characters.',
    prerequisites: ['variables-and-assignment'],
    baselineDifficulty: -1.0,
  },
  {
    id: 'booleans',
    title: 'True and False',
    area: 'variables-and-types',
    summary: 'Values that represent whether something holds.',
    prerequisites: ['variables-and-assignment'],
    baselineDifficulty: -1.0,
  },
  {
    id: 'type-conversion',
    title: 'Converting between types',
    area: 'variables-and-types',
    summary: 'Turning text into numbers and numbers into text.',
    prerequisites: ['numeric-types', 'strings'],
    baselineDifficulty: -0.5,
  },

  // ---- expressions --------------------------------------------------------
  {
    id: 'arithmetic-operators',
    title: 'Arithmetic',
    area: 'expressions',
    summary: 'Calculating with +, -, *, /, // and %.',
    prerequisites: ['numeric-types'],
    baselineDifficulty: -0.9,
  },
  {
    id: 'operator-precedence',
    title: 'Order of operations',
    area: 'expressions',
    summary: 'Which part of an expression is worked out first, and how brackets change it.',
    prerequisites: ['arithmetic-operators'],
    baselineDifficulty: -0.3,
  },
  {
    id: 'comparison-operators',
    title: 'Comparing values',
    area: 'expressions',
    summary: 'Asking whether values are equal, larger or smaller.',
    prerequisites: ['booleans', 'numeric-types'],
    baselineDifficulty: -0.8,
  },
  {
    id: 'logical-operators',
    title: 'Combining conditions',
    area: 'expressions',
    summary: 'Building larger conditions with and, or and not.',
    prerequisites: ['comparison-operators'],
    baselineDifficulty: -0.2,
  },

  // ---- conditionals -------------------------------------------------------
  {
    id: 'if-statements',
    title: 'Making decisions',
    area: 'conditionals',
    summary: 'Running some code only when a condition holds.',
    // A comparison is enough to write a useful if; and/or come in when conditions get
    // combined, which is `nested-conditionals` below.
    prerequisites: ['comparison-operators'],
    baselineDifficulty: -0.4,
  },
  {
    id: 'nested-conditionals',
    title: 'Decisions inside decisions',
    area: 'conditionals',
    summary: 'Choosing between several cases with elif and nested ifs.',
    prerequisites: ['if-statements', 'logical-operators'],
    baselineDifficulty: 0.2,
  },

  // ---- loops --------------------------------------------------------------
  // A counting loop is the gentler of the two: the number of repetitions is visible in the
  // code, whereas a while loop asks the learner to reason about termination. They are
  // therefore siblings rather than a chain, both resting on the idea of a conditional block.
  {
    id: 'for-loops-and-range',
    title: 'Counting loops',
    area: 'loops',
    summary: 'Repeating a fixed number of times with for and range.',
    prerequisites: ['if-statements'],
    baselineDifficulty: 0.0,
  },
  {
    id: 'while-loops',
    title: 'Repeating while something is true',
    area: 'loops',
    summary: 'Repeating a block of code for as long as a condition holds.',
    prerequisites: ['if-statements'],
    baselineDifficulty: 0.1,
  },
  {
    id: 'loop-accumulation',
    title: 'Building up a result',
    area: 'loops',
    summary: 'Using a variable to collect a total or a count across a loop.',
    prerequisites: ['for-loops-and-range'],
    baselineDifficulty: 0.4,
  },
  {
    id: 'loop-control',
    title: 'Leaving a loop early',
    area: 'loops',
    summary: 'Changing the flow of a loop with break and continue.',
    prerequisites: ['for-loops-and-range', 'while-loops'],
    baselineDifficulty: 0.5,
  },
  {
    id: 'nested-loops',
    title: 'Loops inside loops',
    area: 'loops',
    summary: 'Repeating a repetition, and keeping track of both counters.',
    prerequisites: ['loop-accumulation'],
    baselineDifficulty: 0.9,
  },

  // ---- functions ----------------------------------------------------------
  // A function that returns `a + b` needs no conditional; requiring one would put the
  // single most useful structuring tool behind material it does not depend on.
  {
    id: 'defining-functions',
    title: 'Writing your own functions',
    area: 'functions',
    summary: 'Giving a name to a piece of code so it can be reused.',
    prerequisites: ['variables-and-assignment'],
    baselineDifficulty: -0.2,
  },
  {
    id: 'parameters-and-arguments',
    title: 'Passing values in',
    area: 'functions',
    summary: 'Letting a function work on values supplied by the caller.',
    prerequisites: ['defining-functions'],
    baselineDifficulty: 0.4,
  },
  {
    id: 'return-values',
    title: 'Getting a value back',
    area: 'functions',
    summary: 'The difference between a function that returns a value and one that prints.',
    prerequisites: ['parameters-and-arguments'],
    baselineDifficulty: 0.6,
  },
  {
    id: 'variable-scope',
    title: 'Where a variable exists',
    area: 'functions',
    summary: 'Why a variable made inside a function is not visible outside it.',
    prerequisites: ['return-values'],
    baselineDifficulty: 1.0,
  },

  // ---- collections --------------------------------------------------------
  // Making a list and reading an item out of it needs nothing but a variable. Gating it
  // behind conditionals and loops would put `[1, 2, 3]` and `len(...)` weeks away from a
  // learner who could use them on day two.
  {
    id: 'lists',
    title: 'Lists',
    area: 'collections',
    summary: 'Holding many values in one ordered collection.',
    prerequisites: ['variables-and-assignment'],
    baselineDifficulty: -0.6,
  },
  {
    id: 'indexing-and-slicing',
    title: 'Picking items out',
    area: 'collections',
    summary: 'Reaching individual items and ranges of items by position.',
    prerequisites: ['lists', 'strings'],
    baselineDifficulty: 0.5,
  },
  {
    id: 'list-mutation-and-aliasing',
    title: 'Changing lists',
    area: 'collections',
    summary: 'Modifying a list in place, and what happens when two names share one list.',
    prerequisites: ['indexing-and-slicing'],
    baselineDifficulty: 1.1,
  },
  {
    id: 'dictionaries',
    title: 'Dictionaries',
    area: 'collections',
    summary: 'Looking values up by a key rather than by position.',
    prerequisites: ['lists'],
    baselineDifficulty: 0.7,
  },
  // Visiting each item comes before accumulating across them: `for name in names:` is
  // introduced well before running totals, and needs only the loop and the collection.
  {
    id: 'iterating-collections',
    title: 'Going through a collection',
    area: 'collections',
    summary: 'Visiting every item in a list or dictionary in turn.',
    prerequisites: ['lists', 'for-loops-and-range'],
    baselineDifficulty: 0.3,
  },

  // ---- debugging ----------------------------------------------------------
  {
    id: 'tracing-execution',
    title: 'Following code by hand',
    area: 'debugging',
    summary: 'Working out what a program does, line by line, without running it.',
    prerequisites: ['if-statements', 'for-loops-and-range'],
    baselineDifficulty: 0.6,
  },
  {
    id: 'debugging-strategies',
    title: 'Finding a bug',
    area: 'debugging',
    summary: 'Narrowing down where a program stops doing what you expected.',
    prerequisites: ['errors-and-tracebacks', 'tracing-execution'],
    baselineDifficulty: 1.0,
  },

  // ---- decomposition ------------------------------------------------------
  {
    id: 'problem-decomposition',
    title: 'Breaking a problem down',
    area: 'decomposition',
    summary: 'Splitting a task into functions that each do one thing.',
    prerequisites: ['return-values', 'lists'],
    baselineDifficulty: 1.2,
  },

  // ---- object-oriented ----------------------------------------------------
  {
    id: 'classes-and-objects',
    title: 'Classes and objects',
    area: 'object-oriented',
    summary: 'Defining your own kind of value, with its own data.',
    prerequisites: ['problem-decomposition', 'dictionaries'],
    baselineDifficulty: 1.5,
  },
  {
    id: 'methods-and-attributes',
    title: 'Methods and attributes',
    area: 'object-oriented',
    summary: 'Giving objects their own data and their own behaviour.',
    prerequisites: ['classes-and-objects'],
    baselineDifficulty: 1.7,
  },
]

export const CONCEPTS: readonly Concept[] = Object.freeze(
  CONCEPT_LIST.map((concept) => Object.freeze(concept)),
)

/** Fast lookup, built once. */
export const CONCEPTS_BY_ID: ReadonlyMap<ConceptId, Concept> = new Map(
  CONCEPTS.map((concept) => [concept.id, concept]),
)
