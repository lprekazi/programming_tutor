import { redirect } from 'next/navigation'

import { getDb } from '@/db/instance'
import { requestNow } from '@/db/request-time'
import { ensureLearner, readProfile } from '@/db/repositories/learner-repository'

/**
 * Where a learner lands.
 *
 * There is no front door to this application — it is for one person, on their own machine, and
 * they are always somewhere in the middle of something. So the root sends them to wherever
 * that is: partway through onboarding, partway through the diagnostic, or home.
 */
export const dynamic = 'force-dynamic'

export default function RootPage() {
  const db = getDb()
  ensureLearner(db, requestNow())
  const profile = readProfile(db)

  if (profile === null || !profile.onboardingComplete) redirect('/welcome')
  if (!profile.diagnosticComplete) redirect('/diagnostic')
  redirect('/home')
}
