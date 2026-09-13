import { z } from 'zod'

import { getConcept } from '@/domain/curriculum/graph'
import type { ConceptId } from '@/domain/curriculum/types'
import { revealsReference } from '@/domain/exercises/leak'

import { composePrompt, quoteLearnerText } from '../blocks/compose'
import type { LearnerContext } from '../blocks/learner'
import {
  checkMisconceptionIds,
  checkNoDuplicates,
  checkNoSolution,
  codeText,
  conceptIdSchema,
  looksLikeASolution,
  misconceptionIdSchema,
  proseText,
  shortText,
} from './shared'
import type { InvariantProblem, StructuredStrategy } from './types'

/**
 * Strategies around writing and fixing code.
 *
 * The constraint running through all three: the learner is meant to write the code. Feedback
 * and hints describe, question and point — they do not hand over the answer. That is enforced
 * in the instruction and then checked again afterwards, because an instruction is a request
 * and a check is a guarantee.
 */

// ---------------------------------------------------------------------------
// code.task.generate
// ---------------------------------------------------------------------------

const testCaseSchema = z
  .object({
    /** What this case checks, in words. Shown to the learner when it fails. */
    name: shortText,
    /** Python that raises when the behaviour is wrong. */
    code: codeText,
  })
  .strict()

/**
 * A generated programming exercise.
 *
 * The reference solution and tests exist so the exercise can be verified before a learner
 * ever sees it — the model writes both, and both can be wrong, so they are run against each
 * other first (ADR-0006). They are never part of what the learner is shown.
 */
export const codeTaskSchema = z
  .object({
    /**
     * The concept the model says this exercise is about. Must be the one it was asked for.
     *
     * Only self-consistency: it proves the model *claims* the right concept, not that the task
     * exercises it. Recorded as a limitation rather than dressed up as a semantic check.
     */
    conceptId: conceptIdSchema,
    title: shortText,
    /** What to build, addressed to the learner. */
    brief: proseText,
    /** Signature and docstring for them to fill in. Must not contain the answer. */
    starterCode: codeText,
    referenceSolution: codeText,
    tests: z.array(testCaseSchema).min(2).max(5),
    /**
     * How hard the model judges this to be, on a coarse scale.
     *
     * A declaration, not a measurement, and never revised from one learner's answers
     * (ADR-0004). The caller maps it onto the concept's own difficulty band.
     */
    declaredDifficulty: z.enum(['easier', 'typical', 'harder']),
  })
  .strict()

export type CodeTask = z.infer<typeof codeTaskSchema>

export interface CodeTaskGenerateInput {
  readonly learner: LearnerContext
  readonly conceptId: ConceptId
  /** Briefs already set on this concept, so the model does not repeat one. */
  readonly avoid: readonly string[]
  /**
   * Why the previous attempt was thrown away, for the one regeneration ADR-0006 allows.
   *
   * A sentence written by this application, never text echoed from the rejected candidate —
   * which is model output and would carry whatever it contained forward into the next prompt.
   */
  readonly previousProblem?: string | null | undefined
}

const CODE_TASK_INSTRUCTION = `TASK: write one short Python programming exercise on the given concept.

It should take a few minutes, not an hour. One function, or a very short script.

Provide:
- a brief telling the learner what to build, written to them
- starter code: the signature and a docstring, with the body left for them. The starter must
  not contain the answer, and must not be a working implementation
- a reference solution that genuinely solves it
- between two and five tests, each a snippet of Python that raises when the behaviour is
  wrong. Give each a name describing what it checks. Cover the ordinary case and at least one
  edge — an empty input, a zero, a negative, whichever applies

Use no imports if you can. If you must, use only math, string, collections, itertools,
functools or re — anything else is unavailable and the exercise will be discarded.

Every test must be able to fail: use assert, or raise.

Set conceptId to the concept you were asked to write about.

The tests must pass against your reference solution, and must NOT all pass against your starter
code. Both will be run before the exercise is shown to anyone, and the exercise is discarded if
either is not true.`

export const codeTaskGenerateStrategy: StructuredStrategy<CodeTaskGenerateInput, CodeTask> = {
  kind: 'structured',
  id: 'code.task.generate',
  // v2 (M6): the declared concept, the import allowlist, checks that can fail, and a leak check
  // against the reference solution itself.
  version: '2',
  purpose: 'Write a short programming exercise, with a reference solution and tests to verify it.',
  streams: false,
  schemaName: 'code_task',
  schema: codeTaskSchema,
  buildBlocks(input) {
    const concept = getConcept(input.conceptId)
    const avoid =
      input.avoid.length === 0
        ? ''
        : `\n\nDo not repeat these, which they have already been set:\n${input.avoid.map((brief) => `- ${brief}`).join('\n')}`

    const previous =
      input.previousProblem === null || input.previousProblem === undefined
        ? ''
        : `\n\nAn earlier exercise for this was discarded because ${input.previousProblem} Write a different one that does not have that problem.`

    return composePrompt({
      strategy: CODE_TASK_INSTRUCTION,
      learner: input.learner,
      task: `WRITE AN EXERCISE ON: ${concept.id} — ${concept.title}\n${concept.summary}${avoid}${previous}`,
    })
  },
  checkInvariants(output, input) {
    const problems: InvariantProblem[] = []

    if (output.conceptId !== input.conceptId) {
      problems.push({
        code: 'concept-mismatch',
        detail: `The exercise was requested for ${input.conceptId}, but conceptId says ${output.conceptId}. Write an exercise on the requested concept.`,
      })
    }

    // A test that cannot fail passes against anything, so it verifies nothing and measures
    // nothing. Verification in the browser would not notice: the reference solution passes it.
    output.tests.forEach((test, index) => {
      if (!/\bassert\b|\braise\b/.test(test.code)) {
        problems.push({
          code: 'test-cannot-fail',
          detail: `Test ${String(index)} ("${test.name}") has no assert or raise, so it can never fail.`,
        })
      }
    })

    // Pyodide ships the standard library but not everything in it behaves, and nothing outside it
    // exists. Refused here, before a worker is spent discovering it.
    const imported = [output.referenceSolution, output.starterCode, ...output.tests.map((test) => test.code)]
      .flatMap((code) => [...code.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w]*)/gm)])
      .map((match) => match[1] ?? '')
    const outside = [...new Set(imported.filter((name) => !ALLOWED_IMPORTS.has(name)))]
    if (outside.length > 0) {
      problems.push({
        code: 'imports-outside-allowlist',
        detail: `The exercise imports ${outside.join(', ')}. Use no imports, or only ${[...ALLOWED_IMPORTS].join(', ')}.`,
      })
    }

    // The brief and the starter are shown to the learner verbatim.
    if (
      revealsReference(output.starterCode, output.referenceSolution) ||
      revealsReference(output.brief, output.referenceSolution)
    ) {
      problems.push({
        code: 'reveals-solution',
        detail:
          'The brief or the starter code contains most of the reference solution. Describe the task, and leave the body for the learner.',
      })
    }

    // Starter code containing the implementation defeats the exercise entirely. Checked here
    // rather than left to verification, which only proves the solution passes the tests and
    // would happily pass an exercise that was already solved.
    if (looksImplemented(output.starterCode)) {
      problems.push({
        code: 'starter-contains-solution',
        detail:
          'The starter code appears to contain a working implementation. It should have the signature and docstring only, with the body left for the learner.',
      })
    }

    problems.push(...checkNoDuplicates(output.tests.map((test) => test.name), 'test names'))

    return problems
  },
  // A fabricated exercise would be set to a real learner and its outcome recorded as evidence
  // about them. The fallback is a hand-authored exercise chosen by the caller, not a generic
  // one invented here.
  safeFallback: () => null,
}

/** Modules a generated exercise may import. Everything here is pure and present in Pyodide. */
const ALLOWED_IMPORTS: ReadonlySet<string> = new Set([
  'math',
  'string',
  'collections',
  'itertools',
  'functools',
  're',
])

/**
 * Whether a stub has been filled in.
 *
 * A stub is a signature, a docstring, and a body that does nothing — `pass`, `...`, a
 * `raise NotImplementedError`, or a bare `return`. Anything more substantial than that has
 * started solving the problem.
 */
function looksImplemented(starter: string): boolean {
  // Checked before the docstring is stripped. Stripping first creates a hiding place: a whole
  // solution placed *inside* the docstring is invisible to the body check below and perfectly
  // visible to the learner, who is shown the starter verbatim. Exercise verification would not
  // catch it either — that only proves the reference solution passes its own tests.
  if (looksLikeASolution(starter)) return true

  const withoutStrings = starter.replace(/("""|''')[\s\S]*?\1/g, '')
  const bodyLines = withoutStrings
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .filter((line) => !/^(def|class|@|import|from)\b/.test(line))

  const inert = bodyLines.every((line) =>
    /^(pass|\.\.\.|return(\s+(None|0|''|""|\[\]|\{\}))?|raise NotImplementedError.*)$/.test(line),
  )
  return !inert && bodyLines.length > 0
}

// ---------------------------------------------------------------------------
// code.feedback
// ---------------------------------------------------------------------------

const observationSchema = z
  .object({
    /** Where in their code, described so they can find it. */
    where: shortText,
    /** What is happening there, and why it does not do what they intended. */
    what: proseText,
  })
  .strict()

export const codeFeedbackSchema = z
  .object({
    /** One sentence on how it went overall, addressed to the learner. */
    summary: proseText,
    /** Specific things worth their attention. Empty when the code is simply right. */
    observations: z.array(observationSchema).max(4),
    /** The single next thing to try. Not the answer. */
    nextStep: proseText,
    misconceptions: z.array(misconceptionIdSchema).max(3),
  })
  .strict()

export type CodeFeedback = z.infer<typeof codeFeedbackSchema>

export interface CodeFeedbackInput {
  readonly learner: LearnerContext
  readonly conceptId: ConceptId
  readonly brief: string
  readonly learnerCode: string
  /** What happened when it ran: output, or the error it raised. */
  readonly executionOutput: string
  /** Names of the tests that failed, where the exercise had tests. */
  readonly failedTests: readonly string[]
  /**
   * What the checks decided. **Authoritative**: stated to the model as settled, and enforced
   * afterwards, so feedback cannot tell a learner with passing code that it is wrong or a learner
   * with failing code that it works. Absent only where there were no checks to decide it.
   */
  readonly result?: 'passed' | 'failed' | 'crashed' | undefined
  /**
   * The exercise's reference solution, used only to check the feedback does not reproduce it.
   * Never placed in the prompt: showing a model the answer is the surest way to have it repeated.
   */
  readonly referenceSolution?: string | null | undefined
}

const CODE_FEEDBACK_INSTRUCTION = `TASK: give feedback on the code this learner has written.

Start from what actually happened when it ran. If it raised, explain what the error means in
terms of their code — not a definition of the exception.

Point at specific places. "Line 3 adds to total before total exists" is useful; "there is a
bug in your loop" is not.

Say what is working as well as what is not, where there is something real to say. Do not
invent praise.

The checks have already run, and their result is stated below as RESULT. It is settled. Do not
contradict it: if the checks passed, the code works — you may suggest something clearer or
simpler, but never say it is wrong. If they failed or it crashed, do not say it works.

Then give one next step: the single thing to try next. Describe it, or ask the question that
would lead them to it. Do not write the corrected code, do not write the function, and do not
give them something that only needs pasting. A short fragment illustrating a technique is
fine; their solution is not.

Address them as "you".`

export const codeFeedbackStrategy: StructuredStrategy<CodeFeedbackInput, CodeFeedback> = {
  kind: 'structured',
  id: 'code.feedback',
  // v2 (M6): the deterministic result is authoritative and enforced, and nothing may reproduce
  // the reference solution.
  version: '2',
  purpose: 'Explain what a learner’s code does and what to try next, without writing it for them.',
  streams: false,
  schemaName: 'code_feedback',
  schema: codeFeedbackSchema,
  buildBlocks(input) {
    const concept = getConcept(input.conceptId)
    const failures =
      input.failedTests.length === 0
        ? 'All tests passed.'
        : `Failing tests: ${input.failedTests.join(', ')}`
    // A fixed, machine-readable line, so the result the model is held to is unambiguous.
    const result = input.result === undefined ? '' : `RESULT: ${input.result}\n`

    return composePrompt({
      strategy: CODE_FEEDBACK_INSTRUCTION,
      learner: input.learner,
      task: `CONCEPT: ${concept.id} — ${concept.title}\n\nTHE TASK THEY WERE SET\n${input.brief}\n\n${quoteLearnerText('THEIR CODE', input.learnerCode)}\n\n${quoteLearnerText('WHAT HAPPENED WHEN IT RAN', input.executionOutput)}\n\n${result}${failures}`,
    })
  },
  checkInvariants(output, input, context) {
    const prose = [output.summary, output.nextStep, ...output.observations.map((observation) => observation.what)]
    const reference = input.referenceSolution ?? null

    return [
      ...contradictions(output, input.result),
      ...(reference !== null && prose.some((text) => revealsReference(text, reference))
        ? [
            {
              code: 'reveals-solution',
              detail:
                'The feedback reproduces most of the reference solution. Describe what to change, or show a short fragment, without writing their code for them.',
            },
          ]
        : []),
      // Every prose field, not just the next step. The learner is shown all of them while
      // mid-task, so "put the fix in the observation rather than the next step" would
      // otherwise hand over the implementation through a field nobody was checking.
      ...checkNoSolution(output.summary, 'summary'),
      ...checkNoSolution(output.nextStep, 'nextStep'),
      ...output.observations.flatMap((observation, index) =>
        checkNoSolution(observation.what, `observations[${String(index)}].what`),
      ),
      ...checkMisconceptionIds(output.misconceptions, context, 'misconceptions'),
      ...checkNoDuplicates(output.misconceptions, 'misconceptions'),
    ]
  },
  // Feedback that invented what their code does would be worse than none, and a learner
  // would act on it.
  safeFallback: () => null,
}

/**
 * Feedback that disagrees with what the checks decided.
 *
 * Two layers, and neither is sufficient alone. The rendering keeps the verdict and the notes
 * apart — the heading comes from the checks, never from the model — so a contradiction can at
 * worst sit beneath a correct heading. And these lexical checks refuse the plainest forms of
 * contradiction, so it usually does not get that far.
 *
 * Deliberately narrow phrases. A broad pattern like "fails" would refuse perfectly good feedback
 * ("this is the case that fails for most people") and spend the one repair attempt on nothing.
 * What remains possible — a contradiction in words these do not list — is recorded as a limitation.
 */
function contradictions(output: CodeFeedback, result: CodeFeedbackInput['result']): InvariantProblem[] {
  // Every field the learner reads, including the next step (M6 review finding F-10).
  const prose = [output.summary, output.nextStep, ...output.observations.map((observation) => observation.what)].join('\n')
  const problems: InvariantProblem[] = []

  if (result === 'passed') {
    if (output.misconceptions.length > 0) {
      problems.push({
        code: 'misconception-on-passing-code',
        detail: 'Every check passed, so the code is not evidence of a misconception. Report none.',
      })
    }
    if (/\b(does not work|doesn't work|(?:is|are) (?:wrong|incorrect|broken|buggy)|not (?:correct|right)|has a bug|contains a bug|(?:returns|gives|produces) the wrong|fails? (?:the|these|some|all) (?:checks|tests))\b/i.test(prose)) {
      problems.push({
        code: 'contradicts-result',
        detail: 'Every check passed. The feedback must not say the code is wrong or fails; suggest improvements instead.',
      })
    }
  }

  if (result === 'failed' || result === 'crashed') {
    if (/\b(all (?:the )?(?:checks|tests) pass|works (?:perfectly|correctly|now)|(?:is|looks) (?:correct|right)|correct solution|solved it|nicely done|well done)\b/i.test(prose)) {
      problems.push({
        code: 'contradicts-result',
        detail: 'The checks did not all pass. The feedback must not say the code works or is correct.',
      })
    }
  }

  return problems
}

// ---------------------------------------------------------------------------
// hint
// ---------------------------------------------------------------------------

/** Hints are a bounded ladder, not an endless supply. */
export const MAX_HINT_DEPTH = 3

export const hintSchema = z
  .object({
    /** The hint itself, addressed to the learner. */
    text: proseText,
    /**
     * What this hint does for them, in the model's own judgement. Recorded so the hint ladder
     * can be reviewed later; it does not affect scoring.
     */
    kind: z.enum(['orienting', 'narrowing', 'specific']),
  })
  .strict()

export type Hint = z.infer<typeof hintSchema>

export interface HintInput {
  readonly learner: LearnerContext
  readonly conceptId: ConceptId
  readonly brief: string
  /** What they have written so far, if anything. */
  readonly learnerAttempt: string | null
  /** 1 for the first hint, rising to MAX_HINT_DEPTH. */
  readonly depth: number
  /** Hints already given for this task, so each one advances. */
  readonly previousHints: readonly string[]
  /**
   * The exercise's reference solution, for the leak check only — never in the prompt. Null for
   * a task that has none, such as a written question.
   */
  readonly referenceSolution?: string | null | undefined
}

const HINT_LADDER: Readonly<Record<number, string>> = {
  1: 'First hint. Point them at the part of the problem to think about. Do not mention any specific Python construct. Asking a question is usually better than telling.',
  2: 'Second hint. They are still stuck. Name the idea or the technique that applies, and say why it fits here. Still no code that does their task.',
  3: 'Final hint. Describe the steps in order, in words. You may show a short fragment illustrating the technique on *different* data. You still must not write their solution.',
}

const HINT_INSTRUCTION = `TASK: give the learner one hint.

A hint moves them one step, and leaves the step after it to them. If your hint would let them
finish by copying it, it is not a hint.

Do not repeat an earlier hint in different words. Each one must add something.

One or two sentences.`

export const hintStrategy: StructuredStrategy<HintInput, Hint> = {
  kind: 'structured',
  id: 'hint',
  // v2 (M6): checked against the exercise's own reference solution, not only for a function.
  version: '2',
  purpose: 'Give the next hint on a bounded ladder, without giving away the solution.',
  streams: false,
  schemaName: 'hint',
  schema: hintSchema,
  buildBlocks(input) {
    const depth = Math.min(Math.max(Math.trunc(input.depth), 1), MAX_HINT_DEPTH)
    const ladder = HINT_LADDER[depth] ?? HINT_LADDER[MAX_HINT_DEPTH] ?? ''
    const previous =
      input.previousHints.length === 0
        ? ''
        : `\n\nHints already given:\n${input.previousHints.map((hint) => `- ${hint}`).join('\n')}`
    const attempt =
      input.learnerAttempt === null
        ? '\n\nThey have not written anything yet.'
        : `\n\n${quoteLearnerText('WHAT THEY HAVE WRITTEN SO FAR', input.learnerAttempt)}`

    return composePrompt({
      strategy: `${HINT_INSTRUCTION}\n\n${ladder}`,
      learner: input.learner,
      task: `THE TASK THEY ARE ON\n${input.brief}${attempt}${previous}\n\nThis is hint ${String(depth)} of ${String(MAX_HINT_DEPTH)}.`,
    })
  },
  checkInvariants(output, input) {
    const reference = input.referenceSolution ?? null
    // Against the hints already shown as well: by the last rung they are all on screen together,
    // and a ladder that leaks across three steps has leaked.
    const ladder = [...input.previousHints, output.text].join('\n')

    return [
      ...checkNoSolution(output.text, 'hint text'),
      ...(reference !== null &&
      (revealsReference(output.text, reference) || revealsReference(ladder, reference))
        ? [
            {
              code: 'reveals-solution',
              detail:
                'The hint, or the hints so far taken together, contain most of the solution. Move the learner one step, in words.',
            },
          ]
        : []),
    ]
  },
  // A generic hint would be useless at best and misleading at worst. The caller falls back to
  // telling the learner no hint is available, which is at least true.
  safeFallback: () => null,
}
