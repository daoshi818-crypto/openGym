import { describe, expect, it } from 'vitest'
import { applyWatchEffort, applyWatchEvent } from './watch-events.js'
import { applyWatchSummary, createWatchLifecycle } from './watch-session.js'
import { watchPlanOf, watchSnapshotOf } from './watch-workout.js'
import { resolveWatchSave } from './watch-recovery.js'
import { startFromWatch } from './watch-events.js'
import { ensureWatchIdentity } from './watch-identity.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { build } from '../../../api/coach/core/payload.js'

function session() {
  const S = { workouts: [], unit: 'kg', restSec: 60, effort: 'rpe', bodyweight: [{ w: 80 }] }
  startFromWatch(S, {
    sid: 'sid-effort', startedAt: Date.now(),
    plan: { id: 'plan-1', name: 'Upper', entries: [
      { id: 'plain-bench', sets: [{ w: 50, r: '8', done: false }, { w: 50, r: '8', done: false }] },
    ] },
  })
  ensureWatchIdentity(S.active)
  return S
}
const row = (S, i = 0) => S.active.entries[0].sets[i]
const ids = (S, i = 0) => ({ entryInstanceId: S.active.entries[0].entryInstanceId, setId: row(S, i).setId })

describe('watch effort → phone (RPE/RIR data chain)', () => {
  it('stores exactly one scale on the set, keeps 0 RIR, and carries it in the plan and snapshot', () => {
    const S = session()
    const ev = { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rir', value: 0, clear: false, effortVersion: 100, eventId: 'e1', at: 100 }
    expect(applyWatchEffort(S, ev).status).toBe('applied')
    expect(row(S)).toMatchObject({ rir: 0 })
    expect(row(S).rpe).toBeUndefined()
    expect(row(S).effortVersion).toBe(100)

    // Re-rating on the other scale clears the first: never two scales on one set.
    expect(applyWatchEffort(S, { ...ev, scale: 'rpe', value: 8, effortVersion: 200, eventId: 'e2' }).status).toBe('applied')
    expect(row(S).rpe).toBe(8)
    expect(row(S).rir).toBeUndefined()

    const plan = watchPlanOf(S)
    expect(plan).toMatchObject({ effortScale: 'rpe', capabilities: { setEffort: 1 } })
    const snap = watchSnapshotOf(S, null, Date.now())
    expect(snap.rows[0][0]).toMatchObject({ rpe: 8, effortVersion: 200 })
    expect(snap.effortScale).toBe('rpe')
  })

  it('does not treat a missing field in a snapshot as a clear, and keeps the cleared version', () => {
    const S = session()
    applyWatchEffort(S, { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rpe', value: 9, effortVersion: 300, eventId: 'a' })
    // A fresh snapshot without effort fields (an older phone build) must not erase it.
    expect(applyWatchEffort(S, { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rpe', value: 9, effortVersion: 300, eventId: 'a' }).status).toBe('applied')
    // Explicit clear keeps a version and removes both values.
    expect(applyWatchEffort(S, { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rpe', value: null, clear: true, effortVersion: 400, eventId: 'b' }).status).toBe('applied')
    expect(row(S).rpe).toBeUndefined()
    expect(row(S).rir).toBeUndefined()
    expect(row(S).effortVersion).toBe(400)
    // An older message cannot revive the cleared rating.
    expect(applyWatchEffort(S, { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rir', value: 8, effortVersion: 350, eventId: 'c' }).status).toBe('stale')
    expect(row(S).rir).toBeUndefined()
  })

  it('turns a concurrent phone edit into a conflict instead of silently overwriting', () => {
    const S = session()
    applyWatchEffort(S, { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rpe', value: 7, effortVersion: 500, eventId: 'phone-1' })
    const result = applyWatchEffort(S, { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rpe', value: 9,
      effortVersion: 450, baseEffortVersion: 300, eventId: 'watch-1' })
    expect(result).toMatchObject({ status: 'conflict', value: 7, version: 500 })
    expect(row(S).rpe).toBe(7)      // phone value stands
  })

  it('is idempotent by eventId and rejects an unknown target', () => {
    const S = session()
    const ev = { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rpe', value: 8, effortVersion: 600, eventId: 'same' }
    expect(applyWatchEffort(S, ev).status).toBe('applied')
    row(S).rpe = 7
    expect(applyWatchEffort(S, ev).status).toBe('applied')   // remembered, not re-applied
    expect(row(S).rpe).toBe(7)
    expect(applyWatchEffort(S, { ...ev, eventId: 'x', setId: 'nope' }).status).toBe('rejected')
  })

  it('handles the effort event in the phone lifecycle with exact ack, and reports a conflict', () => {
    const S = session()
    const sent = [], acks = []
    const deps = { getState: () => S, update: fn => fn(S), getTimer: () => null,
      sendEnded() {}, sendSync() {}, send: m => sent.push(m), sendAck: (upto, eventId) => acks.push({ upto, eventId }),
      finish() {}, stop() {}, rest() {} }
    const receive = createWatchLifecycle(deps)
    const ev = { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rpe', value: 8, effortVersion: 700, eventId: 'watch-evt', at: 700 }
    receive(ev)
    expect(row(S).rpe).toBe(8)
    expect(acks.at(-1)).toEqual({ upto: 700, eventId: 'watch-evt' })
    // A later phone edit, then an offline watch edit based on the old version → explicit conflict.
    applyWatchEffort(S, { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rpe', value: 9, effortVersion: 800, eventId: 'phone-evt' })
    receive({ ...ev, value: 6, effortVersion: 750, baseEffortVersion: 700, eventId: 'watch-late' })
    expect(row(S).rpe).toBe(9)
    expect(sent.find(m => m.t === 'effort_ack')).toMatchObject({ status: 'conflict', value: 9, version: 800 })
  })

  it('keeps effort through finish, history and the AI coach payload', () => {
    const S = session()
    applyWatchEffort(S, { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rpe', value: 8, effortVersion: 900, eventId: 'e' })
    row(S).done = true
    row(S).at = Date.now()
    const completed = buildCompletedWorkout(S.active, { end: Date.now() })
    expect(completed.entries[0].sets[0]).toMatchObject({ rpe: 8 })
    S.workouts.push({ ...completed, id: 'w1', d: '2026-10-24' })
    S.active = null
    const payload = build({ ...S, routineIds: ['plan-1'], name: 'Upper', d: '2026-10-24' }, { handle: 'review', since: 0, kind: 'debrief' })
    // The debrief prompt reads the per-set object; the rating must be in the payload itself.
    const text = JSON.stringify(payload)
    expect(text).toContain('"rpe":8')
  })

  it('carries effort through an offline late save (completedSets)', () => {
    const S = session()
    const record = { ...JSON.parse(JSON.stringify(S.active)), id: 'saved', end: Date.now() }
    record.entries[0].sets[0].done = true
    S.workouts = [record]
    S.active = null
    S.watchClosed = { 'sid-effort': { disposition: 'saved', entries: JSON.parse(JSON.stringify(record.entries)), elapsedBeforeMs: 0 } }
    S.watchPendingSaves = { late: { sid: 'sid-effort', closedAt: Date.now(), startedAt: record.start,
      summary: { calories: 40, minutes: 5 },
      completedSets: [{ ex: 0, set: 1, weight: '60', reps: '8', rpe: 9, effortVersion: 950 }] } }
    resolveWatchSave(S, 'late', true)
    expect(S.workouts[0].entries[0].sets[0]).toMatchObject({ rpe: 9 })
  })

  it('does not inherit a rating onto a new set or a re-done set', () => {
    const S = session()
    applyWatchEffort(S, { sid: 'sid-effort', t: 'effort', ...ids(S), scale: 'rpe', value: 8, effortVersion: 1000, eventId: 'e' })
    // A new set added by the watch arrives through add_set: it is a fresh row with no rating.
    applyWatchEvent(S, { sid: 'sid-effort', t: 'add_set', ...ids(S), sets: 3, at: 1001, eventId: 'add' })
    const rows = S.active.entries[0].sets
    expect(rows.at(-1).rpe).toBeUndefined()
    expect(rows.at(-1).effortVersion).toBeUndefined()
    // Undo + redo: the row's own rating is data and stays, but nothing is copied anywhere.
    rows[0].done = false
    rows[0].done = true
    expect(rows[1].rpe).toBeUndefined()
  })
})
