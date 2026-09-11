import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

/**
 * The learner's data.
 *
 * Two things shape this schema. Every change to the learner's standing is attributable to one
 * attempt, so evidence is a table rather than a derived number. And the kinds of information
 * that go into a profile are not equally trustworthy — what the learner said about themselves,
 * what they demonstrated, what a model judged, what their code actually did — so they are
 * stored separately rather than collapsed into one score.
 */

const now = sql`(unixepoch() * 1000)`

/**
 * The single local learner.
 *
 * No authentication and no multi-user support, so this table holds exactly one row, created on
 * first run.
 */
export const learner = sqliteTable('learner', {
  id: integer('id').primaryKey({ autoIncrement: false }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),

  /** What they want out of this, in their own words. Learner text — never an instruction. */
  goal: text('goal'),
  /** One of the `ExperienceLevel` values. */
  experience: text('experience'),
  /** Competence areas they said interest them, as JSON. Used for ordering, never scoring. */
  interests: text('interests', { mode: 'json' }).$type<string[]>(),

  /**
   * How far through the first run they are.
   *
   * Stored rather than inferred, so reopening the application mid-way returns them to the step
   * they were on instead of restarting or skipping ahead.
   */
  onboardingStep: text('onboarding_step').notNull().default('goal'),
  onboardingCompletedAt: integer('onboarding_completed_at', { mode: 'timestamp_ms' }),
  diagnosticCompletedAt: integer('diagnostic_completed_at', { mode: 'timestamp_ms' }),
})

/**
 * What the learner said about their own confidence, per competence area.
 *
 * Kept in its own table and never merged into `concept_state`. It is a claim, not evidence:
 * it shifts the starting estimate and decides where the diagnostic begins, and contributes no
 * evidence at all, so no band can be earned from it.
 */
export const selfReport = sqliteTable(
  'self_report',
  {
    learnerId: integer('learner_id')
      .notNull()
      .references(() => learner.id, { onDelete: 'cascade' }),
    area: text('area').notNull(),
    /** One of the `Confidence` values. */
    confidence: text('confidence').notNull(),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [primaryKey({ columns: [table.learnerId, table.area] })],
)

/**
 * What the tutor currently believes about one concept.
 *
 * The numeric columns are internal. What a learner sees is a coarse band derived from them,
 * plus a separate indication of how much evidence sits behind it.
 */
export const conceptState = sqliteTable(
  'concept_state',
  {
    learnerId: integer('learner_id')
      .notNull()
      .references(() => learner.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id').notNull(),
    theta: real('theta').notNull(),
    uncertainty: real('uncertainty').notNull(),
    evidenceCount: integer('evidence_count').notNull().default(0),
    successes: integer('successes').notNull().default(0),
    unaidedSuccesses: integer('unaided_successes').notNull().default(0),
    supportSignal: real('support_signal').notNull().default(0),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    nextReviewAt: integer('next_review_at', { mode: 'timestamp_ms' }),
  },
  (table) => [primaryKey({ columns: [table.learnerId, table.conceptId] })],
)

/** One run of the diagnostic. */
export const diagnosticSession = sqliteTable('diagnostic_session', {
  id: text('id').primaryKey(),
  learnerId: integer('learner_id')
    .notNull()
    .references(() => learner.id, { onDelete: 'cascade' }),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().default(now),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  /** Why it ended, from the planner. Recorded so completion can be explained afterwards. */
  completionReason: text('completion_reason'),
  /**
   * Items set aside because they could not be marked — in practice, a written answer while the
   * tutor was unreachable. Deliberately not responses: nothing was judged, so nothing is
   * recorded as right or wrong, and the concept stays unknown rather than assumed.
   */
  skippedItems: text('skipped_items', { mode: 'json' }).$type<string[]>().notNull().default([]),
})

/**
 * One answered diagnostic item.
 *
 * The unique constraint on (session, item) is what makes submission idempotent. A double
 * click, a refresh, a retry or a re-render cannot record the same item twice, and therefore
 * cannot produce the same evidence twice — the database refuses rather than the application
 * remembering to check.
 */
export const diagnosticResponse = sqliteTable(
  'diagnostic_response',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => diagnosticSession.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(),
    conceptId: text('concept_id').notNull(),
    /** What the learner submitted: an option index, predicted output, prose, or code. */
    answer: text('answer').notNull(),
    correct: integer('correct', { mode: 'boolean' }).notNull(),
    /** `deterministic`, `execution` or `model` — how the verdict was reached. */
    verdictSource: text('verdict_source').notNull(),
    /** stdout, or the traceback, for a practical item. */
    executionOutput: text('execution_output'),
    /** Names of tests that failed, as JSON, for a practical item. */
    failedTests: text('failed_tests', { mode: 'json' }).$type<string[]>(),
    answeredAt: integer('answered_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [unique('diagnostic_response_unique_item').on(table.sessionId, table.itemId)],
)

/**
 * Why the learner model changed.
 *
 * One row per movement, with the estimate either side and a sentence a learner can read. This
 * is what lets the interface answer "why did this change?" rather than presenting a number
 * nobody can account for.
 */
export const evidence = sqliteTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    learnerId: integer('learner_id')
      .notNull()
      .references(() => learner.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id').notNull(),
    /** Where this came from: `diagnostic`, and later `quiz`, `exercise`, `review`. */
    source: text('source').notNull(),
    /** The attempt this is attributable to. */
    attemptId: text('attempt_id').notNull(),
    correct: integer('correct', { mode: 'boolean' }).notNull(),
    hintDepth: integer('hint_depth').notNull().default(0),
    priorTheta: real('prior_theta').notNull(),
    posteriorTheta: real('posterior_theta').notNull(),
    priorBand: text('prior_band').notNull(),
    posteriorBand: text('posterior_band').notNull(),
    reason: text('reason').notNull(),
    observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [index('evidence_by_concept').on(table.learnerId, table.conceptId)],
)

/** A misconception seen in one attempt. */
export const misconceptionObservation = sqliteTable('misconception_observation', {
  id: text('id').primaryKey(),
  learnerId: integer('learner_id')
    .notNull()
    .references(() => learner.id, { onDelete: 'cascade' }),
  attemptId: text('attempt_id').notNull(),
  conceptId: text('concept_id').notNull(),
  misconceptionId: text('misconception_id').notNull(),
  observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull().default(now),
})

/**
 * An outcome that sat badly with an item's declared difficulty.
 *
 * Written for later analysis and never acted on. With one learner, a surprising outcome cannot
 * be attributed to the item rather than the learner, so the observation is kept and the item's
 * difficulty is left alone (ADR-0004).
 */
export const itemCalibrationObservation = sqliteTable('item_calibration_observation', {
  id: text('id').primaryKey(),
  learnerId: integer('learner_id')
    .notNull()
    .references(() => learner.id, { onDelete: 'cascade' }),
  attemptId: text('attempt_id').notNull(),
  itemId: text('item_id').notNull(),
  conceptId: text('concept_id').notNull(),
  declaredDifficulty: real('declared_difficulty').notNull(),
  thetaAtAttempt: real('theta_at_attempt').notNull(),
  expected: real('expected').notNull(),
  correct: integer('correct', { mode: 'boolean' }).notNull(),
  residual: real('residual').notNull(),
  observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull().default(now),
})

export type Learner = typeof learner.$inferSelect
export type NewLearner = typeof learner.$inferInsert
export type ConceptStateRow = typeof conceptState.$inferSelect
export type DiagnosticSessionRow = typeof diagnosticSession.$inferSelect
export type DiagnosticResponseRow = typeof diagnosticResponse.$inferSelect
export type EvidenceRow = typeof evidence.$inferSelect
