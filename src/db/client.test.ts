import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, createDb, runMigrations, type Db } from './client'
import { learner } from './schema'

describe('database', () => {
  let directory: string
  let db: Db

  beforeEach(() => {
    // A real file rather than :memory: so the test exercises the same path the
    // application uses, including directory creation and WAL mode.
    directory = mkdtempSync(join(tmpdir(), 'tutor-db-'))
    db = createDb(join(directory, 'tutor.db'))
    runMigrations(db)
  })

  afterEach(() => {
    // Windows keeps an exclusive lock on an open database file, so the connection must
    // be closed before the directory can be removed.
    closeDb(db)
    rmSync(directory, { recursive: true, force: true })
  })

  it('applies migrations and starts with no learner', () => {
    expect(db.select().from(learner).all()).toEqual([])
  })

  it('round-trips a learner row', () => {
    const createdAt = new Date('2026-01-15T09:30:00.000Z')
    db.insert(learner).values({ id: 1, createdAt, updatedAt: createdAt }).run()

    const rows = db.select().from(learner).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(1)
    expect(rows[0]?.createdAt).toEqual(createdAt)
  })

  it('is single-profile: a second learner with the same id is rejected', () => {
    const now = new Date()
    db.insert(learner).values({ id: 1, createdAt: now, updatedAt: now }).run()

    expect(() => {
      db.insert(learner).values({ id: 1, createdAt: now, updatedAt: now }).run()
    }).toThrow(/UNIQUE constraint failed/)
  })

  it('is idempotent when migrations are applied twice', () => {
    expect(() => {
      runMigrations(db)
    }).not.toThrow()
  })
})
