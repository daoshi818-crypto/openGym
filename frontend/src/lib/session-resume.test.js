import { describe, expect, it } from 'vitest'
import { resumeCompletedSession, saveResumedWorkout, elapsedMsOf, watchSidOf } from './session-resume.js'
import { buildCompletedWorkout, sessionEnd } from './finish-workout.js'

const saved = () => ({ id: 'record', d: '2026-10-19', name: 'Training', start: 1000, end: 601000,
  media: [{ id: 'photo' }], note: 'keep', entries: [{ id: 'plain-bench', sets: [{ w: 60, r: 8, done: true, at: 500000 }] }] })
describe('continue a completed training session', () => {
  it('preserves work and original start, accumulates time without the break and replaces the same record', () => {
    const st = { workouts: [saved()], active: null }
    const a = resumeCompletedSession(st, st.workouts[0], 2000000)
    expect(a.entries[0].sets[0].done).toBe(true)
    expect(a.start).toBe(1000)
    expect(watchSidOf(a)).not.toBe('1000')
    expect(elapsedMsOf(a, 2300000)).toBe(900000)
    expect(sessionEnd(a, 2300000)).toBe(2300000)
    a.entries[0].sets.push({ w: 65, r: 8, done: true, at: 2200000 })
    const result = saveResumedWorkout(st, a, buildCompletedWorkout(a, { end: 2300000 }))
    expect(st.workouts).toHaveLength(1)
    expect(result).toMatchObject({ id: 'record', start: 1000, end: 901000, durationMs: 900000,
      finishedAt: 2300000, note: 'keep', media: [{ id: 'photo' }] })
    expect(result.entries[0].sets).toHaveLength(2)
    st.active = null
    const b = resumeCompletedSession(st, result, 5000000)
    expect(elapsedMsOf(b, 5060000)).toBe(960000)
    expect(watchSidOf(b)).not.toBe(watchSidOf(a))
  })
  it('rejects resuming during another session or recreating a deleted workout', () => {
    expect(() => resumeCompletedSession({ active: {}, workouts: [saved()] }, saved())).toThrow()
    expect(() => saveResumedWorkout({ workouts: [] }, { resumeWorkoutId: 'record' }, saved())).toThrow()
  })
})
