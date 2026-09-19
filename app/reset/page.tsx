import { redirect } from 'next/navigation'

/**
 * The old address for deleting everything.
 *
 * Reset now lives with the rest of the learner's data, under Settings, where taking a copy sits
 * next to deleting it. This is kept so that a bookmark, or a page open from before the move,
 * still lands somewhere sensible rather than on a missing page.
 */
export default function ResetPage() {
  redirect('/settings')
}
