import { describe, expect, it } from 'vitest'
import { watchLastTimeOf } from './watch-last-time.js'
import { watchExercisesOf } from './watch-workout.js'
import { setLabel } from './history.js'
import { EXDB } from './exercises.js'

// Real ids out of the shipped catalogue: the mode (reps / time / cardio / bodyweight) has to come
// out of the real lookup, or these labels would be tested against a made-up exercise.
const LIFT = EXDB.find(e => e.bp !== 'cardio' && e.eq !== 'body weight' && e.eq !== 'dumbbell').id
const SECOND = EXDB.find(e => e.bp !== 'cardio' && e.eq !== 'body weight' && e.id !== LIFT).id
const CARDIO = EXDB.find(e => e.bp === 'cardio').id
const BW = EXDB.find(e => e.eq === 'body weight').id
// Two bells, so "each" and "total" are actually different numbers.
const BELL = EXDB.find(e => e.eq === 'dumbbell' && !/\b(one|single)[- ]?(arm|hand|handed)\b/i.test(e.n)).id

// One saved session entry: the shape lastEntryFor reads (id, rid, target, done sets).
const en = (id, rid, sets, target = { sets: sets.length, reps: 10, weight: 60 }) =>
  ({ id, ...(rid ? { rid } : {}), target, sets })
const wk = (d, entries, extra = {}) => ({ d, entries, ...extra })

describe('watchLastTimeOf — which session counts', () => {
  const S = {
    unit: 'kg',
    workouts: [
      wk('2026-01-01', [en(LIFT, 'A', [{ w: 60, r: 10, done: true }, { w: 60, r: 8, done: true }])], { routineIds: ['A'] }),
      wk('2026-01-03', [en(LIFT, 'B', [{ w: 40, r: 15, done: true }])], { routineIds: ['B'] }),
    ],
  }

  it('takes the same routine\'s session even when another routine trained it later', () => {
    const last = watchLastTimeOf(S, { id: LIFT }, 'A')
    expect(last).toMatchObject({ date: '2026-01-01', sourceRoutineId: 'A', weightUnit: 'kg' })
    expect(last.rows).toEqual([{ label: '60×10' }, { label: '60×8' }])
  })

  it('falls back to the exercise\'s own last session when the routine never trained it', () => {
    const last = watchLastTimeOf(S, { id: LIFT }, 'C')
    expect(last).toMatchObject({ date: '2026-01-03', sourceRoutineId: 'B' })
    expect(last.rows).toEqual([{ label: '40×15' }])
  })

  it('lets the entry\'s own rid win over the caller\'s default routine', () => {
    expect(watchLastTimeOf(S, { id: LIFT, rid: 'B' }, 'A')).toMatchObject({ date: '2026-01-03' })
  })

  it('has nothing to show for an exercise that was never trained', () => {
    expect(watchLastTimeOf(S, { id: SECOND }, 'A')).toBeNull()
    // No id at all (a freestyle row): no history key to read.
    expect(watchLastTimeOf(S, { name: 'Whatever' }, 'A')).toBeNull()
  })
})

describe('watchLastTimeOf — what counts as a work set', () => {
  it('drops warm-ups, unfinished rows and excluded sessions, keeping the original order', () => {
    const S = {
      unit: 'kg',
      workouts: [
        wk('2026-01-01', [en(LIFT, null, [{ warmup: true, w: 40, r: 10, done: true },
          { w: 60, r: 10, done: true }, { w: 60, r: 9, done: true }, { w: 60, r: 8, done: false }])]),
        // A session that does not count is not "last time": it must not replace the one above.
        wk('2026-01-05', [{ id: LIFT, noProg: true, target: { sets: 1 }, sets: [{ w: 30, r: 12, done: true }] }]),
      ],
    }
    const last = watchLastTimeOf(S, { id: LIFT })
    expect(last.date).toBe('2026-01-01')
    expect(last.rows).toEqual([{ label: '60×10' }, { label: '60×9' }])
    expect(last.text).toBe('60×10，60×9')
  })

  it('skips a whole excluded workout and a deload freezes its own entry out', () => {
    const S = {
      unit: 'kg',
      workouts: [
        wk('2026-01-01', [en(LIFT, null, [{ w: 60, r: 8, done: true }])]),
        wk('2026-01-04', [en(LIFT, null, [{ w: 30, r: 12, done: true }])], { excludeFromProgression: true }),
      ],
    }
    expect(watchLastTimeOf(S, { id: LIFT }).rows).toEqual([{ label: '60×8' }])
  })

  it('never borrows the identity of a same-named exercise with another id', () => {
    const S = { unit: 'kg', workouts: [wk('2026-01-01', [en(LIFT, null, [{ w: 60, r: 8, done: true }])])] }
    expect(watchLastTimeOf(S, { id: SECOND })).toBeNull()
  })

  it('carries no record/PR field — the payload is a set list, not a best-of', () => {
    const S = { unit: 'kg', workouts: [wk('2026-01-01', [en(LIFT, null, [{ w: 100, r: 5, done: true }])])] }
    expect(Object.keys(watchLastTimeOf(S, { id: LIFT })).sort())
      .toEqual(['date', 'rows', 'sourceRoutineId', 'text', 'weightUnit'])
  })
})

describe('watchLastTimeOf — backfill and edits look only backwards', () => {
  const workouts = [
    wk('2026-01-01', [en(LIFT, null, [{ w: 60, r: 8, done: true }])]),
    wk('2026-01-05', [en(LIFT, null, [{ w: 70, r: 8, done: true }])]),
  ]

  it('reads a workout logged into the past as of its own day, not from later sessions', () => {
    const S = { unit: 'kg', workouts, active: { start: 1, d: '2026-01-03', backfill: { durationMin: 60 } } }
    expect(watchLastTimeOf(S, { id: LIFT })).toMatchObject({ date: '2026-01-01' })
  })

  it('leaves the workout being edited out of its own history', () => {
    const editing = wk('2026-01-05', [en(LIFT, null, [{ w: 70, r: 8, done: true }])], { id: 'w5', start: 500 })
    const S = { unit: 'kg', workouts: [workouts[0], editing], active: { start: 500, d: '2026-01-05', editingWorkoutId: 'w5' } }
    expect(watchLastTimeOf(S, { id: LIFT })).toMatchObject({ date: '2026-01-01' })
  })
})

describe('watchLastTimeOf — units and per-mode formatting', () => {
  it('does not convert kg/lb a second time — the history is already in the profile\'s unit', () => {
    const S = { unit: 'lb', workouts: [wk('2026-01-01', [en(LIFT, null, [{ w: 135, r: 8, done: true }])])] }
    const last = watchLastTimeOf(S, { id: LIFT })
    expect(last.weightUnit).toBe('lb')
    expect(last.rows).toEqual([{ label: '135×8' }])
  })

  it('reads a dumbbell history in the meaning the exercise is logged in today', () => {
    // Logged as "40 total", now trained "each": the number has to say 20 each, not 40.
    const S = { unit: 'kg', workouts: [wk('2026-01-01', [{ id: BELL, target: { sets: 2, reps: 8, dbLoad: 'total' },
      sets: [{ w: 40, r: 8, done: true }] }])] }
    const last = watchLastTimeOf(S, { id: BELL, target: { dbLoad: 'each' } })
    expect(last.rows[0].label).toBe(setLabel(BELL, { w: 20, r: 8, done: true }, { id: BELL, dbLoad: 'each' }))
    expect(last.rows[0].label).toContain('each')
  })

  it('keeps setLabel\'s own wording for timed, cardio, bodyweight and rated sets', () => {
    const S = {
      unit: 'kg',
      workouts: [wk('2026-01-01', [
        { id: LIFT, target: { sets: 2, reps: 10, weight: 60 }, sets: [{ w: 60, r: 10, rir: 0, done: true }] },
        { id: CARDIO, target: { sets: 1, min: 20, speed: 9 }, sets: [{ min: 20, speed: 9, done: true }] },
        { id: BW, target: { sets: 1, reps: 12, bodyweight: true }, sets: [{ w: 0, r: 12, done: true }] },
      ]) ],
    }
    const rated = watchLastTimeOf(S, { id: LIFT })
    expect(rated.rows[0].label).toBe(setLabel(LIFT, { w: 60, r: 10, rir: 0, done: true }, { sets: 2, reps: 10, weight: 60 }))
    // A logged RIR 0 travels as the text "(RIR 0)" and never becomes this session's draft.
    expect(rated.rows[0].label).toContain('RIR 0')
    const cardio = watchLastTimeOf(S, { id: CARDIO })
    expect(cardio.rows[0].label).toBe('20 min @ 9 km/h')
    const bw = watchLastTimeOf(S, { id: BW })
    expect(bw.rows[0].label).toBe(setLabel(BW, { w: 0, r: 12, done: true }, { sets: 1, reps: 12, bodyweight: true }))
  })

  it('dates a record that has no day as null rather than today', () => {
    const S = { unit: 'kg', workouts: [{ entries: [en(LIFT, null, [{ w: 60, r: 8, done: true }])] }] }
    expect(watchLastTimeOf(S, { id: LIFT }).date).toBeNull()
  })
})

describe('watchLastTimeOf — read-only and safe', () => {
  it('leaves the store and the entry byte-identical', () => {
    const S = {
      unit: 'kg', unit2: { nested: ['x'] },
      workouts: [wk('2026-01-01', [en(LIFT, 'A', [{ w: 60, r: 8, done: true }])], { routineIds: ['A'] })],
      active: { start: 5, name: 'Today', entries: [] },
    }
    const entry = { id: LIFT, rid: 'A', sets: [{ w: 62.5, r: 8, done: false }], target: { sets: 3, reps: 8, weight: 62.5 } }
    const before = structuredClone({ S, entry })
    watchLastTimeOf(S, entry, 'A')
    expect({ S, entry }).toEqual(before)
  })

  it('turns a broken history into "no last time" instead of failing the plan build', () => {
    const broken = { unit: 'kg', workouts: [{ d: '2026-01-01', entries: [{ id: LIFT, target: {}, sets: 'not an array' }] }] }
    expect(watchLastTimeOf(broken, { id: LIFT })).toBeNull()
    expect(watchExercisesOf(broken, [{ id: LIFT, sets: [{ w: 60, r: 8 }] }]).map(e => [e.name, e.lastTime]))
      .toEqual([[expect.any(String), null]])

    // One unformattable row is skipped; the rest of the session still reads out.
    const partly = { unit: 'kg', workouts: [wk('2026-01-01', [en(LIFT, null, [
      { w: 60, r: 8, done: true },
      // A drop whose weight cannot be read: formatting this row throws, so it is skipped.
      { w: 60, r: 7, type: 'dropset', done: true, drops: [{ w: Symbol('broken'), r: 6 }] },
      { w: 60, r: 6, done: true },
    ])])] }
    expect(watchLastTimeOf(partly, { id: LIFT }).rows).toEqual([{ label: '60×8' }, { label: '60×6' }])
  })
})
