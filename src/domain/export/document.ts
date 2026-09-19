import { getConcept } from '../curriculum/graph'
import type { ConceptId, MisconceptionId } from '../curriculum/types'
import { bandOf, evidenceStrengthOf, type ConceptState } from '../learner-model/state'
import { lifecycleOf, type SessionLifecycle } from '../tutoring/lifecycle'

/**
 * Everything the tutor has recorded about the learner, as one JSON document.
 *
 * The learner's history lives in a SQLite file on their own machine, which is private but not
 * portable: nobody can read it without the application. This is the copy they can keep, read,
 * or hand to somebody else.
 *
 * Three decisions shape it, and each is a deliberate exclusion rather than an oversight
 * (ADR-0033):
 *
 *  - **Answer keys are not learner data.** No expected answer, recognised wrong answer,
 *    authored explanation or exercise reference solution is exported. Exporting them would be
 *    a new route to the thing M5 and M6 spend most of their effort preventing: a learner
 *    holding the answer to a question they have not yet been asked.
 *  - **Operational records are not learner data.** The model-call log, item calibration
 *    residuals and anything naming a provider or its configuration stay out. They are about
 *    the system, not the person.
 *  - **The conversation is learner data, and is included.** It is the record of the lessons
 *    they sat through; an export that answered "what have I done?" with counts alone would be
 *    a poorer record than the application they are exporting from. Model-written text is
 *    labelled as the tutor's, per turn, as it is on the page.
 *
 * Built field by field from an explicit input, never by serialising a stored row, so a column
 * added later cannot leak by being forgotten. Asserted over the serialised result in
 * `document.test.ts`.
 */

export const EXPORT_SCHEMA = 'programming-tutor-learner-export'

/**
 * The version of this document's shape.
 *
 * Bumped whenever a field changes meaning or disappears, so a file kept for a year can be read
 * knowing which shape it is. Additive fields do not require a bump.
 */
export const EXPORT_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// What goes in
// ---------------------------------------------------------------------------

export interface ExportLearner {
  readonly goal: string | null
  readonly experience: string | null
  readonly interests: readonly string[]
  readonly onboardingCompletedAt: number | null
  readonly diagnosticCompletedAt: number | null
}

export interface ExportEvidenceEntry {
  readonly conceptId: string
  readonly source: string
  readonly correct: boolean
  readonly hintDepth: number
  readonly priorBand: string
  readonly posteriorBand: string
  readonly reason: string
  readonly observedAt: number
}

export interface ExportMisconception {
  readonly conceptId: string
  readonly misconceptionId: string
  readonly observedAt: number
}

export interface ExportDiagnostic {
  readonly startedAt: number
  readonly completedAt: number | null
  readonly completionReason: string | null
  readonly skippedItemIds: readonly string[]
  readonly responses: readonly {
    readonly itemId: string
    readonly conceptId: string
    readonly response: string
    readonly correct: boolean
    readonly answeredAt: number
  }[]
}

export interface ExportTurn {
  readonly ordinal: number
  readonly role: 'tutor' | 'learner' | 'activity'
  readonly text: string
  readonly status: string
}

export interface ExportActivity {
  readonly kind: string
  readonly origin: string
  readonly conceptId: string
  readonly prompt: string
  readonly code: string | null
  /**
   * The options as the learner saw them, in the order they were shown.
   *
   * A multiple-choice answer is stored as the index into that order (ADR-0027), so without
   * them the file says `"response": "2"` with nothing to resolve it against — which is not
   * "everything about their attempt" (M7 review finding L1). The correct index is **not**
   * exported: the options are what the learner read, the answer key is not theirs.
   */
  readonly options: readonly string[] | null
  readonly selectionGround: string
  readonly askedAt: number
  readonly hints: readonly { readonly depth: number; readonly text: string }[]
  readonly attempt: {
    readonly response: string
    readonly marked: boolean
    readonly correct: boolean | null
    readonly partial: boolean
    readonly markedBy: string | null
    readonly hintDepth: number
    readonly feedback: string
    readonly misconceptions: readonly MisconceptionId[]
    readonly attemptedAt: number
  } | null
}

export interface ExportExercise {
  readonly title: string
  readonly brief: string
  readonly kind: string
  readonly origin: string
  readonly conceptId: string
  readonly askedAt: number
  readonly yourCode: string | null
  readonly hints: readonly { readonly depth: number; readonly text: string }[]
  readonly submissions: readonly {
    readonly ordinal: number
    readonly code: string
    readonly state: string
    readonly passedChecks: number | null
    readonly totalChecks: number
    readonly counted: boolean
    readonly hintsTaken: number
    readonly submittedAt: number
  }[]
}

export interface ExportSession {
  readonly id: string
  readonly conceptId: string
  readonly openedReason: string
  readonly mode: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly closedAt: number | null
  readonly turns: readonly ExportTurn[]
  readonly activities: readonly ExportActivity[]
  readonly exercises: readonly ExportExercise[]
}

export interface ExportInput {
  readonly exportedAt: number
  readonly learner: ExportLearner | null
  readonly selfReport: readonly { readonly area: string; readonly confidence: string }[]
  readonly conceptStates: readonly ConceptState[]
  readonly evidence: readonly ExportEvidenceEntry[]
  readonly misconceptions: readonly ExportMisconception[]
  readonly diagnostic: ExportDiagnostic | null
  readonly sessions: readonly ExportSession[]
}

// ---------------------------------------------------------------------------
// What comes out
// ---------------------------------------------------------------------------

export type ExportedActivity = Omit<ExportActivity, 'askedAt' | 'attempt'> & {
  readonly askedAt: string
  readonly attempt: (Omit<NonNullable<ExportActivity['attempt']>, 'attemptedAt'> & { readonly attemptedAt: string }) | null
}

export type ExportedExercise = Omit<ExportExercise, 'askedAt' | 'submissions'> & {
  readonly askedAt: string
  readonly submissions: readonly (Omit<ExportExercise['submissions'][number], 'submittedAt'> & {
    readonly submittedAt: string
  })[]
}

export type ExportedDiagnostic = Omit<ExportDiagnostic, 'startedAt' | 'completedAt' | 'responses'> & {
  readonly startedAt: string
  readonly completedAt: string | null
  readonly responses: readonly (Omit<ExportDiagnostic['responses'][number], 'answeredAt'> & {
    readonly answeredAt: string
  })[]
}

export interface ExportedConcept {
  readonly conceptId: ConceptId
  readonly title: string
  readonly area: string
  readonly band: string
  readonly evidenceStrength: string
  readonly evidenceCount: number
  readonly successes: number
  readonly unaidedSuccesses: number
  readonly nextReviewAt: string | null
  /** The internal estimate, exported because it is the learner's own record. See `about`. */
  readonly estimate: { readonly ability: number; readonly uncertainty: number }
}

export interface ExportDocument {
  readonly schema: string
  readonly schemaVersion: number
  readonly exportedAt: string
  readonly about: {
    readonly contents: string
    readonly numbers: string
    readonly excluded: string
  }
  readonly learner: {
    readonly goal: string | null
    readonly experience: string | null
    readonly interests: readonly string[]
    readonly onboardingCompletedAt: string | null
    readonly diagnosticCompletedAt: string | null
    readonly selfReport: readonly { readonly area: string; readonly confidence: string }[]
  }
  readonly concepts: readonly ExportedConcept[]
  readonly evidence: readonly (Omit<ExportEvidenceEntry, 'observedAt'> & { readonly observedAt: string })[]
  readonly misconceptionsObserved: readonly (Omit<ExportMisconception, 'observedAt'> & {
    readonly observedAt: string
  })[]
  readonly diagnostic: ExportedDiagnostic | null
  readonly sessions: readonly (Omit<ExportSession, 'startedAt' | 'updatedAt' | 'closedAt' | 'activities' | 'exercises'> & {
    readonly startedAt: string
    readonly updatedAt: string
    readonly closedAt: string | null
    readonly standing: SessionLifecycle
    readonly activities: readonly ExportedActivity[]
    readonly exercises: readonly ExportedExercise[]
  })[]
  readonly counts: {
    readonly concepts: number
    readonly evidence: number
    readonly sessions: number
    readonly activities: number
    readonly exercises: number
  }
}

const ABOUT = {
  contents:
    'Everything this copy of the tutor has recorded about you: what you said you wanted, your assessment answers, every piece of evidence behind your concept standings, and your tutoring conversations.',
  numbers:
    'Bands and counts are what the application shows you. "estimate" is the internal number behind a band, kept here for completeness; it is an estimate from a handful of answers, not a measurement.',
  excluded:
    'Answer keys, exercise reference solutions, and records about the system rather than about you (model-call logs and item calibration) are deliberately not included.',
} as const

/** Epoch milliseconds as an ISO string, so a date in the file is readable without a decoder. */
function moment(at: number | null): string | null {
  if (at === null || !Number.isFinite(at)) return null
  return new Date(at).toISOString()
}

function requiredMoment(at: number): string {
  return moment(at) ?? new Date(0).toISOString()
}

export function buildExportDocument(input: ExportInput): ExportDocument {
  const sessions = input.sessions.map((session) => ({
    id: session.id,
    conceptId: session.conceptId,
    openedReason: session.openedReason,
    mode: session.mode,
    startedAt: requiredMoment(session.startedAt),
    updatedAt: requiredMoment(session.updatedAt),
    closedAt: moment(session.closedAt),
    standing: lifecycleOf({ updatedAt: session.updatedAt, closedAt: session.closedAt }, input.exportedAt),
    turns: session.turns,
    activities: session.activities.map((activity) => exportedActivity(activity)),
    exercises: session.exercises.map((exercise) => exportedExercise(exercise)),
  }))

  return {
    schema: EXPORT_SCHEMA,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: requiredMoment(input.exportedAt),
    about: ABOUT,
    learner: {
      goal: input.learner?.goal ?? null,
      experience: input.learner?.experience ?? null,
      interests: input.learner?.interests ?? [],
      onboardingCompletedAt: moment(input.learner?.onboardingCompletedAt ?? null),
      diagnosticCompletedAt: moment(input.learner?.diagnosticCompletedAt ?? null),
      selfReport: input.selfReport.map((entry) => ({ area: entry.area, confidence: entry.confidence })),
    },
    concepts: input.conceptStates.map((state) => exportedConcept(state)),
    evidence: input.evidence.map((entry) => ({
      conceptId: entry.conceptId,
      source: entry.source,
      correct: entry.correct,
      hintDepth: entry.hintDepth,
      priorBand: entry.priorBand,
      posteriorBand: entry.posteriorBand,
      reason: entry.reason,
      observedAt: requiredMoment(entry.observedAt),
    })),
    misconceptionsObserved: input.misconceptions.map((entry) => ({
      conceptId: entry.conceptId,
      misconceptionId: entry.misconceptionId,
      observedAt: requiredMoment(entry.observedAt),
    })),
    diagnostic: input.diagnostic === null ? null : exportedDiagnostic(input.diagnostic),
    sessions,
    counts: {
      concepts: input.conceptStates.length,
      evidence: input.evidence.length,
      sessions: input.sessions.length,
      activities: input.sessions.reduce((total, session) => total + session.activities.length, 0),
      exercises: input.sessions.reduce((total, session) => total + session.exercises.length, 0),
    },
  }
}

/*
 * Every exported record is built field by field below, and nothing is spread.
 *
 * `{...record}` would be shorter and would type-check, because TypeScript does not
 * excess-property-check a spread: a field added to the input later would appear in a learner's
 * file with nobody deciding it should. Two of the fields immediately beside these are an answer
 * key and a reference solution, so the long way round is the point (M7 review finding L3).
 */
function exportedActivity(activity: ExportActivity): ExportedActivity {
  return {
    kind: activity.kind,
    origin: activity.origin,
    conceptId: activity.conceptId,
    prompt: activity.prompt,
    code: activity.code,
    options: activity.options,
    selectionGround: activity.selectionGround,
    askedAt: requiredMoment(activity.askedAt),
    hints: activity.hints.map((hint) => ({ depth: hint.depth, text: hint.text })),
    attempt:
      activity.attempt === null
        ? null
        : {
            response: activity.attempt.response,
            marked: activity.attempt.marked,
            correct: activity.attempt.correct,
            partial: activity.attempt.partial,
            markedBy: activity.attempt.markedBy,
            hintDepth: activity.attempt.hintDepth,
            feedback: activity.attempt.feedback,
            misconceptions: activity.attempt.misconceptions,
            attemptedAt: requiredMoment(activity.attempt.attemptedAt),
          },
  }
}

function exportedExercise(exercise: ExportExercise): ExportedExercise {
  return {
    title: exercise.title,
    brief: exercise.brief,
    kind: exercise.kind,
    origin: exercise.origin,
    conceptId: exercise.conceptId,
    askedAt: requiredMoment(exercise.askedAt),
    yourCode: exercise.yourCode,
    hints: exercise.hints.map((hint) => ({ depth: hint.depth, text: hint.text })),
    submissions: exercise.submissions.map((submission) => ({
      ordinal: submission.ordinal,
      code: submission.code,
      state: submission.state,
      passedChecks: submission.passedChecks,
      totalChecks: submission.totalChecks,
      counted: submission.counted,
      hintsTaken: submission.hintsTaken,
      submittedAt: requiredMoment(submission.submittedAt),
    })),
  }
}

function exportedDiagnostic(diagnostic: ExportDiagnostic): ExportedDiagnostic {
  return {
    startedAt: requiredMoment(diagnostic.startedAt),
    completedAt: moment(diagnostic.completedAt),
    completionReason: diagnostic.completionReason,
    skippedItemIds: diagnostic.skippedItemIds,
    responses: diagnostic.responses.map((response) => ({
      itemId: response.itemId,
      conceptId: response.conceptId,
      response: response.response,
      correct: response.correct,
      answeredAt: requiredMoment(response.answeredAt),
    })),
  }
}

function exportedConcept(state: ConceptState): ExportedConcept {
  const concept = getConcept(state.conceptId)

  return {
    conceptId: state.conceptId,
    title: concept.title,
    area: concept.area,
    band: bandOf(state),
    evidenceStrength: evidenceStrengthOf(state),
    evidenceCount: state.evidenceCount,
    successes: state.successes,
    unaidedSuccesses: state.unaidedSuccesses,
    nextReviewAt: moment(state.nextReviewAt),
    estimate: { ability: state.theta, uncertainty: state.uncertainty },
  }
}

/** The file name offered to the learner. Dated, so two exports do not collide. */
export function exportFilename(exportedAt: number): string {
  const day = moment(exportedAt)?.slice(0, 10) ?? 'export'
  return `programming-tutor-${day}.json`
}
