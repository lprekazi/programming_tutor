import type { ConceptId } from '../curriculum/types'
import type { AuthoredExercise } from './types'

/**
 * The authored exercises.
 *
 * Short on purpose. Each is a few minutes' work and a handful of lines, because the difficulty
 * should come from the idea, not from typing. The brief ruled out tasks "whose difficulty comes
 * mainly from typing volume", and a tutoring session is not a coding test.
 *
 * Authored rather than generated wherever the curriculum is covered, for the reason M5 gave for
 * its question bank: an exercise whose checks disagree with its brief produces a false diagnosis
 * about a real person, and these can be checked once, carefully, by running them.
 *
 * Every exercise here is verified in a real Pyodide interpreter by the end-to-end suite
 * (`exercises.spec.ts` → "the authored exercises hold up in a real interpreter"): the reference
 * solution passes every check, the starter code fails at least one, and each signal's witness
 * produces exactly its declared pattern. Nothing about them is taken on trust, including by me.
 *
 * Version recorded with every stored exercise, so a later change to one can be told apart from
 * the attempts made against the earlier wording.
 */
export const EXERCISE_BANK_VERSION = '1'

/** Joins lines, so indentation in the Python below reads as indentation. */
function py(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`
}

const EXERCISES: readonly AuthoredExercise[] = [
  // ---- loops ------------------------------------------------------------------------------
  {
    id: 'x-while-countdown',
    kind: 'write',
    conceptId: 'while-loops',
    prerequisites: ['if-statements'],
    difficulty: 0.1,
    title: 'Counting down',
    brief:
      'Write countdown(n) so it returns a list of the numbers from n down to 1, using a while loop. countdown(3) should give [3, 2, 1], and countdown(0) should give an empty list.',
    starterCode: py(
      'def countdown(n):',
      '    """Return a list counting down from n to 1."""',
      '    result = []',
      '    # your loop goes here',
      '    return result',
    ),
    tests: [
      { name: 'counts down from three', code: 'assert countdown(3) == [3, 2, 1]' },
      { name: 'includes 1, and stops there', code: 'assert countdown(1) == [1]' },
      { name: 'gives an empty list for zero', code: 'assert countdown(0) == []' },
    ],
    referenceSolution: py(
      'def countdown(n):',
      '    result = []',
      '    while n > 0:',
      '        result.append(n)',
      '        n = n - 1',
      '    return result',
    ),
    signals: [],
    hints: [
      'Think about what has to be true for the loop to keep going, and what has to change on each pass so that it eventually stops.',
      'Keep going while n is still above zero. On each pass, put the current value of n into the list, then make n smaller.',
      'In order: loop while n is greater than 0; inside the loop, append n to result, then subtract 1 from n. The return after the loop is already written.',
    ],
  },
  {
    id: 'x-range-evens',
    kind: 'write',
    conceptId: 'for-loops-and-range',
    prerequisites: ['if-statements'],
    difficulty: 0.1,
    title: 'Even numbers up to n',
    brief:
      'Write evens_up_to(n) so it returns a list of the even numbers from 0 up to and including n. evens_up_to(6) should give [0, 2, 4, 6].',
    starterCode: py(
      'def evens_up_to(n):',
      '    """Return the even numbers from 0 up to and including n."""',
      '    pass',
    ),
    tests: [
      { name: 'includes n when n is even', code: 'assert evens_up_to(6) == [0, 2, 4, 6]' },
      { name: 'stops below an odd n', code: 'assert evens_up_to(5) == [0, 2, 4]' },
      { name: 'gives [0] for zero', code: 'assert evens_up_to(0) == [0]' },
    ],
    referenceSolution: py('def evens_up_to(n):', '    return list(range(0, n + 1, 2))'),
    signals: [
      {
        // range(0, n, 2) stops before n, so an even n goes missing — and for an odd n nothing
        // is lost, which is exactly why the middle check still passes.
        misconception: 'range-endpoint-inclusive',
        pattern: ['fail', 'pass', 'fail'],
        // A range that stops at n itself, as if the stop were included.
        codeShows: String.raw`range\(\s*0\s*,\s*n\s*,\s*2\s*\)`,
        witness: py('def evens_up_to(n):', '    return list(range(0, n, 2))'),
        counterexamples: [
          // Hard-coded: the same results, and no belief about range at all.
          py('def evens_up_to(n):', '    return [0, 2, 4]'),
        ],
      },
    ],
    hints: [
      'range can count in steps other than one, and where it stops matters here: think about whether n itself is included.',
      'range(start, stop, step) never includes stop. To include n when n is even, the stop has to be past n.',
      'Start at 0, step by 2, and stop at n + 1, so that n is included when it is even. Turn the range into a list before returning it.',
    ],
  },
  {
    id: 'x-loop-sum-to',
    kind: 'write',
    conceptId: 'loop-accumulation',
    prerequisites: ['for-loops-and-range'],
    difficulty: 0.4,
    title: 'Adding up to n',
    brief:
      'Write total_to(n) so it returns 1 + 2 + ... + n, using a loop. total_to(4) should give 10, and total_to(0) should give 0.',
    starterCode: py(
      'def total_to(n):',
      '    """Return 1 + 2 + ... + n."""',
      '    total = 0',
      '    # add the numbers up here',
      '    return total',
    ),
    tests: [
      { name: 'adds up one to four', code: 'assert total_to(4) == 10' },
      { name: 'includes n itself', code: 'assert total_to(1) == 1' },
      { name: 'gives zero for zero', code: 'assert total_to(0) == 0' },
    ],
    referenceSolution: py(
      'def total_to(n):',
      '    total = 0',
      '    for number in range(1, n + 1):',
      '        total = total + number',
      '    return total',
    ),
    signals: [
      {
        // range(n) gives 0..n-1: the sum is short by n, and total_to(1) comes out as 0.
        misconception: 'range-endpoint-inclusive',
        pattern: ['fail', 'fail', 'pass'],
        // A range whose stop is n itself: range(n), range(0, n) or range(1, n).
        codeShows: String.raw`range\(\s*(?:[01]\s*,\s*)?n\s*\)`,
        counterexamples: [
          // Includes n, but never stores the sum (review finding F-03).
          py(
            'def total_to(n):',
            '    total = 0',
            '    for number in range(1, n + 1):',
            '        total + number',
            '    return total',
          ),
          // Includes n, but multiplies (review finding F-03).
          py(
            'def total_to(n):',
            '    total = 0',
            '    for number in range(1, n + 1):',
            '        total = total * number',
            '    return total',
          ),
        ],
        witness: py(
          'def total_to(n):',
          '    total = 0',
          '    for number in range(n):',
          '        total = total + number',
          '    return total',
        ),
      },
      {
        // Replacing the total each pass keeps only the last number: right for n = 1, wrong above.
        misconception: 'accumulator-overwritten',
        pattern: ['fail', 'pass', 'pass'],
        // Inside the loop, an assignment to total that does not read total.
        codeShows: String.raw`^\s{8,}total\s*=(?!=)(?![^\n]*\btotal\b)`,
        counterexamples: [
          // Accumulates correctly, but returns from inside the loop (review finding F-03).
          py(
            'def total_to(n):',
            '    total = 0',
            '    for number in range(1, n + 1):',
            '        total = total + number',
            '        return total',
            '    return total',
          ),
          // Counts instead of summing (review finding F-03).
          py(
            'def total_to(n):',
            '    total = 0',
            '    for number in range(1, n + 1):',
            '        total += 1',
            '    return total',
          ),
        ],
        witness: py(
          'def total_to(n):',
          '    total = 0',
          '    for number in range(1, n + 1):',
          '        total = number',
          '    return total',
        ),
      },
    ],
    hints: [
      'total starts at 0. Think about what should happen to it each time you meet the next number.',
      'Loop over the numbers 1 to n, and on each pass add the current number to what total already holds, rather than replacing it.',
      'range(1, n + 1) gives 1 up to and including n. Inside the loop, the new total is the old total plus the current number.',
    ],
  },
  {
    id: 'x-average-bug',
    kind: 'fix',
    conceptId: 'loop-accumulation',
    prerequisites: ['for-loops-and-range'],
    difficulty: 0.6,
    title: 'An average that is wrong',
    brief:
      'average(numbers) should return the mean of the list, but it gives the wrong answer for most lists. Work out what total actually holds when the loop finishes, then fix the function.',
    starterCode: py(
      'def average(numbers):',
      '    total = 0',
      '    for number in numbers:',
      '        total = number',
      '    return total / len(numbers)',
    ),
    tests: [
      { name: 'averages 2, 4 and 6', code: 'assert average([2, 4, 6]) == 4' },
      { name: 'one number is its own average', code: 'assert average([5]) == 5' },
      { name: 'handles a result that is not whole', code: 'assert average([1, 2]) == 1.5' },
    ],
    referenceSolution: py(
      'def average(numbers):',
      '    total = 0',
      '    for number in numbers:',
      '        total = total + number',
      '    return total / len(numbers)',
    ),
    signals: [
      {
        // The starter itself: the last number divided by the count. Right only for one item.
        misconception: 'accumulator-overwritten',
        pattern: ['fail', 'pass', 'fail'],
        codeShows: String.raw`^\s{8,}total\s*=(?!=)(?![^\n]*\btotal\b)`,
        counterexamples: [
          // Accumulates correctly, but returns from inside the loop (review finding F-03).
          py(
            'def average(numbers):',
            '    total = 0',
            '    for number in numbers:',
            '        total = total + number',
            '        return total / len(numbers)',
          ),
          // No accumulator at all (review finding F-03).
          py('def average(numbers):', '    return max(numbers) / len(numbers)'),
        ],
        witness: py(
          'def average(numbers):',
          '    total = 0',
          '    for number in numbers:',
          '        total = number',
          '    return total / len(numbers)',
        ),
      },
    ],
    hints: [
      'Add print(total) just before the return and run it on [2, 4, 6]. Is total what you expected?',
      'The line inside the loop replaces total on every pass, so it ends up holding only the last number.',
      'Each pass should add the current number to the total so far: the new total is the old total plus number.',
    ],
  },
  {
    id: 'x-first-negative',
    kind: 'write',
    conceptId: 'loop-control',
    prerequisites: ['for-loops-and-range', 'while-loops'],
    difficulty: 0.5,
    title: 'The first negative number',
    brief:
      'Write first_negative(numbers) so it returns the first negative number in the list, or None if there is none. Stop looking as soon as you find one.',
    starterCode: py(
      'def first_negative(numbers):',
      '    """Return the first negative number, or None if there is none."""',
      '    pass',
    ),
    tests: [
      { name: 'finds the first negative, not a later one', code: 'assert first_negative([3, -1, -5]) == -1' },
      { name: 'gives None when nothing is negative', code: 'assert first_negative([1, 2]) is None' },
      { name: 'gives None for an empty list', code: 'assert first_negative([]) is None' },
    ],
    referenceSolution: py(
      'def first_negative(numbers):',
      '    for number in numbers:',
      '        if number < 0:',
      '            return number',
      '    return None',
    ),
    signals: [],
    hints: [
      'You need to look at the numbers one at a time, and you can finish the whole function the moment you find what you are looking for.',
      'Inside a loop, return leaves the function straight away — which also ends the loop. What should happen if the loop finishes without finding anything?',
      'Loop over the numbers; if one is below zero, return it immediately. After the loop, return None.',
    ],
  },

  // ---- conditionals -----------------------------------------------------------------------
  {
    id: 'x-if-temperature',
    kind: 'write',
    conceptId: 'if-statements',
    prerequisites: ['comparison-operators'],
    difficulty: -0.4,
    title: 'Cold, mild or hot',
    brief:
      'Write describe(temperature) so it returns "cold" below 10, "mild" from 10 up to and including 20, and "hot" above 20.',
    starterCode: py(
      'def describe(temperature):',
      '    """Return "cold", "mild" or "hot"."""',
      '    pass',
    ),
    tests: [
      { name: 'below ten is cold', code: 'assert describe(5) == "cold"' },
      { name: 'ten itself is mild', code: 'assert describe(10) == "mild"' },
      { name: 'twenty is still mild', code: 'assert describe(20) == "mild"' },
      { name: 'above twenty is hot', code: 'assert describe(25) == "hot"' },
    ],
    referenceSolution: py(
      'def describe(temperature):',
      '    if temperature < 10:',
      '        return "cold"',
      '    elif temperature <= 20:',
      '        return "mild"',
      '    else:',
      '        return "hot"',
    ),
    signals: [],
    hints: [
      'There are three outcomes and two boundaries. Decide which side of each boundary 10 and 20 themselves belong on.',
      'Check the cold case first. Once that has been ruled out, you only need one more comparison to tell mild from hot.',
      'Use if for below 10, elif for up to and including 20 (<=), and else for everything left over.',
    ],
  },

  // ---- functions --------------------------------------------------------------------------
  {
    id: 'x-return-not-print',
    kind: 'fix',
    conceptId: 'return-values',
    prerequisites: ['parameters-and-arguments'],
    difficulty: 0.6,
    title: 'Giving back the larger number',
    brief:
      'larger(a, b) is meant to give back the larger of two numbers so the caller can use it. Run it: the last line prints None. Fix larger so it hands the value back.',
    starterCode: py(
      'def larger(a, b):',
      '    if a > b:',
      '        print(a)',
      '    else:',
      '        print(b)',
      '',
      'biggest = larger(3, 7)',
      'print(biggest)',
    ),
    tests: [
      { name: 'gives back a value rather than None', code: 'assert larger(3, 7) is not None' },
      { name: 'gives back the larger value', code: 'assert larger(3, 7) == 7' },
      { name: 'works when the first is larger', code: 'assert larger(9, 2) == 9' },
      { name: 'works when they are equal', code: 'assert larger(4, 4) == 4' },
    ],
    referenceSolution: py(
      'def larger(a, b):',
      '    if a > b:',
      '        return a',
      '    else:',
      '        return b',
      '',
      'biggest = larger(3, 7)',
      'print(biggest)',
    ),
    signals: [
      {
        // Every check fails, including the one that only asks for *something* back — and the code
        // prints. A function that returns nothing without printing fails the same checks, which is
        // why the mention of print is required as well.
        misconception: 'print-instead-of-return',
        pattern: ['fail', 'fail', 'fail', 'fail'],
        // A print inside the function, and no return of a value there. The starter's own
        // print(biggest) at the bottom is at the margin and does not count: the review found that a
        // literal "print(" was always satisfied by it (F-03).
        codeShows: String.raw`^\s{4,}print\(`,
        codeLacks: String.raw`^\s{4,}return\s+\S`,
        counterexamples: [
          // Returns nothing, prints nothing inside: a different mistake (review finding F-03).
          py(
            'def larger(a, b):',
            '    if a > b:',
            '        a',
            '    else:',
            '        b',
            '',
            'biggest = larger(3, 7)',
            'print(biggest)',
          ),
          py('def larger(a, b):', '    result = max(a, b)', '', 'biggest = larger(3, 7)', 'print(biggest)'),
        ],
        witness: py(
          'def larger(a, b):',
          '    if a > b:',
          '        print(a)',
          '    else:',
          '        print(b)',
        ),
      },
    ],
    hints: [
      'print shows a value on the screen. Think about what the caller gets back from larger when it finishes.',
      'A function that never uses return gives back None. The two print calls inside larger are the lines to change.',
      'Replace each print inside larger with return, so the value goes back to whoever called it. Leave the last two lines as they are.',
    ],
  },
  {
    id: 'x-scope-greeting',
    kind: 'fix',
    conceptId: 'variable-scope',
    prerequisites: ['return-values'],
    difficulty: 1.0,
    title: 'A greeting that cannot be seen',
    brief:
      'make_greeting builds a greeting inside the function, but the last line cannot see it and raises NameError. Change the function so it gives the greeting back, and change the bottom so it uses what comes back.',
    starterCode: py(
      'def make_greeting(name):',
      '    greeting = "Hello, " + name',
      '',
      'make_greeting("Ada")',
      'print(greeting)',
    ),
    tests: [
      { name: 'gives back the greeting', code: 'assert make_greeting("Ada") == "Hello, Ada"' },
      { name: 'works for another name', code: 'assert make_greeting("Lin") == "Hello, Lin"' },
    ],
    referenceSolution: py(
      'def make_greeting(name):',
      '    greeting = "Hello, " + name',
      '    return greeting',
      '',
      'greeting = make_greeting("Ada")',
      'print(greeting)',
    ),
    signals: [],
    hints: [
      'A name created inside a function belongs to that call alone. Think about how a value can get from inside the function to the code outside it.',
      'The function has to return the greeting, and the call at the bottom has to store what comes back in a name the last line can use.',
      'Add a return line at the end of the function, then assign the result of make_greeting("Ada") to greeting before printing it.',
    ],
  },

  // ---- collections ------------------------------------------------------------------------
  {
    id: 'x-string-shout',
    kind: 'fix',
    conceptId: 'strings',
    prerequisites: ['variables-and-assignment'],
    difficulty: -0.6,
    title: 'Shouting',
    brief:
      'shout(text) should give back the text in capital letters with an exclamation mark on the end, so shout("hi") is "HI!". Right now it forgets the capitals. Fix it.',
    starterCode: py(
      'def shout(text):',
      '    """Return text in capital letters, followed by "!"."""',
      '    text.upper()',
      '    return text + "!"',
    ),
    tests: [
      { name: 'capitals and an exclamation mark', code: 'assert shout("hi") == "HI!"' },
      { name: 'works for mixed case', code: 'assert shout("Go") == "GO!"' },
      { name: 'an empty string becomes just "!"', code: 'assert shout("") == "!"' },
    ],
    referenceSolution: py(
      'def shout(text):',
      '    return text.upper() + "!"',
    ),
    signals: [
      {
        // upper() is called and its result thrown away, on the belief that it changed text. The
        // empty string has nothing to capitalise, so that check passes either way.
        misconception: 'string-immutability-ignored',
        pattern: ['fail', 'fail', 'pass'],
        // upper() called as a statement of its own, its result discarded.
        codeShows: String.raw`^\s+text\.upper\(\)\s*$`,
        counterexamples: [
          py('def shout(text):', '    return text + "!"'),
          py('def shout(text):', '    return text.lower() + "!"'),
        ],
        witness: py(
          'def shout(text):',
          '    text.upper()',
          '    return text + "!"',
        ),
      },
    ],
    hints: [
      'The line text.upper() does run. Think about where its result goes.',
      'upper() does not change text; it gives back a new string. That new string is never stored or used.',
      'Either store the result, as text = text.upper(), or use text.upper() directly in the return.',
    ],
  },
  {
    id: 'x-list-with-extra',
    kind: 'fix',
    conceptId: 'list-mutation-and-aliasing',
    prerequisites: ['indexing-and-slicing'],
    difficulty: 1.1,
    title: 'Adding without changing the original',
    brief:
      'with_extra(items, extra) should give back a new list with extra on the end, and leave the list it was given unchanged. At the moment it changes the caller’s list too. Fix it.',
    starterCode: py(
      'def with_extra(items, extra):',
      '    """Return a new list: items followed by extra. Do not change items."""',
      '    result = items',
      '    result.append(extra)',
      '    return result',
    ),
    tests: [
      { name: 'adds the extra item on the end', code: 'assert with_extra([1, 2], 3) == [1, 2, 3]' },
      {
        name: 'leaves the original list unchanged',
        code: py('original = [1, 2]', 'with_extra(original, 3)', 'assert original == [1, 2]'),
      },
      { name: 'works on an empty list', code: 'assert with_extra([], "x") == ["x"]' },
    ],
    referenceSolution: py(
      'def with_extra(items, extra):',
      '    result = list(items)',
      '    result.append(extra)',
      '    return result',
    ),
    signals: [
      {
        // Everything the new list should contain is right; only the original has been changed,
        // because result = items made a second name for the same list rather than a copy.
        misconception: 'assignment-copies-object',
        pattern: ['pass', 'fail', 'pass'],
        // A second name made with plain assignment, then appended to.
        codeShows: String.raw`^\s+(\w+)\s*=\s*items\s*$[\s\S]*^\s+\1\.append\(`,
        counterexamples: [
          // Changes the original directly, with no belief about copying (review finding F-03).
          py('def with_extra(items, extra):', '    items += [extra]', '    return items'),
          py('def with_extra(items, extra):', '    items.append(extra)', '    return list(items)'),
        ],
        witness: py(
          'def with_extra(items, extra):',
          '    result = items',
          '    result.append(extra)',
          '    return result',
        ),
      },
    ],
    hints: [
      'After result = items, how many lists are there? Try printing the original list after calling with_extra on it.',
      'Assignment gives the same list a second name; it does not copy it. Appending through either name changes the one list.',
      'Make result a separate list with the same contents first — list(items) does that — and append to the copy.',
    ],
  },
  {
    id: 'x-dict-count',
    kind: 'write',
    conceptId: 'dictionaries',
    prerequisites: ['lists'],
    difficulty: 0.7,
    title: 'Counting words',
    brief:
      'Write count_words(words) so it returns a dictionary mapping each word to how many times it appears. count_words(["a", "b", "a"]) should give {"a": 2, "b": 1}.',
    starterCode: py(
      'def count_words(words):',
      '    """Return a dictionary of word -> number of times it appears."""',
      '    counts = {}',
      '    # count each word here',
      '    return counts',
    ),
    tests: [
      { name: 'counts a repeated word', code: 'assert count_words(["a", "b", "a"]) == {"a": 2, "b": 1}' },
      { name: 'counts a single word once', code: 'assert count_words(["hi"]) == {"hi": 1}' },
      { name: 'gives an empty dictionary for no words', code: 'assert count_words([]) == {}' },
    ],
    referenceSolution: py(
      'def count_words(words):',
      '    counts = {}',
      '    for word in words:',
      '        counts[word] = counts.get(word, 0) + 1',
      '    return counts',
    ),
    signals: [],
    hints: [
      'Go through the words one at a time. For each, think about the two cases: you have seen it before, or you have not.',
      'A word you have not seen yet is not a key in the dictionary, so reading counts[word] would raise KeyError. Handle that case first.',
      'For each word, set its count to one more than its current count, treating a missing word as 0 — counts.get(word, 0) gives exactly that.',
    ],
  },

  // ---- objects ----------------------------------------------------------------------------
  {
    id: 'x-class-counter',
    kind: 'write',
    conceptId: 'classes-and-objects',
    prerequisites: ['problem-decomposition', 'dictionaries'],
    difficulty: 1.5,
    title: 'A counter object',
    brief:
      'Complete the Counter class. A new Counter should have a count of 0, and each call to add() should increase its count by one. Two counters must keep separate counts.',
    starterCode: py(
      'class Counter:',
      '    def __init__(self):',
      '        pass',
      '',
      '    def add(self):',
      '        pass',
    ),
    tests: [
      { name: 'starts at zero', code: py('c = Counter()', 'assert c.count == 0') },
      { name: 'add increases the count', code: py('c = Counter()', 'c.add()', 'c.add()', 'assert c.count == 2') },
      {
        name: 'two counters keep separate counts',
        code: py('a = Counter()', 'b = Counter()', 'a.add()', 'assert (a.count, b.count) == (1, 0)'),
      },
    ],
    referenceSolution: py(
      'class Counter:',
      '    def __init__(self):',
      '        self.count = 0',
      '',
      '    def add(self):',
      '        self.count = self.count + 1',
    ),
    signals: [],
    hints: [
      'Each counter needs to remember its own number. Think about where a value has to live so that it belongs to one particular object.',
      'Set up the starting count in __init__, as an attribute on self. add() then changes that same attribute.',
      'In __init__, give self a count attribute of 0. In add, set self.count to self.count plus one.',
    ],
  },
]

export const AUTHORED_EXERCISES: readonly AuthoredExercise[] = EXERCISES

export const AUTHORED_EXERCISES_BY_ID: ReadonlyMap<string, AuthoredExercise> = new Map(
  EXERCISES.map((exercise) => [exercise.id, exercise]),
)

export function getAuthoredExercise(id: string): AuthoredExercise | null {
  return AUTHORED_EXERCISES_BY_ID.get(id) ?? null
}

export function exercisesFor(conceptId: ConceptId): readonly AuthoredExercise[] {
  return EXERCISES.filter((exercise) => exercise.conceptId === conceptId)
}
