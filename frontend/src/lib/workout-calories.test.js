import { it, expect } from 'vitest'
import { finiteKcal, workoutCaloriesOf, isSegmentAtLeast } from './workout-calories.js'
it('preserves a real zero and rejects absent, negative and malformed measurements', () => {
  for (const v of [null, undefined, '', ' ', true, false, -1, NaN, Infinity, 'broken']) expect(finiteKcal(v)).toBeNull()
  expect(finiteKcal(0)).toBe(0); expect(finiteKcal('0')).toBe(0)
  expect(workoutCaloriesOf({ calories: 0, calorieSource: 'watch_estimate' })).toMatchObject({ kcal: 0, status: 'available' })
  expect(workoutCaloriesOf({ watchSid: 'x' })).toMatchObject({ kcal: null, status: 'missing' })
})
it('sums segments once, supports corrections and identifies partial data', () => {
  const w = { calories: 999, watchSegments: { a: { calories: 20, at: 2 }, b: { calories: '30', at: 3 } } }
  expect(workoutCaloriesOf(w)).toMatchObject({ kcal: 50, status: 'available', updatedAt: 3 })
  w.watchSegments.a.calories = 10
  expect(workoutCaloriesOf(w).kcal).toBe(40)
  w.watchSegments.b.calories = null
  expect(workoutCaloriesOf(w)).toMatchObject({ kcal: 10, status: 'partial' })
  expect(workoutCaloriesOf({}, { pending: true }).status).toBe('pending')
})
it('rejects overflow and orders seq before at without accepting a missing version', () => {
  expect(workoutCaloriesOf({ watchSegments: { a: { calories: Number.MAX_VALUE }, b: { calories: Number.MAX_VALUE } } }).status).toBe('invalid')
  expect(isSegmentAtLeast({ seq: 2, at: 100 }, { seq: 3, at: 1 })).toBe(false)
  expect(isSegmentAtLeast({}, { at: 10 })).toBe(false)
  expect(isSegmentAtLeast({ seq: 3 }, { seq: 3 })).toBe(true)
})
