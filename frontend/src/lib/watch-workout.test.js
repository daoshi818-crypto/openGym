import { describe, expect, it } from 'vitest'
import { watchPlanOf } from './watch-workout.js'

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
})
