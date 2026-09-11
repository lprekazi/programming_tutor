/**
 * The words the learner must type before their history is deleted.
 *
 * Its own module because a `'use server'` file may export only async functions, and both the
 * page that asks for it and the action that checks it must agree on the same string.
 */
export const RESET_CONFIRMATION = 'start again'
