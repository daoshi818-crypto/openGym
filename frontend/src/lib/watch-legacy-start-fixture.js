// A saved pre-v4 watch event. Current phones do not generate or publish these plans.
export function legacyWatchWorkout(count = 1) {
  const exercises = Array.from({ length: count }, (_, i) => ({
    id: count === 1 || i % 2 ? '0025' : '0001', entryInstanceId: `back:entry:${i}`, name: `Exercise ${i + 1}`,
    weightUnit: 'kg', sets: 4, reps: 8, weight: 40, restSec: 60,
    setIds: Array.from({ length: 4 }, (_, j) => `back:entry:${i}:set:${j}`),
  }))
  const rows = exercises.map(e => e.setIds.map(setId => ({ setId, w: 40, r: 8, done: false })))
  const entries = exercises.map((e, i) => ({ id: e.id, rid: 'back', entryInstanceId: e.entryInstanceId,
    target: { sets: 4, reps: 8, weight: 40 }, sets: rows[i] }))
  return { id: 'back', routineIds: ['back'], name: 'Back', weightUnit: 'kg', exercises, rows, entries }
}
