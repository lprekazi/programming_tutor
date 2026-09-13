import { MockProvider, renderPrompt, type MockResponse } from './mock-provider'
import type { TextChunk, TutorProvider } from './provider'

/**
 * Behavioural scenarios for the mock provider.
 *
 * These describe *situations a tutor gets into*, not shapes the code happens to produce: a
 * learner who answers well, one who shows a specific misconception, a model that returns
 * something unusable and then fixes it, a model that refuses, a provider that is down.
 *
 * That distinction matters. A fixture that mirrors the implementation passes for as long as
 * the implementation stays the same and tells you nothing about whether it is right. A
 * fixture that describes a situation keeps its meaning when the implementation changes — and
 * if the change breaks the situation, the test fails, which is the point.
 *
 * Later milestones build learner journeys out of these rather than inventing payloads
 * inline, so the same "learner who confuses range endpoints" is the same learner everywhere.
 */

// ---------------------------------------------------------------------------
// Successful tutoring
// ---------------------------------------------------------------------------

/** A quiz whose distractors map to real misconceptions. */
export const QUIZ_ON_RANGE: MockResponse = {
  kind: 'value',
  value: {
    question: 'What does this print?\n\nfor i in range(3):\n    print(i)',
    options: ['0 1 2', '1 2 3', '0 1 2 3', '3'],
    correctIndex: 0,
    distractorMisconceptions: [null, 'range-endpoint-inclusive', 'range-endpoint-inclusive', null],
    explanation:
      'range(3) produces 0, 1 and 2 — three values, starting at 0 and stopping before 3.',
  },
}

/** A learner who got it right, unaided, with sound reasoning. */
export const ANSWER_CORRECT: MockResponse = {
  kind: 'value',
  value: {
    verdict: 'correct',
    explanation:
      'That is right. range(3) stops before 3, so the loop runs with i as 0, 1 and 2.',
    misconceptions: [],
    nearMiss: false,
  },
}

/** The right conclusion with part of the reasoning unstated. A success, but a weaker one. */
export const ANSWER_PARTIAL: MockResponse = {
  kind: 'value',
  value: {
    verdict: 'partially-correct',
    explanation:
      'You have the right answer. You have not said *why* the loop stops before 3, which is the part worth being able to state.',
    misconceptions: [],
    nearMiss: false,
  },
}

/**
 * A judge that declines.
 *
 * The case a boolean could not express. An answer nobody could grade leaves no record either
 * way, which costs the learner nothing and keeps a guess out of their profile.
 */
export const ANSWER_CANNOT_TELL: MockResponse = {
  kind: 'value',
  value: {
    verdict: 'cannot-tell',
    explanation:
      'There is not enough here for me to tell whether the idea has landed. Say a little more about what the loop does on each pass.',
    misconceptions: [],
    nearMiss: false,
  },
}

/** Declines, and still tries to deposit a diagnosis. Must be refused. */
export const ANSWER_CANNOT_TELL_WITH_TAG: MockResponse = {
  kind: 'value',
  value: {
    verdict: 'cannot-tell',
    explanation: 'I cannot tell.',
    misconceptions: ['range-endpoint-inclusive'],
    nearMiss: false,
  },
}

/** A learner who got it wrong in a way that names a catalogued misconception. */
export const ANSWER_SHOWS_MISCONCEPTION: MockResponse = {
  kind: 'value',
  value: {
    verdict: 'incorrect',
    explanation:
      'Not quite. You have included 3, but range(3) stops just before 3 — it gives you 0, 1 and 2.',
    misconceptions: ['range-endpoint-inclusive'],
    nearMiss: true,
  },
}

/** An attempt the tutor could read, on a concept it was set. */
export const PROFILE_OBSERVATION: MockResponse = {
  kind: 'value',
  value: {
    demonstratedConcepts: ['for-loops-and-range'],
    misconceptions: ['range-endpoint-inclusive'],
    judgement: 'misunderstanding',
    evidence: 'They wrote "0 1 2 3", which includes the endpoint, so they expect range to stop at 3 rather than before it.',
  },
}

/** A hint that points without solving. */
export const HINT_ORIENTING: MockResponse = {
  kind: 'value',
  value: {
    text: 'Try writing out by hand which values i takes. How many times does the loop body run?',
    kind: 'orienting',
  },
}

/** Feedback on code that runs but is wrong. */
export const CODE_FEEDBACK: MockResponse = {
  kind: 'value',
  value: {
    summary: 'It runs, but it counts one item too many.',
    observations: [
      {
        where: 'the range on line 2',
        what: 'range(len(items) + 1) goes one past the last index, so the final pass reads an item that is not there.',
      },
    ],
    nextStep: 'Work out what the largest valid index is for a list of five items, then compare that to what your range produces.',
    misconceptions: ['range-endpoint-inclusive'],
  },
}

/** A generated exercise with a solution and tests that agree with each other. */
export const CODE_TASK: MockResponse = {
  kind: 'value',
  value: {
    conceptId: 'for-loops-and-range',
    title: 'Count the evens',
    brief: 'Write a function count_evens(numbers) that returns how many numbers in the list are even.',
    starterCode: 'def count_evens(numbers):\n    """Return how many numbers in the list are even."""\n    pass\n',
    referenceSolution: 'def count_evens(numbers):\n    total = 0\n    for number in numbers:\n        if number % 2 == 0:\n            total += 1\n    return total\n',
    tests: [
      { name: 'counts evens in a mixed list', code: 'assert count_evens([1, 2, 3, 4]) == 2' },
      { name: 'returns zero for an empty list', code: 'assert count_evens([]) == 0' },
      { name: 'handles negative numbers', code: 'assert count_evens([-2, -1]) == 1' },
    ],
    declaredDifficulty: 'typical',
  },
}

/**
 * A generated exercise on whichever concept was asked for.
 *
 * Derived rather than fixed, for the reason `session.observe` is: a generated exercise has to name
 * the concept it was requested for, and a fixed value is right for exactly one concept. The task
 * itself stays the same small, verifiable one — what matters to the pipeline is that it passes
 * its own checks and its starter does not.
 */
export const CODE_TASK_FOR_REQUESTED_CONCEPT: MockResponse = {
  kind: 'derive',
  from: (prompt) => {
    const requested = /WRITE AN EXERCISE ON: ([a-z-]+)/.exec(prompt)?.[1] ?? 'for-loops-and-range'
    const base = (CODE_TASK as { value: Record<string, unknown> }).value
    return {
      ...base,
      conceptId: requested,
      title: 'Largest in a list',
      brief: 'Write largest(numbers) so it returns the biggest number in a non-empty list, without using max().',
      starterCode: 'def largest(numbers):\n    """Return the biggest number in the list."""\n    pass\n',
      referenceSolution:
        'def largest(numbers):\n    best = numbers[0]\n    for number in numbers:\n        if number > best:\n            best = number\n    return best\n',
      tests: [
        { name: 'finds the biggest in a mixed list', code: 'assert largest([3, 9, 2]) == 9' },
        { name: 'works when the biggest comes first', code: 'assert largest([7, 1]) == 7' },
        { name: 'works with negative numbers', code: 'assert largest([-4, -2, -8]) == -2' },
      ],
    }
  },
}

/**
 * Feedback that agrees with the checks, whatever they decided.
 *
 * The real strategy is told the result and held to it; the mock reads the same `RESULT:` line, so
 * a passing attempt is never told it is wrong by the fixture the end-to-end suite runs against.
 * Deliberately generic — it does not pretend to have read the code.
 */
export const CODE_FEEDBACK_AGREEING: MockResponse = {
  kind: 'derive',
  from: (prompt) =>
    prompt.includes('RESULT: passed')
      ? {
          summary: 'Every check passes.',
          observations: [],
          nextStep: 'Before moving on, predict what your code gives for an input the checks did not try, then run it to see whether you were right.',
          misconceptions: [],
        }
      : {
          summary: 'Some of the checks do not pass yet.',
          observations: [
            {
              where: 'the first check that does not pass',
              what: 'Work out by hand what your code gives back for that input, and compare it with what the check expects.',
            },
          ],
          nextStep: 'Add a print just before the return to see the value you are giving back, then run it again.',
          misconceptions: [],
        },
}

/** A hypothesis about a repeated mistake, with a question that would test it. */
export const DIAGNOSIS: MockResponse = {
  kind: 'value',
  value: {
    likelyBelief: 'They believe range(n) counts up to and including n.',
    candidates: ['range-endpoint-inclusive'],
    checkingQuestion: 'How many numbers does range(4) produce, and what is the last one?',
    strength: 'moderate',
  },
}

// ---------------------------------------------------------------------------
// Things going wrong
// ---------------------------------------------------------------------------

/** Fails the schema: a required field is missing. */
export const INVALID_MISSING_FIELD: MockResponse = {
  kind: 'value',
  value: { verdict: 'correct', misconceptions: [], nearMiss: false },
}

/** Passes the schema, fails an invariant: two options are the same. */
export const INVALID_DUPLICATE_OPTIONS: MockResponse = {
  kind: 'value',
  value: {
    question: 'What does range(3) produce?',
    options: ['0 1 2', '0 1 2', '1 2 3', '3'],
    correctIndex: 0,
    distractorMisconceptions: [null, null, 'range-endpoint-inclusive', null],
    explanation: 'range(3) gives 0, 1 and 2.',
  },
}

/** Names a concept that does not exist. */
export const INVALID_UNKNOWN_CONCEPT: MockResponse = {
  kind: 'value',
  value: {
    demonstratedConcepts: ['quantum-loops'],
    misconceptions: [],
    judgement: 'sound',
    evidence: 'They answered correctly.',
  },
}

/** Names a misconception that does not exist. */
export const INVALID_UNKNOWN_MISCONCEPTION: MockResponse = {
  kind: 'value',
  value: {
    verdict: 'incorrect',
    explanation: 'That is not right.',
    misconceptions: ['forgot-the-semicolons'],
    nearMiss: false,
  },
}

/** A hint that hands over the answer. */
export const INVALID_HINT_REVEALS_SOLUTION: MockResponse = {
  kind: 'value',
  value: {
    text: 'Here you go:\n\ndef count_evens(numbers):\n    total = 0\n    for number in numbers:\n        if number % 2 == 0:\n            total += 1\n    return total',
    kind: 'specific',
  },
}

/** Nothing usable at all. */
export const INVALID_NONSENSE: MockResponse = {
  kind: 'value',
  value: { lorem: 'ipsum', dolor: [1, 2, 3] },
}

/** Text far past the cap, which would break layout and cost money if accepted. */
export const INVALID_OVERSIZED: MockResponse = {
  kind: 'value',
  value: {
    verdict: 'correct',
    explanation: 'x'.repeat(10_000),
    misconceptions: [],
    nearMiss: false,
  },
}

export const REFUSED: MockResponse = {
  kind: 'failure',
  failure: { reason: 'refused', message: 'The tutor declined to answer that one.' },
}

export const UNAVAILABLE: MockResponse = {
  kind: 'failure',
  failure: {
    reason: 'unavailable',
    message: 'The tutor is not reachable at the moment. Your progress is saved.',
    detail: 'connect ETIMEDOUT',
  },
}

export const MISCONFIGURED: MockResponse = {
  kind: 'failure',
  failure: {
    reason: 'misconfigured',
    message: 'The tutor is not configured correctly. Check the application settings.',
  },
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export const EXPLANATION_STREAM: MockResponse = {
  kind: 'text',
  chunks: [
    'Think of range(3) as a countdown that ',
    'stops just before it reaches 3. ',
    'So you get 0, 1 and 2 — three values. ',
    'What would range(1) give you?',
  ],
}

// ---------------------------------------------------------------------------
// Composed scenarios
// ---------------------------------------------------------------------------

/**
 * A provider that fails validation once and then gets it right.
 *
 * Queued responses are consumed in order, so this is exactly what the repair path sees.
 */
export function repairSucceeds(strategy: string, invalid: MockResponse, valid: MockResponse): MockProvider {
  return new MockProvider().on(strategy, invalid).on(strategy, valid)
}

/** A provider that fails validation, and fails again when asked to correct itself. */
export function repairFails(strategy: string, invalid: MockResponse): MockProvider {
  return new MockProvider().on(strategy, invalid).on(strategy, invalid).on(strategy, invalid)
}

/**
 * An opening teaching turn, as a stream.
 *
 * Written to exercise the renderer as well as the transport: it has a paragraph, a fenced code
 * block and a question, and the fence is split across chunks so the parser is seen handling an
 * unclosed one mid-flight, which is what it will do constantly in real use.
 */
export const OPENING_STREAM: MockResponse = {
  kind: 'text',
  chunks: [
    'Here is a loop that adds up three numbers.\n\n',
    '```python\ntotal = 0\n',
    'for n in [2, 3, 4]:\n    total = total + n\n',
    'print(total)\n```\n\n',
    'The name `total` survives from one pass to the next, which is what lets it build up. ',
    'What do you think it prints?',
  ],
}

/** A reply to something the learner asked. Deliberately short, and not a wall of text. */
export const REPLY_STREAM: MockResponse = {
  kind: 'text',
  chunks: [
    'Good question. ',
    'The variable is created before the loop starts, so it is still there on the second pass. ',
    'If you moved `total = 0` inside the loop, what would change?',
  ],
}

/**
 * What the sidecar reports after an ordinary exchange: concepts touched, nothing claimed.
 *
 * The concept is read out of the prompt rather than fixed, because an observation has to name
 * the concept the session is about or it is refused — and which concept that is depends on what
 * the scheduler picked for the learner in front of it. A fixed value was correct for exactly
 * one situation and quietly failed validation everywhere else, which made the accepted path
 * untestable end to end without anybody noticing.
 */
export const SESSION_OBSERVATION: MockResponse = {
  kind: 'derive',
  from: (prompt) => ({
    conceptsDiscussed: [conceptFromPrompt(prompt)],
    misconceptions: [],
    note: 'The learner asked how this works, and the tutor answered.',
  }),
}

/** Reads the `SESSION CONCEPT: <id> — <title>` line the strategy puts in its task block. */
function conceptFromPrompt(prompt: string): string {
  return /SESSION CONCEPT: ([a-z-]+)/.exec(prompt)?.[1] ?? 'program-execution'
}

/** An observation about some other conversation. Must be refused rather than stored. */
export const SESSION_OBSERVATION_WRONG_CONCEPT: MockResponse = {
  kind: 'value',
  value: {
    conceptsDiscussed: ['list-mutation-and-aliasing'],
    misconceptions: [],
    note: 'Not about the concept this session is for.',
  },
}

/**
 * A sidecar that claims the learner has mastered something.
 *
 * The schema is `.strict()` and has no such field, so this is rejected outright rather than
 * having the extra key quietly dropped. Exists to prove that.
 */
export const SESSION_OBSERVATION_CLAIMS_MASTERY: MockResponse = {
  kind: 'value',
  value: {
    conceptsDiscussed: ['program-execution'],
    misconceptions: [],
    note: 'They have got it.',
    mastery: 0.9,
    band: 'secure',
  },
}

/**
 * The same tutor, delivering its chunks at a fixed pace.
 *
 * Exists so that cancelling a stream can be exercised at all: the plain mock resolves on a
 * microtask, which leaves no window in which a learner could press Stop. The pace is on the
 * *server* side, which is where a real stream's pace comes from — the test still waits on the
 * page publishing "the tutor is replying" rather than on a clock of its own.
 */
export function pacedTutor(msPerChunk: number): TutorProvider {
  const inner = workingTutor()

  return {
    structured: (request) => inner.structured(request),
    streamText: (request, signal) => {
      const stream = inner.streamText(request, signal)
      return (async function* paced(): AsyncIterable<TextChunk> {
        for await (const chunk of stream) {
          await new Promise((resolve) => setTimeout(resolve, msPerChunk))
          if (signal?.aborted === true) return
          yield chunk
        }
      })()
    },
  }
}

/**
 * A tutor whose first attempt at any given turn drops, and whose second works.
 *
 * The shape of a transient failure, which is the case the retry control exists for. Counted
 * rather than timed, so it is deterministic.
 *
 * Keyed on the **prompt**, not the strategy. Keying on the strategy made the behaviour depend
 * on how many turns had been taken earlier in the process, so one end-to-end test could leave
 * the counter somewhere that made the next test see a success where it expected a failure.
 * A prompt identifies a turn, which is the thing that should fail once and then work.
 */
export function flakyTutor(): TutorProvider {
  const inner = workingTutor()
  // Bounded for the same reason the mock's call list is: this provider outlives a request now,
  // and the keys are whole prompts. Forty is far more than any test needs.
  const seen = new Set<string>()
  const MAX_KEYS = 40

  return {
    structured: (request) =>
      // Code feedback always fails here: the case where the checks have decided and the notes
      // cannot be written, which must leave the result and the evidence exactly as they were.
      request.strategy === 'code.feedback'
        ? Promise.resolve({
            ok: false,
            failure: { reason: 'refused', message: 'The tutor declined to comment on this code.' },
          })
        : inner.structured(request),
    streamText: (request, signal) => {
      const key = renderPrompt(request.blocks)

      if (!seen.has(key)) {
        if (seen.size >= MAX_KEYS) seen.clear()
        seen.add(key)
        return (async function* drops(): AsyncIterable<TextChunk> {
          await Promise.resolve()
          yield { delta: 'Let me show you ' }
          throw new Error('the connection dropped')
        })()
      }
      return inner.streamText(request, signal)
    },
  }
}

/**
 * A generated question that would fail its own invariants.
 *
 * Two correct-looking options and a misconception on the correct one. Exists to prove that a
 * question this broken is never shown — a broken assessment item is worse than no check.
 */
export const QUIZ_MISCONCEPTION_ON_CORRECT: MockResponse = {
  kind: 'value',
  value: {
    question: 'What does range(3) produce?',
    options: ['0 1 2', '1 2 3', '0 1 2 3', '3'],
    correctIndex: 0,
    distractorMisconceptions: ['range-endpoint-inclusive', null, null, null],
    explanation: 'range(3) gives 0, 1 and 2.',
  },
}

/**
 * A generated question naming a misconception that is not in the catalogue.
 *
 * The failure this guards against is quiet: the question reads perfectly well, and a learner
 * choosing that option would have a diagnosis recorded against them under an id nothing else
 * in the system knows about. It would never be revisited, never probed, and never explained.
 */
export const QUIZ_UNKNOWN_MISCONCEPTION: MockResponse = {
  kind: 'value',
  value: {
    question: 'What does this print?\n\nfor i in range(3):\n    print(i)',
    options: ['0 1 2', '1 2 3', '0 1 2 3', '3'],
    correctIndex: 0,
    distractorMisconceptions: [null, 'counts-from-one-by-default', null, null],
    explanation: 'range(3) gives 0, 1 and 2.',
  },
}

/** A provider wired for an ordinary, successful tutoring exchange. */
export function workingTutor(): MockProvider {
  return new MockProvider()
    .on('converse', REPLY_STREAM)
    .on('explain', OPENING_STREAM)
    .on('session.observe', SESSION_OBSERVATION)
    .on('quiz.generate', QUIZ_ON_RANGE)
    .on('answer.evaluate', ANSWER_CORRECT)
    .on('diagnose', DIAGNOSIS)
    .on('code.task.generate', CODE_TASK_FOR_REQUESTED_CONCEPT)
    .on('code.feedback', CODE_FEEDBACK_AGREEING)
    .on('hint', HINT_ORIENTING)
    .on('profile.update', PROFILE_OBSERVATION)
}
