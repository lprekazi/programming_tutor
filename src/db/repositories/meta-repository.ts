import { eq, sql } from 'drizzle-orm'

import type { Db, DbOrTx } from '../client'
import { appMeta, learner } from '../schema'
import { LEARNER_ID } from './learner-repository'

/**
 * The installation's own row, and the deletion that uses it.
 *
 * `dataGeneration` exists for one problem: a browser tab open when the learner deletes
 * everything. Its page was rendered against data that no longer exists, but the forms on it
 * still work, and the server actions behind them would write into the fresh profile — putting
 * back a piece of exactly what was deliberately destroyed. M3's review found this in the
 * onboarding form and fixed that one case; this is the general rule (ADR-0034).
 *
 * The mechanism is the smallest one that is actually robust: a counter that survives the
 * deletion, rendered into every page that can write, and checked by the writes that are not
 * already anchored to a row the deletion removed. Nothing about it depends on the browser
 * behaving, on a cookie, or on a timer.
 */

const META_ID = 1

/** Creates the meta row if it is missing. Safe to call repeatedly. */
export function ensureMeta(db: DbOrTx): void {
  db.insert(appMeta).values({ id: META_ID }).onConflictDoNothing({ target: appMeta.id }).run()
}

/** The generation pages are currently being served against. */
export function readDataGeneration(db: DbOrTx): number {
  ensureMeta(db)
  const [row] = db.select().from(appMeta).where(eq(appMeta.id, META_ID)).all()
  return row?.dataGeneration ?? 1
}

/** When the learner last deleted everything, if they ever have. */
export function readLastResetAt(db: Db): number | null {
  ensureMeta(db)
  const [row] = db.select().from(appMeta).where(eq(appMeta.id, META_ID)).all()
  return row?.lastResetAt?.getTime() ?? null
}

/**
 * Whether a write carrying `generation` is writing against the data it was rendered against.
 *
 * An unknown or malformed value is stale: a write that cannot say which generation it belongs
 * to is exactly the one this is here to stop.
 */
export function generationIsCurrent(db: DbOrTx, generation: unknown): boolean {
  return typeof generation === 'number' && Number.isInteger(generation) && generation === readDataGeneration(db)
}

/**
 * Deletes the learner and everything that hangs off them, and moves the generation on.
 *
 * One transaction, so there is no moment where the data is gone and the counter has not
 * advanced — which would be the one moment a stale tab could write into a fresh profile
 * undetected. Everything else goes by cascade from `learner`, which is what keeps this honest:
 * a table added later that hangs off the learner is deleted without anybody remembering to
 * come back here.
 *
 * Idempotent. Resetting an installation that has nothing in it deletes nothing, still advances
 * the generation, and is not an error.
 */
export function resetEverything(db: Db, at: number): { readonly generation: number } {
  return db.transaction((tx) => {
    ensureMeta(tx)
    tx.delete(learner).where(eq(learner.id, LEARNER_ID)).run()
    tx.update(appMeta)
      .set({ dataGeneration: sql`${appMeta.dataGeneration} + 1`, lastResetAt: new Date(at) })
      .where(eq(appMeta.id, META_ID))
      .run()

    const [row] = tx.select().from(appMeta).where(eq(appMeta.id, META_ID)).all()
    return { generation: row?.dataGeneration ?? 1 }
  })
}
