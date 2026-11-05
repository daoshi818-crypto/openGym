import { describe, expect, it } from 'vitest'
import { lastTimeBefore, setTrend, setTrendOn, setTrendsFor, trendGlyph, trendLabel } from './set-trend.js'

// A saved workout of one exercise, the shape history.js reads back.
const wk = (d, sets, extra = {}) => ({
  id: 'w' + d, d, start: new Date(d + 'T18:00:00').getTime(),
  entries: [{ id: 'bench', target: { mode: 'reps', sets: sets.length, reps: 5, weight: 60 }, sets, ...extra }],
})
const set = (w, r, extra = {}) => ({ w, r, done: true, ...extra })

describe('set trend: one set against the same set last time', () => {
  it('is off only when the profile says so', () => {
    expect(setTrendOn({})).toBe(true)
    expect(setTrendOn({ setTrend: true })).toBe(true)
    expect(setTrendOn({ setTrend: false })).toBe(false)
    expect(setTrendOn(undefined)).toBe(true)
  })

  it('decides on weight first, then reps', () => {
    expect(setTrend(set(62.5, 5), set(60, 5))).toMatchObject({ dir: 1, by: 'w' })
    expect(setTrend(set(60, 6), set(60, 5))).toMatchObject({ dir: 1, by: 'r' })
    expect(setTrend(set(60, 5), set(60, 5))).toMatchObject({ dir: 0 })
    expect(setTrend(set(57.5, 5), set(60, 5))).toMatchObject({ dir: -1, by: 'w' })
  })

  it('settles a heavier-but-fewer set with the estimated 1RM', () => {
    // 70 x 6 estimates above 60 x 8 even though the reps fell.
    expect(setTrend(set(70, 6), set(60, 8), { formula: 'epley' })).toMatchObject({ dir: 1, by: 'e1rm' })
    // Ten kilos off for four more reps is not progress (Epley: 50x12 = 70 against 60x8 = 76).
    expect(setTrend(set(50, 12), set(60, 8), { formula: 'epley' })).toMatchObject({ dir: -1, by: 'e1rm' })
  })

  it('reads an assisted machine the other way round: less help is more', () => {
    expect(setTrend(set(20, 5), set(30, 5), { assisted: true })).toMatchObject({ dir: 1, by: 'w' })
    expect(setTrend(set(35, 5), set(30, 5), { assisted: true })).toMatchObject({ dir: -1, by: 'w' })
  })

  it('compares a hold by its seconds and cardio by minutes then speed', () => {
    expect(setTrend({ sec: 45, done: true }, { sec: 40, done: true }, { mode: 'time' })).toMatchObject({ dir: 1, by: 'sec' })
    expect(setTrend({ min: 20, speed: 10, done: true }, { min: 25, speed: 10, done: true }, { mode: 'cardio' })).toMatchObject({ dir: -1, by: 'min' })
    expect(setTrend({ min: 25, speed: 11, done: true }, { min: 25, speed: 10, done: true }, { mode: 'cardio' })).toMatchObject({ dir: 1, by: 'speed' })
    expect(setTrend({ min: 25, speed: 10, done: true }, { min: 25, speed: 10, done: true }, { mode: 'cardio' })).toMatchObject({ dir: 0 })
  })

  it('says nothing about a warm-up, an empty row or a missing counterpart', () => {
    expect(setTrend(set(60, 5, { phase: 'warmup' }), set(60, 5))).toBeNull()
    expect(setTrend(null, set(60, 5))).toBeNull()
    expect(setTrend(set(0, 0), set(60, 5))).toBeNull()
    expect(setTrend({ w: 60, r: 0, done: true }, { w: 60, r: 5, done: true })).toBeNull()
  })

  it('aligns the arrows with the rows: work set N against work set N', () => {
    const last = { sets: [set(60, 5), set(60, 5), set(60, 4)], target: { mode: 'reps' } }
    const entry = {
      id: 'bench', target: { mode: 'reps' },
      sets: [set(40, 10, { phase: 'warmup' }), set(62.5, 5), set(62.5, 5), set(62.5, 5, { done: false }), set(60, 3)],
    }
    const tr = setTrendsFor(entry, last, { formula: 'epley' })
    expect(tr).toHaveLength(5)
    expect(tr[0]).toBeNull()                       // a warm-up is never marked
    expect(tr[1]).toMatchObject({ dir: 1, by: 'w' })  // work set 1: 62.5 beats 60
    expect(tr[2]).toMatchObject({ dir: 1, by: 'w' })  // work set 2: the same
    expect(tr[3]).toBeNull()                       // not done yet
    // A fourth work set has no counterpart in a session of three: nothing is invented for it.
    expect(tr[4]).toBeNull()
  })

  it('has nothing to say without a last time, or across modes', () => {
    const entry = { id: 'bench', target: { mode: 'reps' }, sets: [set(60, 5)] }
    expect(setTrendsFor(entry, null)).toEqual([null])
    expect(setTrendsFor(entry, { sets: [], target: { mode: 'reps' } })).toEqual([null])
    const hold = { id: 'bench', target: { mode: 'time' }, sets: [{ sec: 30, done: true }] }
    expect(setTrendsFor(hold, { sets: [set(60, 5)], target: { mode: 'reps' } })).toEqual([null])
  })

  it('reads last time from before the workout itself, never a later one', () => {
    const older = wk('2026-10-01', [set(60, 5)])
    const today = wk('2026-10-08', [set(62.5, 5)])
    const later = wk('2026-10-15', [set(80, 5)])
    const S = { workouts: [older, today, later] }
    const entry = today.entries[0]
    const last = lastTimeBefore(S, today, entry)
    expect(last.d).toBe('2026-10-01')
    expect(setTrendsFor(entry, last, { formula: 'epley' })[0]).toMatchObject({ dir: 1, by: 'w' })
  })

  it('draws an arrow and says the same thing in words', () => {
    expect(trendGlyph({ dir: 1 })).toBe('↑')
    expect(trendGlyph({ dir: 0 })).toBe('=')
    expect(trendGlyph({ dir: -1 })).toBe('↓')
    expect(trendGlyph(null)).toBe('')
    expect(trendLabel({ dir: 1, by: 'w', delta: 2.5 }, 'kg')).toBe('2.5 kg more than last time')
    expect(trendLabel({ dir: -1, by: 'w', delta: -2.5 }, 'kg')).toBe('2.5 kg less than last time')
    expect(trendLabel({ dir: 1, by: 'w', delta: -5 }, 'kg')).toBe('5 kg less help than last time')
    expect(trendLabel({ dir: 1, by: 'r', delta: 2 }, 'kg')).toBe('2 more reps than last time')
    expect(trendLabel({ dir: -1, by: 'r', delta: -1 }, 'kg')).toBe('1 rep fewer than last time')
    expect(trendLabel({ dir: 0, by: 'w', delta: 0 }, 'kg')).toBe('Same as last time')
    expect(trendLabel({ dir: 1, by: 'e1rm', delta: 3 })).toBe('Better estimated 1RM than last time')
    expect(trendLabel({ dir: -1, by: 'sec', delta: -5 })).toBe('0:05 shorter than last time')
    expect(trendLabel({ dir: 1, by: 'min', delta: 2 })).toBe('2 min longer than last time')
    expect(trendLabel({ dir: -1, by: 'speed', delta: -0.5 })).toBe('Slower than last time')
    expect(trendLabel(null)).toBe('')
  })
})
