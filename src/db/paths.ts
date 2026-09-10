/**
 * Database location, kept in its own module so that tooling (drizzle-kit) can read it
 * without pulling in the native SQLite driver or any server-only code.
 */

/** Where the learner's data lives when `DATABASE_PATH` is not set. */
export const DEFAULT_DATABASE_PATH = 'data/tutor.db'

/** Generated migrations, relative to the repository root. */
export const MIGRATIONS_FOLDER = 'drizzle'
