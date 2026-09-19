import { getDb } from '@/db/instance'
import { readExportInput } from '@/db/repositories/export-repository'
import { readProfile } from '@/db/repositories/learner-repository'
import { buildExportDocument, exportFilename } from '@/domain/export/document'

/**
 * The learner's own data, as a file they can keep.
 *
 * A route handler rather than a server action, because the result is a download: a file with a
 * name and a content type, which an action's return value is not.
 *
 * Reads only. Nothing here creates a learner row, a diagnostic session or anything else — a
 * request for a copy of your data must not be the thing that starts a profile.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(): Response {
  const db = getDb()

  // Nothing to export before the first run has begun. Said plainly rather than as an empty file
  // the learner would have to open to discover it was empty.
  if (readProfile(db) === null) {
    return Response.json({ error: 'There is nothing recorded on this machine yet.' }, { status: 404 })
  }

  const exportedAt = Date.now()

  try {
    const document = buildExportDocument(readExportInput(db, exportedAt))

    return new Response(JSON.stringify(document, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFilename(exportedAt)}"`,
        // A copy of a changing record: never served from a cache.
        'cache-control': 'no-store',
      },
    })
  } catch {
    /*
     * A failed export is a failed read, and the learner can try again. What matters is that it
     * says so rather than sending a half-written file that looks like a complete record of
     * somebody's learning.
     */
    return Response.json(
      { error: 'Your data could not be collected just now. Nothing has been changed.' },
      { status: 500 },
    )
  }
}
