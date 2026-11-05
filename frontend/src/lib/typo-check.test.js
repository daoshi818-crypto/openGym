import { describe, expect, it } from 'vitest'
import { bestsFor, lastRowFor, oddValues } from './typo-check.js'

// #811: one question before a slip of a digit becomes last time's numbers, the next target and
// maybe a PR. The fork's shapes: a per-side set is one row with `sides`, warm-ups are `phase`.
const set = (w, r, extra = {}) => ({ w, r, done: true, ...extra })
const workouts = (...sets) => [{ d: '2026-10-01', entries: [{ id: 'bench', sets }] }]

describe('typo check: what looks mistyped', () => {
  it('reads the best weight and the most reps ever logged for one exercise', () => {
    const w = [
      { d: '2026-10-01', entries: [{ id: 'bench', sets: [set(100, 5), set(90, 8)] }, { id: 'row', sets: [set(80, 12)] }] },
      { d: '2026-10-08', entries: [{ id: 'bench', sets: [set(102.5, 3, { phase: 'warmup' })] }] },
    ]
    expect(bestsFor(w, 'bench')).toEqual({ w: 102.5, r: 8 })
    expect(bestsFor(w, 'nothing')).toEqual({ w: 0, r: 0 })
    expect(bestsFor(undefined, 'bench')).toEqual({ w: 0, r: 0 })
  })

  it('reads a per-side set as both of its sides', () => {
    const w = [{ d: '2026-10-01', entries: [{ id: 'curl', sets: [
      { done: true, sides: { L: { w: 14, r: 8, done: true }, R: { w: 12, r: 10, done: true } } },
    ] }] }]
    expect(bestsFor(w, 'curl')).toEqual({ w: 14, r: 10 })
  })

  it('holds up last time\'s same set, warm-ups against warm-ups', () => {
    const sets = [set(40, 10, { phase: 'warmup' }), set(100, 5), set(100, 5), set(100, 5)]
    const last = [set(40, 10, { phase: 'warmup' }), set(95, 5), set(95, 5), set(95, 5)]
    // Second warm-up has no counterpart in a session of one warm-up.
    expect(lastRowFor(last, sets, 0)).toMatchObject({ w: 40 })
    expect(lastRowFor(last, sets, 2)).toMatchObject({ w: 95 })
    expect(lastRowFor(last, sets, 9)).toBeNull()
    expect(lastRowFor([], sets, 1)).toBeNull()
  })

  it('never guesses across a shape change', () => {
    // Today per side, last time a plain row: nothing honest to hold it against.
    const last = [set(95, 5)]
    const sets = [{ done: false, sides: { L: { w: 20, r: 5 }, R: { w: 20, r: 5 } } }]
    expect(lastRowFor(last, sets, 0, 'L')).toBeNull()
    expect(lastRowFor(sets, last, 0)).toBeNull()
    // A side against its own side does work.
    const sideLast = [{ done: true, sides: { L: { w: 20, r: 5, done: true }, R: { w: 20, r: 5, done: true } } }]
    expect(lastRowFor(sideLast, sets, 0, 'L')).toMatchObject({ w: 20 })
  })

  it('questions a weight over twice the best, by a real margin', () => {
    const best = { w: 30, r: 5 }
    expect(oddValues(set(300, 5), best)).toEqual([{ f: 'w', typed: 300, ref: 30 }])
    // 10 kg on a best of 4 kg is a beginner's first week, not a typo.
    expect(oddValues(set(10, 2), { w: 4, r: 2 })).toEqual([])
    // Just under twice is not the rule.
    expect(oddValues(set(55, 5), best)).toEqual([])
    // In pounds the margin is 20.
    expect(oddValues(set(70, 5), { w: 30, r: 5 }, { unit: 'lb' })).toEqual([{ f: 'w', typed: 70, ref: 30 }])
  })

  it('questions a weight a third under the same set last time', () => {
    expect(oddValues(set(20, 5), { w: 0, r: 0 }, { last: set(100, 5) }))
      .toEqual([{ f: 'w', typed: 20, ref: 100, low: true }])
    expect(oddValues(set(60, 5), { w: 0, r: 0 }, { last: set(100, 5) })).toEqual([])
  })

  it('questions reps the same way, with its own margins', () => {
    expect(oddValues({ w: 0, r: 80 }, { w: 0, r: 8 })).toEqual([{ f: 'r', typed: 80, ref: 8 }])
    expect(oddValues({ w: 0, r: 3 }, { w: 0, r: 0 }, { last: { w: 0, r: 12 } }))
      .toEqual([{ f: 'r', typed: 3, ref: 12, low: true }])
    // Eight more reps than ever is a good session, not a slip.
    expect(oddValues({ w: 0, r: 16 }, { w: 0, r: 8 })).toEqual([])
  })

  it('leaves an assisted machine\'s weight alone, and checks nothing on a first time', () => {
    expect(oddValues(set(120, 5), { w: 30, r: 5 }, { assisted: true })).toEqual([])
    expect(oddValues(set(300, 5), { w: 30, r: 5 }, { assisted: true, last: set(20, 5) })).toEqual([])
    expect(oddValues(set(300, 5), { w: 0, r: 0 })).toEqual([])
    expect(oddValues({ sec: 60, w: 0 }, { w: 100, r: 5 })).toEqual([])
  })
})
