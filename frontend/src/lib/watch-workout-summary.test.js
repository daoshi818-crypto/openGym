import { describe, expect, it } from 'vitest'
import { summarizeWorkoutRows } from '../../../watch-app/src/lib/workout-summary.js'

describe('summarizeWorkoutRows', () => {
  it('computes the same progress, volume and latest completed set across workout rows', () => {
    const workout = {
      exercises: [{ reps: '8-12' }, { reps: '30秒' }],
      rows: [
        [{ done: true, at: 100, w: '20', r: '8' }, { done: false, at: 0, w: '20', r: '8' }],
        [{ done: true, at: 200, w: '15', r: '30' }],
      ],
    }
    expect(summarizeWorkoutRows(workout)).toEqual({
      totalSets: 3,
      doneSets: 2,
      completedVolume: 160,
      completed: { exIdx: 1, setIdx: 0, at: 200 },
    })
  })

  it('preserves the first completed row when completion timestamps tie', () => {
    expect(summarizeWorkoutRows({
      exercises: [{ reps: '10' }, { reps: '10' }],
      rows: [[{ done: true, at: 0 }], [{ done: true, at: 0 }]],
    }).completed).toEqual({ exIdx: 0, setIdx: 0, at: 0 })
  })
})
