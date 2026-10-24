import { describe, expect, it, vi } from 'vitest'
import { createWatchLifecycle, applyWatchSummary } from './watch-session.js'
import { resumeCompletedSession } from './session-resume.js'
import { saveResumedWorkout } from './session-resume.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { watchSnapshotOf } from './watch-workout.js'

const history = () => ({ id: 'saved', start: 1000, end: 601000, finishedAt: 601000,
  name: 'Training', entries: [{ id: 'plain-bench', sets: [{ w: 60, r: 8, done: true }] }] })
function lifecycle(S) {
  const deps = { getState: () => S, update: fn => fn(S), getTimer: () => null,
    sendEnded: vi.fn(), sendSync: vi.fn(), sendAck: vi.fn(), finish: vi.fn() }
  return { ...deps, receive: createWatchLifecycle(deps) }
}
describe('watch lifecycle outside the training route', () => {
  it('ends an offline old session on reconnect, including after phone restart', () => {
    const st = { workouts: [history()], active: null }
    const app = lifecycle(st)
    app.receive({ t: 'hello', sid: '1000' })
    expect(app.sendEnded).toHaveBeenCalledWith(expect.objectContaining({ sid: '1000', endedAt: 601000 }))
    expect(app.sendSync).not.toHaveBeenCalled()
    app.receive({ t: 'summary', sid: '1000', calories: 122, avgHr: 101, at: 10 })
    app.receive({ t: 'summary', sid: '1000', calories: 122, avgHr: 101, at: 10 })
    expect(st.workouts[0].calories).toBe(122)
    expect(app.sendAck).toHaveBeenLastCalledWith(10, undefined)
  })
  it('closes a missing/discarded session without affecting another active workout', () => {
    const st = { workouts: [], active: { start: 2000, entries: [], name: 'New' } }
    const app = lifecycle(st)
    app.receive({ t: 'hello', sid: '1000' })
    expect(app.sendEnded).toHaveBeenCalledWith(expect.objectContaining({ sid: '1000' }))
    expect(app.sendSync).toHaveBeenCalledWith(expect.objectContaining({ sid: '2000' }))
  })
  it('records energy before finishing from the watch and ignores duplicate finish after it closed', () => {
    const st = { workouts: [], active: { ...history(), end: undefined } }
    const app = lifecycle(st)
    app.finish.mockImplementation(() => { st.workouts.push(st.active); st.active = null })
    app.receive({ t: 'end', sid: '1000', calories: 222, at: 20 })
    app.receive({ t: 'end', sid: '1000', calories: 222, at: 20 })
    expect(app.finish).toHaveBeenCalledOnce()
    expect(st.workouts[0].calories).toBe(222)
    expect(app.sendAck).toHaveBeenLastCalledWith(20, undefined)
  })
  it('recovers watch work and the original end time when the phone was outside the training route', () => {
    const st = { workouts: [], active: history() }
    st.active.entries[0].sets[0].done = false
    const app = lifecycle(st)
    app.receive({ t: 'end', sid: '1000', endedAt: 600000, calories: 100, at: 30,
      completedSets: [{ ex: 0, set: 1, weight: '75', reps: '12', at: 500000 }] })
    expect(st.active.entries[0].sets[0]).toMatchObject({ done: true, w: 75, r: '12', at: 500000 })
    expect(app.finish).toHaveBeenCalledWith(600000)
  })
  it('does not let an old offline end close the resumed segment and sums separate segments once', () => {
    const st = { workouts: [history()], active: null }
    const a = resumeCompletedSession(st, st.workouts[0], 2000000)
    const app = lifecycle(st)
    app.receive({ t: 'end', sid: '1000', calories: 100, at: 20 })
    expect(app.finish).not.toHaveBeenCalled()
    expect(st.workouts[0].calories).toBe(100)
    app.receive({ t: 'end', sid: a.watchSid, calories: 50, at: 21 })
    expect(a.calories).toBe(50)
    expect(app.finish).toHaveBeenCalledOnce()
    const snapshot = watchSnapshotOf(st, null, 2060000)
    expect(snapshot.startedAt).toBe(1400000)
    expect(snapshot.segmentStartedAt).toBe(2000000)
  })
  it('rejects malformed energy and does not overwrite newer summaries with old retries', () => {
    const st = { workouts: [history()] }
    expect(applyWatchSummary(st, { sid: '1000', calories: -1 })).toBe(false)
    applyWatchSummary(st, { sid: '1000', calories: 100, at: 20 })
    applyWatchSummary(st, { sid: '1000', calories: 50, at: 10 })
    expect(st.workouts[0].calories).toBe(100)
  })
  it('retains delayed calorie reports from every resumed segment across several finishes', () => {
    const st = { workouts: [history()], active: null }
    const a = resumeCompletedSession(st, st.workouts[0], 2000000)
    saveResumedWorkout(st, a, buildCompletedWorkout(a, { end: 2060000 }))
    st.active = null
    const b = resumeCompletedSession(st, st.workouts[0], 3000000)
    applyWatchSummary(st, { sid: a.watchSid, calories: 50, at: 20 })
    applyWatchSummary(st, { sid: '1000', calories: 100, at: 21 })
    applyWatchSummary(st, { sid: b.watchSid, calories: 25, at: 22 })
    const completed = saveResumedWorkout(st, b, buildCompletedWorkout(b, { end: 3060000 }))
    expect(st.workouts).toHaveLength(1)
    expect(completed.calories).toBe(175)
  })
})
