import { createDb, runMigrations, type Db } from './client'

/**
 * Process-wide database handle.
 *
 * Next.js keeps modules alive across requests in a single dev/server process, so the
 * connection and the migration run happen once rather than per request. Tests build
 * their own throwaway database with `createDb(':memory:')` instead of using this.
 */
let instance: Db | null = null

export function getDb(): Db {
  if (instance === null) {
    instance = createDb()
    runMigrations(instance)
  }
  return instance
}
