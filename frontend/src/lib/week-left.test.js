import { describe, expect, it } from 'vitest'
import { WEEK_TARGET_MAX, weekTargetOf, workoutsLeft } from './week-left.js'

// #753, adapted: Home counts the week down. A fixed week uses the streak card's own fraction
// (queue.js weekTally), so the two lines never disagree; a rotation has no week of its own and
// counts against its own target, or says nothing when there is none.
const S = (extra = {}) => ({
  unit: 'kg', weekStart: 1, week: {}, routines: [], workouts: [], queue: null, rotation: null,
  ...extra,
})

const routine = id => ({ id, name: id, emoji: 'x', ex: [{ id: '0025' }] })
const workout = d => ({ id: 'w' + d, d, start: new Date(d + 'T18:00:00').getTime(), entries: [] })

describe('workouts left this week', () => {
  it('reads a weekly target only between 1 and 7', () => {
    expect(WEEK_TARGET_MAX).toBe(7)
    expect(weekTargetOf({ weekTarget: 4 })).toBe(4)
    expect(weekTargetOf({ weekTarget: '3' })).toBe(3)
    expect(weekTargetOf({ weekTarget: 0 })).toBeNull()
    expect(weekTargetOf({ weekTarget: 8 })).toBeNull()
    expect(weekTargetOf({})).toBeNull()
    expect(weekTargetOf({ weekTarget: 'lots' })).toBeNull()
  })

  it('says nothing when no week is planned', () => {
    expect(workoutsLeft(S(), '2026-11-04')).toBeNull()
    expect(workoutsLeft(null, '2026-11-04')).toBeNull()
  })

  it('counts a fixed week down from its planned days', () => {
    // Monday (2026-11-02) and Thursday (2026-11-05) planned; one workout logged on the Monday.
    const st = S({
      routines: [routine('a'), routine('b')],
      week: { 1: ['a'], 4: ['b'] },
      workouts: [workout('2026-11-02')],
    })
    expect(workoutsLeft(st, '2026-11-04')).toEqual({ left: 1, of: 2, done: 1 })
    // The whole week done: nothing left, and Home says so.
    expect(workoutsLeft({ ...st, workouts: [workout('2026-11-02'), workout('2026-11-05')] }, '2026-11-06'))
      .toEqual({ left: 0, of: 2, done: 2 })
  })

  it('does not count last week\'s workouts', () => {
    const st = S({
      routines: [routine('a')],
      week: { 1: ['a'] },
      workouts: [workout('2026-10-26'), workout('2026-10-29')],
    })
    expect(workoutsLeft(st, '2026-11-04')).toEqual({ left: 1, of: 1, done: 0 })
  })

  it('counts a rotation against its own target', () => {
    const queue = { id: 'q1', rotationId: 'rot1', startsOn: '2026-10-01', ids: ['a', 'b', 'c'], cur: 0 }
    const st = S({
      routines: [routine('a'), routine('b'), routine('c')],
      queue, rotation: { id: 'rot1', ids: ['a', 'b', 'c'], cur: 0 },
      workouts: [workout('2026-11-02'), workout('2026-11-03')],
      weekTarget: 4,
    })
    expect(workoutsLeft(st, '2026-11-04')).toEqual({ left: 2, of: 4, done: 2 })
  })

  it('stays quiet about a rotation with no target, and never goes below zero', () => {
    const queue = { id: 'q1', rotationId: 'rot1', startsOn: '2026-10-01', ids: ['a', 'b', 'c'], cur: 0 }
    const base = { routines: [routine('a'), routine('b'), routine('c')], queue, rotation: { id: 'rot1', ids: ['a', 'b', 'c'], cur: 0 } }
    expect(workoutsLeft(S({ ...base, workouts: [workout('2026-11-02')] }), '2026-11-04')).toBeNull()
    expect(workoutsLeft(S({ ...base, weekTarget: 1, workouts: [workout('2026-11-02'), workout('2026-11-03')] }), '2026-11-04'))
      .toEqual({ left: 0, of: 1, done: 2 })
  })

  it('follows the profile\'s first weekday', () => {
    // 2026-11-01 is a Sunday and 2026-11-02 a Monday, so one profile counts both in the week of
    // Tuesday the 3rd and the other counts only the Monday one.
    const days = { routines: [routine('a')], week: { 2: ['a'] }, workouts: [workout('2026-11-01'), workout('2026-11-02')] }
    // Sunday start: the week runs Sun 1 -> Sat 7, so both workouts are in it.
    expect(workoutsLeft(S({ ...days, weekStart: 0 }), '2026-11-03')).toEqual({ left: 0, of: 1, done: 2 })
    // Monday start: the week runs Mon 2 -> Sun 8, so the Sunday before it is last week's.
    expect(workoutsLeft(S({ ...days, weekStart: 1 }), '2026-11-03')).toEqual({ left: 0, of: 1, done: 1 })
  })
})
