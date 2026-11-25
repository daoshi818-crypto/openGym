import { describe, expect, it } from 'vitest'
import { watchPlanOf, watchSnapshotOf, watchWorkoutDTOOf } from './watch-workout.js'
import { buildSessionEntries } from './session-start.js'
import { ensureWatchIdentity } from './watch-identity.js'
import { exOr } from './exercises.js'
import { exerciseNameFor } from './i18n-core.js'
import { EXDB } from './exercises.js'

describe('active workout watch plan', () => {
  const S = { unit: 'kg', restSec: 90, bodyweight: [{ w: 80 }],
    active: { start: 123, name: 'Today', entries: [{ name: 'Squat',
      sets: [{ warmup: true, w: 20, r: 10 }, { w: 60, r: 8 }, { w: 60, r: 8 }] }] } }

  it('builds the current session independently of the displayed route, excluding warmups', () => {
    expect(watchPlanOf(S)).toMatchObject({ sid: '123', profile: { weight: 80 },
      workout: { name: 'Today', exercises: [{ name: 'Squat', sets: 2, weight: 60, reps: 8, restSec: 90 }] } })
  })

  it('does not publish an ended session or the historical workout editor', () => {
    expect(watchPlanOf({ ...S, active: null })).toBeNull()
    expect(watchPlanOf({ ...S, active: { ...S.active, editingWorkoutId: 'history' } })).toBeNull()
  })

  it('resolves names for the id-only entries produced by the real session builder', () => {
    const stored = { ...S, workouts: [], routines: [], exWeights: {} }
    const entries = buildSessionEntries(stored, { id: 'r', prog: 'off',
      ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] })
    expect(entries[0].name).toBeUndefined()
    const plan = watchPlanOf({ ...stored, active: { ...S.active, entries } })
    expect(plan.workout.exercises[0]).toMatchObject({
      name: exerciseNameFor(exOr('0025')), sets: 3, reps: 8, weight: 60,
    })
  })

  it('uses the custom exercise in the current profile before catalogue registration', () => {
    const custom = { id: 'watch-custom', n: 'My cable row' }
    const plan = watchPlanOf({ ...S, customEx: [custom],
      active: { ...S.active, entries: [{ id: custom.id, sets: [{ w: 35, r: 12 }] }] } })
    expect(plan.workout.exercises[0].name).toBe('My cable row')
  })
})

// ---- Last time (V4) ---------------------------------------------------------
// One exercise in two routines, plus a combined day holding both entries: the plan, the reconnect
// snapshot must answer "what did I lift last time" the same way.
const LT_LIFT = EXDB.find(e => e.bp !== 'cardio' && e.eq !== 'body weight' && e.eq !== 'dumbbell').id
const ltSaved = (d, rid, w, r) => ({ d, routineIds: [rid],
  entries: [{ id: LT_LIFT, rid, target: { sets: 2, reps: r, weight: w },
    sets: [{ w, r, done: true }, { w, r, done: true }] }] })
const ltRoutine = (id, name, reps, weight) => ({ id, name, ex: [{ id: LT_LIFT, sets: 2, reps, weight }] })

describe('Last time is resolved for the active workout', () => {
  const A = ltRoutine('A', 'Push', 8, 60), B = ltRoutine('B', 'Light', 12, 40)
  const S = {
    unit: 'kg', restSec: 60, bodyweight: [{ w: 80 }],
    routines: [A, B],
    workouts: [ltSaved('2026-01-01', 'A', 60, 8), ltSaved('2026-01-03', 'B', 40, 12)],
    active: { start: 9, name: 'Combined',
      entries: [
        { id: LT_LIFT, rid: 'A', sets: [{ w: 62.5, r: 8 }, { w: 62.5, r: 8 }], target: { sets: 2, reps: 8, weight: 62.5 } },
        { id: LT_LIFT, rid: 'B', sets: [{ w: 42.5, r: 12 }, { w: 42.5, r: 12 }], target: { sets: 2, reps: 12, weight: 42.5 } },
      ] },
  }

  it('gives each entry of a combined day its own routine\'s history', () => {
    const ex = watchPlanOf(S).workout.exercises
    expect(ex.map(e => e.lastTime.date)).toEqual(['2026-01-01', '2026-01-03'])
    expect(ex.map(e => e.lastTime.sourceRoutineId)).toEqual(['A', 'B'])
    expect(ex[0].lastTime.rows).toEqual([{ label: '60×8' }, { label: '60×8' }])
    expect(ex[1].lastTime.rows).toEqual([{ label: '40×12' }, { label: '40×12' }])
  })

  it('reuses the plan builder for the reconnect snapshot instead of a second history query', () => {
    const plan = watchPlanOf(S)
    const snap = watchSnapshotOf(S, null, 1000)
    expect(snap.exercises).toEqual(plan.workout.exercises)
    expect(snap.exercises[1].lastTime.sourceRoutineId).toBe('B')
  })

  it('sends only execution data for the current workout, without its template or past lifts', () => {
    const entries = buildSessionEntries(S, A)
    const active = { start: 9, name: 'Current', routineIds: [A.id], entries }
    ensureWatchIdentity(active)
    const snapshot = watchSnapshotOf({ ...S, active }, null, 1000)
    expect(snapshot.exercises[0].lastTime.date).toBe('2026-01-01')
    const dto = watchWorkoutDTOOf({ ...snapshot, name: snapshot.workout }, snapshot.sid, 'start-current')
    expect(dto).toMatchObject({ t: 'START_SESSION', sid: '9', workout: 'Current', exercises: [{ entryInstanceId: entries[0].entryInstanceId }] })
    expect(dto.exercises[0].sets.map(row => row.setId)).toEqual(entries[0].sets.map(row => row.setId))
    expect(dto.exercises[0]).not.toHaveProperty('lastTime')
    expect(dto).not.toHaveProperty('profile')
    expect(dto).not.toHaveProperty('plans')
  })

  it('adds lastTime without disturbing the existing fields, protocol or stable identity', () => {
    const ex = watchPlanOf(S).workout.exercises[0]
    expect(Object.keys(ex).sort()).toEqual(['entryInstanceId', 'id', 'lastTime', 'muscles', 'name', 'reps', 'restSec',
      'setIds', 'sets', 'weight', 'weightUnit'])
    const plan = watchPlanOf(S)
    expect(plan.protocolVersion).toBe(2)
    expect(plan.capabilities).toEqual({ setEffort: expect.anything() })
    expect(plan.effortScale).toBe('none')
    // Same stable ids as the entry builder produced, so an old phone link keeps working.
    const built = buildSessionEntries({ ...S, active: null }, A)
    expect(watchPlanOf({ ...S, active: { start: 9, name: 'Push', entries: built } }).workout.exercises[0].entryInstanceId)
      .toBe(watchPlanOf({ ...S, active: { start: 9, name: 'Push', entries: built } }).workout.exercises[0].entryInstanceId)
  })

  it('still publishes a plan when the profile has no history at all', () => {
    const fresh = { ...S, workouts: [] }
    const plan = watchPlanOf(fresh)
    expect(plan.workout.exercises.map(e => e.lastTime)).toEqual([null, null])
    expect(watchSnapshotOf(fresh, null).exercises.map(e => e.lastTime)).toEqual([null, null])
  })
})
