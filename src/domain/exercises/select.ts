import { getConcept, transitivePrerequisites } from '../curriculum/graph'
import type { ConceptId, MisconceptionId } from '../curriculum/types'
import { bandOf, evidenceStrengthOf, type ConceptState } from '../learner-model/state'
import { AUTHORED_EXERCISES, exercisesFor } from './bank'
import type { AuthoredExercise } from './types'

/**
 * When to set a programming exercise, and which one.
 *
 * The same shape as the decision to ask a question (M5), for the same reasons: it is made from the
 * learner model, deterministically, before any model is involved, so the reason for setting an
 * exercise can be stored and shown. The learner asks for one; this decides whether it is a sensible
 * moment and what to set.
 */

/** One exercise per sitting is plenty; two is the most a tutoring session should become. */
export const MAX_EXERCISES_PER_SITTING = 2

export type ExerciseHold =
  /** Nothing has been taught yet in this session. */
  | 'too-early'
  /** A question or an exercise is already waiting. One thing at a time. */
  | 'finish-open-one'
  /** Enough practical work for one sitting. */
  | 'enough-for-now'
  /** Secure, with strong evidence. An exercise here would tell nobody anything. */
  | 'nothing-to-learn'

export type ExerciseGround =
  /** A wrong idea was seen recently, and this exercise has a check pattern that would show it. */
  | { readonly kind: 'probes-misconception'; readonly misconception: MisconceptionId }
  /** Practice on the concept being taught. */
  | { readonly kind: 'practice' }
  /**
   * Practice on something this concept builds on, because nothing could be prepared for the
   * concept itself. Named, so the change of subject is never silent (M5 review finding F-05).
   */
  | { readonly kind: 'builds-on'; readonly conceptId: ConceptId }

export type ExerciseDecision =
  | { readonly kind: 'set'; readonly exercise: AuthoredExercise; readonly ground: ExerciseGround }
  /** Nothing authored is left for this concept, so one has to be written and verified. */
  | { readonly kind: 'generate'; readonly conceptId: ConceptId; readonly ground: ExerciseGround }
  | { readonly kind: 'hold'; readonly because: ExerciseHold }

export interface ExerciseContext {
  readonly conceptId: ConceptId
  readonly state: ConceptState
  /** Learner turns in the session. */
  readonly exchanges: number
  /** Exercises set since the session was last opened. */
  readonly exercisesThisSitting: number
  /** True while a question is unanswered or an exercise has not yet been submitted. */
  readonly openActivity: boolean
  /** Authored exercises this learner has been set before, in any session. */
  readonly usedExerciseIds: readonly string[]
  /** Misconceptions observed recently, most recent first. From real attempts only. */
  readonly recentMisconceptions: readonly MisconceptionId[]
}

export function decideExercise(context: ExerciseContext): ExerciseDecision {
  if (context.exchanges < 1) return { kind: 'hold', because: 'too-early' }
  if (context.openActivity) return { kind: 'hold', because: 'finish-open-one' }
  if (context.exercisesThisSitting >= MAX_EXERCISES_PER_SITTING) {
    return { kind: 'hold', because: 'enough-for-now' }
  }
  if (bandOf(context.state) === 'secure' && evidenceStrengthOf(context.state) === 'strong') {
    return { kind: 'hold', because: 'nothing-to-learn' }
  }

  const available = exercisesFor(context.conceptId).filter(
    (exercise) => !context.usedExerciseIds.includes(exercise.id),
  )

  if (available.length === 0) {
    return { kind: 'generate', conceptId: context.conceptId, ground: { kind: 'practice' } }
  }

  // An exercise that can actually observe a wrong idea seen recently comes first — but only one
  // whose checks can record it. Claiming to probe something the exercise cannot measure is the
  // M5 defect F-11, and the invariant in `bank.test.ts` keeps signals honest.
  for (const misconception of context.recentMisconceptions) {
    const probe = available.find((exercise) =>
      exercise.signals.some((signal) => signal.misconception === misconception),
    )
    if (probe !== undefined) {
      return { kind: 'set', exercise: probe, ground: { kind: 'probes-misconception', misconception } }
    }
  }

  const target =
    context.state.evidenceCount === 0
      ? getConcept(context.conceptId).baselineDifficulty
      : context.state.theta

  const nearest = available.reduce((chosen, candidate) =>
    Math.abs(candidate.difficulty - target) < Math.abs(chosen.difficulty - target) ? candidate : chosen,
  )

  return { kind: 'set', exercise: nearest, ground: { kind: 'practice' } }
}

/**
 * An authored exercise to set when one could not be generated for the concept itself.
 *
 * Only on something the concept is built on. Those have been met by construction — the
 * scheduler does not open a concept whose prerequisites have not been demonstrated — so the
 * learner is practising familiar material rather than being tested on something untaught. The
 * nearest prerequisite in difficulty is preferred, as the one closest to the lesson.
 */
export function fallbackExercise(
  conceptId: ConceptId,
  usedExerciseIds: readonly string[],
): { readonly exercise: AuthoredExercise; readonly ground: ExerciseGround } | null {
  const prerequisites = transitivePrerequisites(conceptId)
  const baseline = getConcept(conceptId).baselineDifficulty

  const candidates = AUTHORED_EXERCISES.filter(
    (exercise) => prerequisites.has(exercise.conceptId) && !usedExerciseIds.includes(exercise.id),
  )
  if (candidates.length === 0) return null

  const nearest = candidates.reduce((chosen, candidate) =>
    Math.abs(candidate.difficulty - baseline) < Math.abs(chosen.difficulty - baseline)
      ? candidate
      : chosen,
  )

  return { exercise: nearest, ground: { kind: 'builds-on', conceptId: nearest.conceptId } }
}

/** Why this exercise, in words the learner is shown. No estimate appears in any of them. */
export function describeExerciseGround(ground: ExerciseGround): string {
  switch (ground.kind) {
    case 'probes-misconception':
      return 'A short exercise on something that went wrong in an earlier answer, to see whether it still does.'
    case 'practice':
      return 'A short exercise, to put what we have been talking about into code.'
    case 'builds-on':
      return `A short exercise on ${getConcept(ground.conceptId).title.toLowerCase()}, which this builds on — a new one for this topic could not be prepared just now.`
  }
}
