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

/**
 * A tutoring session: one learner working on one concept, over as many sittings as they like.
 *
 * Unique on `(learner, concept)`, which is what makes "Continue" mean something. Pressing
 * Start twice, or opening the application in two tabs, finds the session that already exists
 * rather than beginning a second conversation about the same thing — the same guarantee the
 * diagnostic gets from its own unique constraint, and for the same reason: the check belongs
 * in the database, where there is no window between looking and writing.
 */
export const tutoringSession = sqliteTable(
  'tutoring_session',
  {
    id: text('id').primaryKey(),
    learnerId: integer('learner_id')
      .notNull()
      .references(() => learner.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id').notNull(),
    /**
     * Why the scheduler chose this concept when the session began.
     *
     * Stored rather than recomputed, so the reason shown to the learner is the reason that
     * actually applied at the time. Recomputing it later would quietly rewrite history — the
     * concept may since have become due for review, or stopped being the weakest available.
     */
    openedReason: text('opened_reason').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
    /** Set when the learner says they are done with this concept for now. */
    closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [unique('tutoring_session_unique_concept').on(table.learnerId, table.conceptId)],
)

/**
 * One turn of the conversation.
 *
 * `ordinal` is unique within a session, and that is doing real work. A tutor turn is created
 * *before* its text is streamed, at the ordinal after the learner turn it answers — so
 * retrying an interrupted stream computes the same ordinal, finds the same row, and rewrites
 * it. A retry cannot append a second copy of the tutor's reply, because there is nowhere for
 * it to go.
 */
export const sessionTurn = sqliteTable(
  'session_turn',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => tutoringSession.id, { onDelete: 'cascade' }),
    /** Position in the conversation, from zero. The tutor's opening turn is always zero. */
    ordinal: integer('ordinal').notNull(),
    /** `tutor` or `learner`. */
    role: text('role').notNull(),
    /** Whatever has arrived so far. Learner text is never an instruction; see the tutor layer. */
    text: text('text').notNull().default(''),
    /**
     * `pending` before anything has arrived, `streaming` while it does, then `complete`,
     * `cancelled` or `failed`.
     *
     * A cancelled turn keeps the text that did arrive, because a learner who stopped a reply
     * half way has still read half a reply and will be confused to find it gone.
     */
    status: text('status').notNull().default('pending'),
    /** Which strategy produced a tutor turn, for provenance. Null for a learner turn. */
    strategyId: text('strategy_id'),
    strategyVersion: text('strategy_version'),
    /** Whatever `OPENAI_MODEL` was, or `mock`. Never a key. */
    model: text('model'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [unique('session_turn_unique_ordinal').on(table.sessionId, table.ordinal)],
)

/**
 * What a conversational turn appeared to be about.
 *
 * Deliberately **not** evidence, and deliberately not in the `evidence` table. Reading an
 * explanation is not demonstrating anything, and a model's impression that the learner "seems
 * to have got it" is not a performance. Nothing here reaches `concept_state`: there is no
 * numeric field to carry it and no code path that would.
 *
 * What it is for is the record — which concepts actually came up, and any wrong belief the
 * learner stated outright, so a later activity can be chosen with that in mind by a human or
 * by a milestone that has real evidence to work with.
 */
export const sessionObservation = sqliteTable('session_observation', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => tutoringSession.id, { onDelete: 'cascade' }),
  /** The tutor turn this was observed after. */
  turnId: text('turn_id').notNull(),
  /** Concept ids that came up, as JSON. Discussion, not demonstration. */
  conceptsDiscussed: text('concepts_discussed', { mode: 'json' }).$type<string[]>().notNull(),
  /** Catalogued misconceptions the learner stated outright, as JSON. Usually empty. */
  misconceptions: text('misconceptions', { mode: 'json' }).$type<string[]>().notNull(),
  /** One sentence of context, for a human reading the record later. */
  note: text('note').notNull(),
  observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull().default(now),
})

/**
 * What each call to the model cost and whether it worked.
 *
 * The M2 log shape, finally given somewhere to live. Metadata only: there is no column here
 * for a prompt or a response, so the learner's words cannot accumulate on disk as a side
 * effect of the tutor being observable. The conversation is stored once, in `session_turn`,
 * where the learner can see it and delete it.
 */
export const llmCall = sqliteTable(
  'llm_call',
  {
    id: text('id').primaryKey(),
    learnerId: integer('learner_id')
      .notNull()
      .references(() => learner.id, { onDelete: 'cascade' }),
    strategyId: text('strategy_id').notNull(),
    strategyVersion: text('strategy_version').notNull(),
    policyVersion: text('policy_version').notNull(),
    curriculumVersion: text('curriculum_version').notNull(),
    model: text('model').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    /**
     * `ok`, `ok-after-repair`, `fallback`, `failed` or `cancelled`.
     *
     * `cancelled` is deliberately not a failure: a learner pressing Stop is ordinary use, and
     * counting it against the system would overstate the failure rate in the one table that is
     * meant to be the source of real numbers about how it behaved.
     */
    outcome: text('outcome').notNull(),
    repairAttempted: integer('repair_attempted', { mode: 'boolean' }).notNull(),
    repairSucceeded: integer('repair_succeeded', { mode: 'boolean' }).notNull(),
    /** Validation problem codes, as JSON. Codes only — a detail could quote learner text. */
    problemCodes: text('problem_codes', { mode: 'json' }).$type<string[]>().notNull(),
    failureReason: text('failure_reason'),
    inputTokens: integer('input_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    outputTokens: integer('output_tokens'),
    streamed: integer('streamed', { mode: 'boolean' }).notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [index('llm_call_by_time').on(table.learnerId, table.at)],
)
