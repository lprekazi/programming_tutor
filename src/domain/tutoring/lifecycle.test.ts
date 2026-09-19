import { describe, expect, it } from 'vitest'

import { MILLISECONDS_PER_DAY } from '../learner-model/parameters'
import { DORMANT_AFTER_DAYS, isMidLesson, lifecycleOf, MID_LESSON_MS } from './lifecycle'
import { turnsInSitting, type Turn } from './session'

const NOW = Date.parse('2026-09-19T12:00:00.000Z')

const days = (count: number) => NOW - count * MILLISECONDS_PER_DAY

describe('a session’s standing', () => {
  it('is completed once the learner has finished with it, however recently it was touched', () => {
    expect(lifecycleOf({ updatedAt: NOW, closedAt: NOW }, NOW)).toBe('completed')
  })

  it('is active while it is being worked on', () => {
    expect(lifecycleOf({ updatedAt: NOW, closedAt: null }, NOW)).toBe('active')
    expect(lifecycleOf({ updatedAt: days(DORMANT_AFTER_DAYS), closedAt: null }, NOW)).toBe('active')
  })

  it('goes dormant once it has been left alone long enough', () => {
    expect(lifecycleOf({ updatedAt: days(DORMANT_AFTER_DAYS + 1), closedAt: null }, NOW)).toBe('dormant')
  })

  it('treats a clock that moved backwards as an open session rather than a stale one', () => {
    expect(lifecycleOf({ updatedAt: NOW + MILLISECONDS_PER_DAY, closedAt: null }, NOW)).toBe('active')
    expect(lifecycleOf({ updatedAt: Number.NaN, closedAt: null }, NOW)).toBe('active')
  })
})

describe('being mid-lesson', () => {
  it('holds for a short break and not for yesterday', () => {
    expect(isMidLesson({ updatedAt: NOW - MID_LESSON_MS + 1000, closedAt: null }, NOW)).toBe(true)
    expect(isMidLesson({ updatedAt: NOW - MID_LESSON_MS - 1000, closedAt: null }, NOW)).toBe(false)
    expect(isMidLesson({ updatedAt: days(1), closedAt: null }, NOW)).toBe(false)
  })

  it('is never true of a session the learner has finished', () => {
    expect(isMidLesson({ updatedAt: NOW, closedAt: NOW - 1000 }, NOW)).toBe(false)
  })
})

describe('the turns of one sitting', () => {
  const turn = (ordinal: number, createdAt: number, role: Turn['role'] = 'tutor'): Turn => ({
    id: `t${String(ordinal)}`,
    ordinal,
    role,
    text: '',
    status: 'complete',
    createdAt,
  })

  it('are the ones created since the learner sat down, not the whole conversation', () => {
    const turns = [turn(0, days(20)), turn(1, days(20), 'learner'), turn(2, days(20), 'activity'), turn(3, NOW)]

    expect(turnsInSitting(turns, NOW - 60_000).map((each) => each.ordinal)).toEqual([3])
  })

  /*
   * M7 review finding H1. Read over the whole conversation, the last turn of a sitting three
   * weeks ago decided what could happen in this one: a learner who had ended that sitting by
   * answering a question was refused this sitting's first question as "just asked".
   */
  it('leave an opening sitting empty, whatever ended the last one', () => {
    const turns = [turn(0, days(20)), turn(1, days(20), 'activity')]

    expect(turnsInSitting(turns, NOW)).toEqual([])
  })

  it('fall back to the whole conversation rather than hiding it, if the clock is unreadable', () => {
    const turns = [turn(0, days(1))]

    expect(turnsInSitting(turns, Number.NaN)).toHaveLength(1)
  })
})
