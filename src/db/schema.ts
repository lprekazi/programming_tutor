import { sql } from 'drizzle-orm'
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'

/**
 * The single local learner.
 *
 * The application is deliberately single-profile: there is no authentication and no
 * multi-user support, so this table holds exactly one row, created on first run.
 * Later milestones extend it with goals and onboarding state.
 */
export const learner = sqliteTable('learner', {
  id: integer('id').primaryKey({ autoIncrement: false }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

export type Learner = typeof learner.$inferSelect
export type NewLearner = typeof learner.$inferInsert
