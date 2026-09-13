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
    /**
     * When the learner last sat down with this concept.
     *
     * A session is unique per concept and is reopened rather than replaced, so `startedAt` is
     * the first time they ever opened it and the conversation grows for the life of the
     * profile. Anything that should be "per sitting" rather than "for ever" — how many
     * questions have been asked, in particular — is counted from here.
     */
    /*
     * The zero default is not a meaningful time, and nothing reads it as one: both writers
     * (`openSession` and `reopenSession`) always supply a value. It is a constant because
     * SQLite cannot add a NOT NULL column to a populated table with a computed default, and
     * the migration backfills every existing row from `started_at`.
     */
    resumedAt: integer('resumed_at', { mode: 'timestamp_ms' }).notNull().default(sql`0`),
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

/**
 * An evaluated activity: a question the tutor asked inside a session.
 *
 * Stored in full, including its answer key, because the answer key must never reach the
 * browser — the same rule the diagnostic follows, for the same reason. The learner-facing view
 * is built by `presentActivity`, and a test asserts over the whole bank that no
 * answer-bearing field survives that trip.
 *
 * `turn_id` is unique, so an activity occupies exactly one position in the conversation and
 * inherits the M4 ordinal machinery: the turn is reserved first, and there is no way to attach
 * two activities to one moment.
 *
 * The options are stored **as presented**, after shuffling. What the learner saw is what is
 * marked and what is shown back to them; re-deriving the order later would risk marking
 * against an arrangement they never saw.
 */
export const sessionActivity = sqliteTable(
  'session_activity',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => tutoringSession.id, { onDelete: 'cascade' }),
    /** The turn this activity occupies. Unique: one activity per position. */
    turnId: text('turn_id').notNull(),
    conceptId: text('concept_id').notNull(),
    /** `choice`, `predict-output` or `short-response`. */
    kind: text('kind').notNull(),
    /** The authored item this came from, or null when it was generated. */
    itemId: text('item_id'),
    /** `authored` or `generated`. Recorded because it changes how much to trust the item. */
    origin: text('origin').notNull(),
    prompt: text('prompt').notNull(),
    code: text('code'),
    /** Options as presented, already shuffled. Null for anything but a choice. */
    options: text('options', { mode: 'json' }).$type<string[]>(),
    /** Index into the presented order. Null for anything but a choice. */
    correctIndex: integer('correct_index'),
    /** Per-option misconceptions, in the presented order. Null for anything but a choice. */
    optionMisconceptions: text('option_misconceptions', { mode: 'json' }).$type<(string | null)[]>(),
    /** For an output prediction. Never sent to the browser. */
    expectedOutput: text('expected_output'),
    /** Known wrong answers worth recognising, as JSON. Never sent to the browser. */
    knownWrongAnswers: text('known_wrong_answers', { mode: 'json' }).$type<
      { answer: string; misconception: string }[]
    >(),
    /** What a good written answer contains. Given to the judge; never shown before answering. */
    expectedPoints: text('expected_points'),
    /** Why the right answer is right. Shown after answering. */
    explanation: text('explanation').notNull(),
    /**
     * Why this activity was chosen, from the selector's own grounds.
     *
     * Stored rather than recomputed. The reason shown to the learner has to be the reason that
     * actually applied when the question was asked; recomputing it later would quietly rewrite
     * it as their state moved on.
     */
    selectionGround: text('selection_ground').notNull(),
    /** The misconception being probed, where that was the ground. */
    probesMisconception: text('probes_misconception'),
    /** Provenance for a generated item. Null when authored. */
    strategyId: text('strategy_id'),
    strategyVersion: text('strategy_version'),
    model: text('model'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [unique('session_activity_unique_turn').on(table.turnId)],
)

/**
 * One attempt at one activity.
 *
 * `activity_id` is unique, and that single constraint is what makes "a learner never receives
 * two mastery updates from one answer" a property of the database rather than a promise about
 * the interface. Evidence is derived only when this insert actually creates a row, so a
 * double-click, a refresh mid-request, a replayed action or a retry after a provider failure
 * all reach the same row and change nothing the second time.
 *
 * A second *attempt* at the same question is deliberately not possible. Answering again after
 * feedback is not independent evidence, and treating it as such would let a learner walk a band
 * upwards by guessing. When another go is warranted the tutor asks a different question.
 */
export const activityAttempt = sqliteTable(
  'activity_attempt',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => sessionActivity.id, { onDelete: 'cascade' }),
    /** Exactly what the learner submitted. Untrusted text, stored verbatim. */
    response: text('response').notNull(),
    /**
     * `marked` or `unmarked`.
     *
     * An unmarked attempt is kept, shown to the learner as unmarked, and produces no evidence.
     * A safe unmarked result is better than false evidence.
     */
    outcome: text('outcome').notNull(),
    correct: integer('correct', { mode: 'boolean' }),
    /** True when the answer was right with part of the reasoning missing. */
    partial: integer('partial', { mode: 'boolean' }).notNull().default(false),
    /** `deterministic` or `model`. What marked it, so the learner can be told. */
    markingSource: text('marking_source'),
    /** Why it could not be marked, where it could not. */
    unmarkedReason: text('unmarked_reason'),
    /** Misconceptions observed in this attempt, as JSON. */
    misconceptions: text('misconceptions', { mode: 'json' }).$type<string[]>().notNull(),
    /** How many hints were taken first. Attenuates positive evidence; never a penalty. */
    hintDepth: integer('hint_depth').notNull().default(0),
    /** The feedback shown. Stored so the learner sees the same words on a reload. */
    feedback: text('feedback').notNull(),
    attemptedAt: integer('attempted_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [unique('activity_attempt_unique_activity').on(table.activityId)],
)

/**
 * A hint the learner asked for, on one activity.
 *
 * M5 allows one restrained step; the full ladder is M6. Recorded separately from the attempt so
 * that asking for help is a visible event in its own right rather than only a number attached
 * to an answer — and because ADR-0005 treats support as information about *how* a success was
 * reached, not as a penalty for needing it.
 */
export const activityHint = sqliteTable(
  'activity_hint',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => sessionActivity.id, { onDelete: 'cascade' }),
    /** 1 for the single step M5 offers. */
    depth: integer('depth').notNull(),
    text: text('text').notNull(),
    strategyId: text('strategy_id'),
    strategyVersion: text('strategy_version'),
    model: text('model'),
    askedAt: integer('asked_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [unique('activity_hint_unique_depth').on(table.activityId, table.depth)],
)

// ---------------------------------------------------------------------------------------------
// M6: programming exercises
// ---------------------------------------------------------------------------------------------

/**
 * A programming exercise set inside a session.
 *
 * One row per position in the conversation (`turn_id` is unique), for the same reason a question
 * has one: a double-click or a remount finds the exercise already there instead of setting a
 * second one. The row is the exercise's identity for the rest of its life — a learner who comes
 * back finds the same task, not a fresh draw.
 *
 * A generated exercise is written here *before* it is verified, as `unverified`, and may be
 * replaced by one regeneration or a fallback while it is still unverified. Once `verified` its
 * content is fixed. Nothing unverified is ever presented to the learner.
 */
export const sessionExercise = sqliteTable(
  'session_exercise',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => tutoringSession.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull(),
    conceptId: text('concept_id').notNull(),
    /** `write` or `fix`. */
    kind: text('kind').notNull(),
    /** `authored` or `generated`. */
    origin: text('origin').notNull(),
    /** The authored exercise this is, or null when generated. */
    exerciseId: text('exercise_id'),
    /** Which version of the authored bank it came from. Null when generated. */
    bankVersion: text('bank_version'),
    title: text('title').notNull(),
    brief: text('brief').notNull(),
    starterCode: text('starter_code').notNull(),
    /** Named checks. Their code reaches the browser, because that is where they run. */
    tests: text('tests', { mode: 'json' }).$type<{ name: string; code: string }[]>().notNull(),
    /** Never presented. Reaches the browser only to verify a generated exercise (ADR-0006). */
    referenceSolution: text('reference_solution').notNull(),
    /** Result patterns specific enough to name a misconception. Empty for a generated exercise. */
    signals: text('signals', { mode: 'json' })
      .$type<
        {
          misconception: string
          pattern: ('pass' | 'fail')[]
          codeShows: string
          codeLacks?: string
          witness: string
          counterexamples: string[]
        }[]
      >()
      .notNull(),
    /** The authored hint ladder, or null when hints are written on request. */
    authoredHints: text('authored_hints', { mode: 'json' }).$type<string[]>(),
    /** Declared difficulty. A prior, never revised (ADR-0004). */
    difficulty: real('difficulty').notNull(),
    selectionGround: text('selection_ground').notNull(),
    /** `unverified`, `verified` or `rejected`. */
    verification: text('verification').notNull(),
    /** 0 for authored; 1 for a first generation; 2 after the one permitted regeneration. */
    generationAttempt: integer('generation_attempt').notNull().default(0),
    strategyId: text('strategy_id'),
    strategyVersion: text('strategy_version'),
    model: text('model'),
    /** The learner's latest code, saved as they work. Null until they change anything. */
    draftCode: text('draft_code'),
    /** When that code was written, by the browser's clock, so a late save cannot overwrite a newer one. */
    draftEditedAt: integer('draft_edited_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [unique('session_exercise_unique_turn').on(table.turnId)],
)

/**
 * A hint taken on an exercise.
 *
 * Unique per depth, so the ladder cannot be skipped or double-counted: asking for hint 2 twice
 * finds the same hint, and hint 3 cannot exist without hint 2. How many were taken before the
 * first submission is what attenuates the evidence (ADR-0005) — read from these rows at the
 * moment of submitting, never from a field that also means something else (M5 finding F-02).
 */
export const exerciseHint = sqliteTable(
  'exercise_hint',
  {
    id: text('id').primaryKey(),
    exerciseId: text('exercise_id')
      .notNull()
      .references(() => sessionExercise.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull(),
    text: text('text').notNull(),
    /** `authored` or `model`. */
    source: text('source').notNull(),
    strategyId: text('strategy_id'),
    strategyVersion: text('strategy_version'),
    model: text('model'),
    askedAt: integer('asked_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [unique('exercise_hint_unique_depth').on(table.exerciseId, table.depth)],
)

/**
 * A submission of code for an exercise.
 *
 * Two unique constraints, doing different jobs:
 *
 *   - `(exercise_id, code_hash)` — submitting the same code again, whether by double-click,
 *     retry, reload or a replayed action, finds the same row and changes nothing;
 *   - `(exercise_id, ordinal)` — submissions are numbered, and only **the first** produces
 *     evidence. A later one, after feedback, is marked and shown so the learner can finish the
 *     task, but answering again with the checks' results in front of you is not independent
 *     evidence of anything (ADR-0029).
 */
export const exerciseSubmission = sqliteTable(
  'exercise_submission',
  {
    id: text('id').primaryKey(),
    exerciseId: text('exercise_id')
      .notNull()
      .references(() => sessionExercise.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    code: text('code').notNull(),
    codeHash: text('code_hash').notNull(),
    /** What the browser reported running it produced. */
    outcome: text('outcome', { mode: 'json' }).$type<unknown>().notNull(),
    /** `passed`, `failed`, `crashed` or `unmarked`. */
    state: text('state').notNull(),
    passedChecks: integer('passed_checks'),
    totalChecks: integer('total_checks').notNull(),
    unmarkedReason: text('unmarked_reason'),
    /** Misconceptions a whole-pattern signal matched. Observed only when this submission counted. */
    misconceptions: text('misconceptions', { mode: 'json' }).$type<string[]>().notNull(),
    /** Hints actually taken before this submission. The truth, whatever the evidence did with it. */
    hintsTaken: integer('hints_taken').notNull(),
    /** True when this submission produced the exercise's evidence. At most one per exercise. */
    counted: integer('counted', { mode: 'boolean' }).notNull(),
    /** `pending`, `given`, `unavailable` or `not-requested`. */
    feedbackStatus: text('feedback_status').notNull(),
    feedback: text('feedback', { mode: 'json' }).$type<unknown>(),
    feedbackStrategyId: text('feedback_strategy_id'),
    feedbackStrategyVersion: text('feedback_strategy_version'),
    feedbackModel: text('feedback_model'),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }).notNull().default(now),
  },
  (table) => [
    unique('exercise_submission_unique_code').on(table.exerciseId, table.codeHash),
    unique('exercise_submission_unique_ordinal').on(table.exerciseId, table.ordinal),
  ],
)

/**
 * Every attempt to prepare a generated exercise, and how it ended.
 *
 * Reportable evidence about generation reliability: how often a model's exercise failed its own
 * checks, solved itself from the starter code, or ran out of time. Content is not recorded here —
 * only which attempt, what happened, and which prompt and model produced it.
 */
export const exerciseGenerationLog = sqliteTable('exercise_generation_log', {
  id: text('id').primaryKey(),
  exerciseId: text('exercise_id')
    .notNull()
    .references(() => sessionExercise.id, { onDelete: 'cascade' }),
  attempt: integer('attempt').notNull(),
  /** `verified`, `rejected`, `invalid`, `unavailable` or `fallback`. */
  outcome: text('outcome').notNull(),
  /** A short code: `reference-fails`, `starter-solves`, `timeout`, `no-report`, and so on. */
  reason: text('reason'),
  strategyVersion: text('strategy_version'),
  model: text('model'),
  at: integer('at', { mode: 'timestamp_ms' }).notNull().default(now),
})
