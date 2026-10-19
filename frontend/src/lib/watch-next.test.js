import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createWatchLifecycle } from './watch-session.js'
import { applyWatchEvent, startFromWatch, rememberClose } from './watch-events.js'
import { resolveWatchSave } from './watch-recovery.js'
import { watchSnapshotOf } from './watch-workout.js'
import { applyEdit, restOf, applyRest, applyFocus } from '../../../watch-app/src/lib/protocol.js'

function watch() {
  const memory = {}
  const storage = { getSync: ({ key }) => structuredClone(memory[key]), set: ({ key, value }) => { memory[key] = structuredClone(value) } }
  let code = readFileSync(new URL('../../../watch-app/src/lib/session.js', import.meta.url), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace(/export function /g, 'function ')
  code += '\n;({startSession,loadState,save,applySync,replacePlan,setRowValue,addSet,removeSet,toggleSet,endSession,closeSession})'
  return { memory, ...vm.runInNewContext(code, { storage, Date, console, applyEdit, applyRest }) }
}
const exercise = name => ({ name, sets: 2, reps: '8', weight: '50', restSec: 90 })
const phone = () => ({ workouts: [], active: { start: 1000, name: 'Test', cur: 0, entries: [
  { id: 'plain-bench', sets: [{ w: 50, r: '8', done: false }, { w: 50, r: '8', done: false }] },
  { id: 'plain-bench', sets: [{ w: 50, r: '8', done: false }, { w: 50, r: '8', done: false }] },
] } })
function life(S) {
  const deps = { getState: () => S, update: fn => fn(S), getTimer: () => null,
    sendEnded: vi.fn(), sendSync: vi.fn(), sendAck: vi.fn(), send: vi.fn(), finish: vi.fn(), stop: vi.fn() }
  return { ...deps, receive: createWatchLifecycle(deps) }
}

describe('watch durable state and navigation', () => {
  it('retains B-2 through repeated plan/sync and restart', () => {
    const w = watch(), s = w.startSession({ sid: 'x', name: 'Test', exercises: [exercise('A'), exercise('B')] })
    s.exIdx = 1; s.setIdx = 1; w.save(s)
    const snap = { sid: 'x', exercises: s.workout.exercises, rows: s.workout.rows, exIdx: 0, setIdx: 0, rev: 10 }
    w.applySync(s, snap); w.replacePlan(s, { exercises: s.workout.exercises })
    expect(w.loadState()).toMatchObject({ exIdx: 1, setIdx: 1 })
    expect(applyFocus(s, { sid: 'x', ex: 0, set: 1, at: 20, source: 'watch' })).toBe(false)
    expect(applyFocus(s, { sid: 'x', ex: 0, set: 1, at: 20, source: 'phone' })).toBe(true)
    expect(applyFocus(s, { sid: 'x', ex: 1, set: 1, at: 19, source: 'phone' })).toBe(false)
  })
  it('preserves field, structure and completed edits until their snapshot acknowledgment', () => {
    const w = watch(), s = w.startSession({ sid: 'x', exercises: [exercise('A')] })
    const old = structuredClone(s.workout)
    s.pendingEdits = [
      { t: 'weight', ex: 0, set: 2, weight: '72.5', eventId: 'w1' },
      { t: 'add_set', ex: 0, set: 3, weight: '72.5', reps: '10', eventId: 'w2' },
      { t: 'set', ex: 0, set: 3, at: 1, eventId: 'w3' },
    ]
    w.applySync(s, { sid: 'x', ...old, rev: 10 })
    expect(s.workout.rows[0]).toHaveLength(3)
    expect(s.workout.rows[0][1].w).toBe('72.5')
    expect(s.workout.rows[0][2].done).toBe(true)
    w.applySync(s, { sid: 'x', exercises: s.workout.exercises, rows: s.workout.rows, rev: 12, ackedEvents: ['w1', 'w2', 'w3'] })
    w.applySync(s, { sid: 'x', ...old, rev: 11 })
    expect(s.pendingEdits).toHaveLength(0)
    expect(w.loadState().workout.rows[0]).toHaveLength(3)
  })
  it('never removes completed or final sets or completes a row twice', () => {
    const w = watch(), s = w.startSession({ sid: 'x', exercises: [exercise('A')] })
    w.removeSet(s, 0); w.removeSet(s, 0)
    expect(s.workout.rows[0]).toHaveLength(1)
    expect(w.toggleSet(s, true)).toBeTruthy()
    expect(w.toggleSet(s, true)).toBeNull()
    w.removeSet(s, 0)
    expect(s.workout.rows[0][0].done).toBe(true)
  })
  it('restores expired sessions as closed and queues one discard without erasing history summary', () => {
    const w = watch(), s = w.startSession({ sid: 'expired', exercises: [exercise('A')] })
    s.startedAt = Date.now() - 21600001; w.save(s)
    w.memory.summary_last = { calories: 10 }
    expect(w.loadState().active).toBe(false)
    expect(w.loadState().active).toBe(false)
    expect(w.memory.closed_sessions).toContain('expired')
    expect(w.memory.rpc_outbox).toHaveLength(1)
    expect(w.memory.rpc_outbox[0].msg.disposition).toBe('abandoned')
    expect(w.memory.summary_last.calories).toBe(10)
  })
})

describe('phone reconciliation outside the workout view', () => {
  it('retains local recovery details without sending history over RPC on reconnect or retried start', () => {
    const S = phone(), entries = structuredClone(S.active.entries)
    rememberClose(S, { sid: '1000', disposition: 'saved', entries, elapsedBeforeMs: 600000 })
    rememberClose(S, { sid: '1000', disposition: 'saved', eventId: 'closed' })
    expect(S.watchClosed['1000']).toMatchObject({ entries, elapsedBeforeMs: 600000 })
    S.active = null
    const app = life(S)
    app.receive({ t: 'hello' })
    app.receive({ t: 'watch_start', sid: '1000', plan: {}, eventId: 'retry' })
    const messages = app.send.mock.calls.map(([msg]) => msg).filter(msg => msg.t === 'session_close')
    expect(messages).toHaveLength(2)
    for (const msg of messages) {
      expect(msg.sid).toBe('1000')
      expect(msg).not.toHaveProperty('entries')
      expect(msg).not.toHaveProperty('elapsedBeforeMs')
    }
  })
  it('deduplicates durable edits after lifecycle recreation and ignores older field events', () => {
    const S = phone(), ev = { sid: '1000', t: 'add_set', ex: 0, set: 3, sets: 3, at: 10, eventId: 'a' }
    life(S).receive(ev); life(S).receive(ev)
    expect(S.active.entries[0].sets).toHaveLength(3)
    applyWatchEvent(S, { sid: '1000', t: 'weight', ex: 0, set: 3, weight: '75', at: 20, eventId: 'b' })
    applyWatchEvent(S, { sid: '1000', t: 'weight', ex: 0, set: 3, weight: '60', at: 19, eventId: 'c' })
    expect(S.active.entries[0].sets[2].w).toBe(75)
    expect(watchSnapshotOf(S).ackedEvents).toContain('a')
  })
  it('starts an offline cached plan exactly once and refuses to replace another session', () => {
    const S = phone(), plan = { id: 'p', name: 'Plan', entries: structuredClone(S.active.entries) }
    expect(startFromWatch(S, { sid: 'w1', plan })).toBe('conflict')
    S.active = null
    expect(startFromWatch(S, { sid: 'w1', plan })).toBe('started')
    const first = S.active
    expect(startFromWatch(S, { sid: 'w1', plan })).toBe('started')
    expect(S.active).toBe(first)
    S.active = null; S.watchClosed = { w1: { disposition: 'discarded' } }
    expect(startFromWatch(S, { sid: 'w1', plan })).toBe('closed')
  })
  it.each(['discarded', 'abandoned'])('closes %s without a record or summary', disposition => {
    const S = phone(), app = life(S)
    const ev = { t: 'session_close', sid: '1000', disposition, eventId: 'c', at: 30 }
    app.receive(ev); app.receive(ev)
    expect(S.active).toBeNull(); expect(S.workouts).toHaveLength(0)
    expect(app.finish).not.toHaveBeenCalled()
    expect(S.watchClosed['1000'].disposition).toBe(disposition)
  })
  it('saves once and does not turn a retry of that save into a conflict', () => {
    const S = phone(), app = life(S)
    app.finish.mockImplementation(() => { S.workouts.push(S.active); S.active = null })
    const ev = { t: 'session_close', sid: '1000', disposition: 'saved', summary: { calories: 30 }, eventId: 'c', closedAt: 30, at: 30 }
    app.receive(ev); app.receive(ev)
    expect(app.finish).toHaveBeenCalledOnce()
    expect(S.watchPendingSaves).toBeUndefined()
  })
  it('requires a phone decision before a late watch save can change saved rows', () => {
    const S = phone()
    const record = { ...S.active, id: 'old', end: 2000 }; record.entries[0].sets[0].done = true
    S.workouts = [record]; S.active = null; S.watchClosed = { '1000': { disposition: 'saved', eventId: 'phone' } }
    const app = life(S), ev = { t: 'session_close', sid: '1000', disposition: 'saved', eventId: 'late', closedAt: 3000, at: 3000,
      summary: { calories: 60 }, completedSets: [{ ex: 0, set: 1, weight: '80', reps: '10', at: 2900 }] }
    app.receive(ev); app.receive(ev)
    expect(S.workouts[0].entries[0].sets[0].w).toBe(50)
    expect(Object.keys(S.watchPendingSaves)).toHaveLength(1)
    resolveWatchSave(S, 'late', false)
    app.receive(ev)
    expect(S.workouts[0].entries[0].sets[0].w).toBe(50)
    expect(Object.keys(S.watchPendingSaves)).toHaveLength(0)
    const next = { ...ev, eventId: 'late2' }; app.receive(next)
    resolveWatchSave(S, 'late2', true)
    expect(S.workouts).toHaveLength(1)
    expect(S.workouts[0].id).toBe('old')
    expect(S.workouts[0].entries[0].sets[0].w).toBe(80)
  })
  it('matches late saved rows against the original order even when empty exercises were filtered out', () => {
    const S = phone(), original = structuredClone(S.active.entries)
    original[0].id = 'plain-row'
    original[1].sets[0].done = true
    const record = { ...S.active, id: 'saved', end: 2000, entries: [structuredClone(original[1])] }
    record.entries[0].sets[0].done = true
    S.active = null; S.workouts = [record]
    S.watchClosed = { '1000': { disposition: 'saved', entries: original } }
    S.watchPendingSaves = { late: { sid: '1000', closedAt: 3000, summary: { calories: 40 },
      completedSets: [{ ex: 0, set: 1, weight: '80', reps: '10' }] } }
    resolveWatchSave(S, 'late', true)
    expect(S.workouts[0].entries.map(e => e.id)).toEqual(['plain-row', 'plain-bench'])
    expect(S.workouts[0].entries[0].sets[0].w).toBe(80)
    expect(S.workouts[0].entries[1].sets[0].w).toBe(50)
  })
  it('can explicitly recover a discarded phone session as one new record', () => {
    const S = phone(), entries = structuredClone(S.active.entries)
    S.active = null; S.watchClosed = { '1000': { disposition: 'discarded', entries } }
    S.watchPendingSaves = { late: { sid: '1000', startedAt: 1000, closedAt: 3000, summary: { calories: 40 },
      completedSets: [{ ex: 0, set: 1, weight: '80', reps: '10' }] } }
    resolveWatchSave(S, 'late', true); resolveWatchSave(S, 'late', true)
    expect(S.workouts).toHaveLength(1)
    expect(S.workouts[0].entries[0].sets[0].w).toBe(80)
  })
  it('retains later phone entries, PRs and muscle snapshots and reconciles resumed duration', () => {
    const S = phone(), original = structuredClone(S.active.entries)
    original[0].sets[0].done = true
    const record = { ...S.active, id: 'saved', end: 901000, durationMs: 900000, finishedAt: 2000000,
      entries: [{ ...structuredClone(original[0]), muscleSnapshot: { chest: 1 } },
        { id: 'plain-row', sets: [{ w: 30, r: '10', done: true }] }], prs: ['existing-pr'] }
    S.active = null; S.workouts = [record]
    S.watchClosed = { '1000': { entries: original, elapsedBeforeMs: 600000 } }
    S.watchPendingSaves = { late: { sid: '1000', closedAt: 2001000, summary: { calories: 40, minutes: 8 },
      completedSets: [{ ex: 0, set: 1, weight: '80', reps: '10' }] } }
    resolveWatchSave(S, 'late', true)
    expect(S.workouts[0]).toMatchObject({ durationMs: 1080000, end: 1081000, finishedAt: 2001000, prs: ['existing-pr'] })
    expect(S.workouts[0].entries.map(e => e.id)).toEqual(['plain-bench', 'plain-row'])
    expect(S.workouts[0].entries[0].muscleSnapshot).toEqual({ chest: 1 })
  })
  it('does not let a delayed completion overwrite a newer weight field', () => {
    const S = phone()
    applyWatchEvent(S, { sid: '1000', t: 'weight', ex: 0, set: 1, weight: '80', seq: 20, eventId: 'new' })
    applyWatchEvent(S, { sid: '1000', t: 'set', ex: 0, set: 1, weight: '60', seq: 19, eventId: 'old' })
    expect(S.active.entries[0].sets[0]).toMatchObject({ w: 80, done: true })
  })
})

describe('rest protocol', () => {
  it('keeps the target distinct from remaining time, preserves it through resume and rejects old messages', () => {
    const s = { restUntil: 175000, restTargetSec: 105, restStartedAt: 100000, restId: 'r', restVersion: 130000 }
    expect(restOf(s, 100000)).toMatchObject({ leftSec: 75, totalSec: 105 })
    const peer = {}
    applyRest(peer, restOf(s, 100000), 100000)
    expect(restOf(peer, 130000).leftSec).toBe(45)
    expect(applyRest(peer, { leftSec: 1, totalSec: 1, seq: 120000 })).toBe(false)
    expect(peer.restTargetSec).toBe(105)
  })
})
