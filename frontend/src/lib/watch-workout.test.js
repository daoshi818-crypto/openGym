import { describe, expect, it } from 'vitest'
import { watchPlanOf } from './watch-workout.js'
import { buildSessionEntries } from './session-start.js'
import { exOr } from './exercises.js'
import { exerciseNameFor } from './i18n-core.js'

describe('active workout watch plan', () => {
  const S = { unit: 'kg', restSec: 90, bodyweight: [{ w: 80 }],
    active: { start: 123, name: 'Today', entries: [{ name: 'Squat',
      sets: [{ warmup: true, w: 20, r: 10 }, { w: 60, r: 8 }, { w: 60, r: 8 }] }] } }

  it('builds the current session independently of the displayed route, excluding warmups', () => {
    expect(watchPlanOf(S)).toEqual({ sid: '123', profile: { weight: 80 },
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
