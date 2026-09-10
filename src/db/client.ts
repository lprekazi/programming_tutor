import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { DEFAULT_DATABASE_PATH, MIGRATIONS_FOLDER } from './paths'
import * as schema from './schema'

export type Db = ReturnType<typeof createDb>

/**
 * Opens a SQLite database and returns a typed Drizzle client.
 *
 * `:memory:` is accepted so that tests can run against a throwaway database with the
 * same schema and the same migration path as the real one.
 */
export function createDb(path: string = process.env['DATABASE_PATH'] ?? DEFAULT_DATABASE_PATH) {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true })
  }

  const sqlite = new Database(path)
  // WAL keeps reads from blocking during a write; foreign keys are off by default in
  // SQLite and must be enabled per connection.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  return drizzle(sqlite, { schema })
}

/** Applies any pending migrations. Safe to call repeatedly. */
export function runMigrations(db: Db, migrationsFolder: string = MIGRATIONS_FOLDER): void {
  migrate(db, { migrationsFolder })
}

/**
 * Closes the underlying SQLite connection.
 *
 * Windows holds an exclusive lock on an open database file, so anything that creates a
 * temporary database — tests especially — must close it before deleting the file.
 */
export function closeDb(db: Db): void {
  db.$client.close()
}
