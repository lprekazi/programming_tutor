import { cache } from 'react'

/**
 * The moment this request is being handled.
 *
 * Server components render once per request here — every page in the application is
 * `force-dynamic` — but "once" is not something a component may assume, and a component that
 * reads the clock twice and gets two answers is not idempotent. `cache` fixes that properly
 * rather than by convention: within a single render pass every caller sees the same instant,
 * so the timestamp stamped on a learner row and the one used to decide what is due for review
 * cannot disagree with each other by a few milliseconds.
 */
export const requestNow = cache((): number => Date.now())
