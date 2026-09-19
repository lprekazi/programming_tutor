/**
 * The word the learner must type before their history is deleted.
 *
 * Its own module because a `'use server'` file may export only async functions, and both the
 * page that asks for it and the action that checks it must agree on the same string.
 *
 * Upper case, and compared exactly. A word that has to be typed deliberately is the whole
 * mechanism here: a dialog is dismissed by reflex, and "start again" in lower case is close
 * enough to something somebody might type without meaning it.
 */
export const RESET_CONFIRMATION = 'RESET'
