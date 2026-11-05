import { describe, expect, it, vi } from 'vitest'
import { createWatchLifecycle, applyWatchSummary } from './watch-session.js'
import { resumeCompletedSession } from './session-resume.js'
import { saveResumedWorkout } from './session-resume.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { watchSnapshotOf } from './watch-workout.js'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'

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

// ---- the watch\'s own session module (V4) -----------------------------------
// The phone now ships an optional `lastTime` on every exercise. It rides in the same exercise
// object as the rest of the plan, so it survives start / reconnect / restart without the watch
// ever asking for history. These run the shipped watch module with only the device APIs faked.
function watchSession() {
  const store = watchPersistence()
  const ctx = store.ctx
  loadWatchModule('protocol', ctx, ['applyEdit', 'applyRest', 'restOf', 'applyFocus'])
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', ctx, ['prepareClose', 'journalEntry', 'markDelivered'])
  loadWatchModule('session', ctx, ['loadState', 'save', 'startSession', 'replacePlan', 'applySync',
    'endSession', 'closeSession', 'buildSessionSummary', 'nextUndone'])
  return { ...store, ctx }
}
const lt = { date: '2026-11-02', weightUnit: 'kg', sourceRoutineId: 'push',
  rows: [{ label: '60 脳 10' }, { label: '60 脳 8' }, { label: '57.5 脳 10' }], text: '60 脳 10锛?0 脳 8锛?7.5 脳 10' }
const watchPlan = (extra = {}) => ({ sid: 'w1', name: 'Push', protocolVersion: 2, weightUnit: 'kg',
  effortScale: 'rpe', exercises: [
    { id: 'bench', entryInstanceId: 'e1', name: 'Bench', sets: 2, setIds: ['s1', 's2'], reps: 8, weight: 60, lastTime: structuredClone(lt) },
    { id: 'row', entryInstanceId: 'e2', name: 'Row', sets: 1, setIds: ['s3'], reps: 10, weight: 40 },
  ], ...extra })

describe('watch session keeps the optional Last time payload', () => {
  it('persists it across a restart and hands it back with the session', () => {
    const h = watchSession()
    const s = h.ctx.startSession(watchPlan(), { weightKg: 80 })
    expect(s.workout.exercises[0].lastTime).toEqual(lt)
    expect(s.workout.exercises[1].lastTime).toBeUndefined()
    // A restart reads the same session back from storage.
    const again = h.ctx.loadState()
    expect(again.workout.exercises[0].lastTime).toEqual(lt)
    expect(again.workout.exercises[1].lastTime).toBeUndefined()
    expect(again.workout.exercises[0].setIds).toEqual(['s1', 's2'])
  })

  it('keeps it when the phone re-pushes the plan', () => {
    const h = watchSession()
    const s = h.ctx.startSession(watchPlan(), null)
    const pushed = h.ctx.replacePlan(s, { ...watchPlan(), name: 'Push day',
      exercises: watchPlan().exercises.map(e => ({ ...e, weight: 65 })) })
    expect(pushed.workout.name).toBe('Push day')
    expect(pushed.workout.exercises[0].lastTime).toEqual(lt)
  })

  it('keeps it when a reconnect snapshot replaces the exercise list', () => {
    const h = watchSession()
    const s = h.ctx.startSession(watchPlan(), null)
    h.ctx.applySync(s, { t: 'sync', sid: 'w1', workout: 'Push', protocolVersion: 2, rev: 5, weightUnit: 'kg',
      exercises: watchPlan().exercises, rows: [[{ setId: 's1', w: 60, r: 8, done: true }], [{ setId: 's3', w: 40, r: 10, done: false }]] })
    expect(s.workout.exercises[0].lastTime).toEqual(lt)
    expect(h.ctx.loadState().workout.exercises[0].lastTime).toEqual(lt)
  })

  it('still trains normally on a phone that never sends the field', () => {
    const h = watchSession()
    const old = watchPlan()
    delete old.exercises[0].lastTime
    const s = h.ctx.startSession(old, null)
    expect(s.workout.exercises[0].lastTime).toBeUndefined()
    expect(s.workout.rows[0].map(r => [r.w, r.r, r.done])).toEqual([[60, 8, false], [60, 8, false]])
    h.ctx.applySync(s, { t: 'sync', sid: 'w1', protocolVersion: 2, rev: 3, exercises: old.exercises, rows: [] })
    expect(s.workout.rows[0].length).toBe(2)
  })

  it('never lets a refresh overwrite rows the phone has not confirmed yet', () => {
    const h = watchSession()
    const s = h.ctx.startSession(watchPlan(), null)
    s.workout.exercises[0].lastTime = { ...lt, date: '2026-10-01' }
    s.pendingEdits = [{ eventId: 'ev1', t: 'weight', sid: 'w1', ex: 0, set: 1, weight: 65, at: 10 }]
    h.ctx.save(s)
    // A plan push is deferred while edits are unconfirmed: history may go stale, rows must not.
    h.ctx.replacePlan(s, { ...watchPlan(), exercises: watchPlan().exercises.map(e => ({ ...e, weight: 70 })) })
    expect(s.workout.exercises[0].weight).toBe(60)
    expect(s.workout.exercises[0].lastTime.date).toBe('2026-10-01')
    // A snapshot without our ack keeps both the queued edit and the local history.
    h.ctx.applySync(s, { t: 'sync', sid: 'w1', protocolVersion: 2, rev: 2, ackedEvents: [],
      exercises: watchPlan().exercises, rows: [[{ setId: 's1', w: 60, r: 8, done: true }], []] })
    expect(s.pendingEdits.map(e => e.eventId)).toEqual(['ev1'])
    expect(s.workout.exercises[0].lastTime).toEqual(lt)
  })
})
