import { afterEach, describe, it, expect, vi } from 'vitest'
import { createDurableWatchLifecycle } from './watch-commit.js'
import { ensureWatchIdentity } from './watch-identity.js'
import { stampWatchRevision, watchConflict } from './watch-revision.js'
import { watchSnapshotOf } from './watch-workout.js'
import { watchPersistence, loadWatchModule } from './watch-test-harness.js'
import { applyEdit, applyRest, restOf } from '../../../watch-app/src/lib/protocol.js'
import { wireHash, diffWire, splitWire } from '../../../watch-app/src/lib/sync-wire.js'

function phone() {
  const S = { unit: 'kg', workouts: [], active: { start: Date.now(), watchSid: 's', name: 'Bench', entries: [{ id: 'plain-bench', sets: [{ w: 50, r: '8', done: false }, { w: 50, r: '8', done: false }] }] } }
  ensureWatchIdentity(S.active)
  stampWatchRevision({}, S)
  const deps = { getState: () => S, getTimer: () => null, checkpoint: vi.fn(async () => {}),
    update: (fn, ev) => { const prev = structuredClone(S); fn(S); stampWatchRevision(prev, S, ev?.installationId || 'watch') },
    send: vi.fn(), sendAck: vi.fn(), sendEnded: vi.fn(), sendSync: vi.fn(), finish: vi.fn() }
  return { S, deps, receive: createDurableWatchLifecycle(deps) }
}
function watch(S) {
  const { disk, shared, ctx } = watchPersistence()
  Object.assign(ctx, { applyEdit, applyRest, console, setInterval: () => 1, clearInterval() {}, WATCH_VERSION: 'test' })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', ctx, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
  loadWatchModule('session', ctx, ['startSession', 'loadState', 'save', 'applySync', 'closeSession', 'buildSessionSummary', 'summaryEventOf', 'toggleSet'])
  const sent = [], connection = { send: ({ data, success }) => { sent.push(data); success?.() }, getReadyState: ({ success }) => success({ status: 1 }) }
  ctx.interconnect = { instance: () => connection }
  loadWatchModule('rpc', ctx, ['startServer', 'sendEvent', 'pendingCount', 'synchronizationStatus'])
  const initial = watchSnapshotOf(S, null), value = { ...initial, t: 'sync', protocolVersion: 3 }
  const snap = { ...value, wireHash: wireHash(value) }
  ctx.startSession({ ...initial, name: initial.workout, rows: initial.rows, exercises: initial.exercises })
  const viewState = ctx.loadState() // pages keep their own object while RPC writes the shared cache
  ctx.startServer({ onSync: msg => { ctx.applySync(viewState, msg); return { status: 'applied' } } })
  connection.onMessage(snap)
  return { disk, shared, ctx, sent, connection, snap }
}
const event = a => ({ t: 'weight', sid: 's', eventId: 'v3:A', protocolVersion: 3, installationId: 'watch-A', deviceSeq: 1,
  baseCommitRev: a.S.active.syncRev, entryInstanceId: a.S.active.entries[0].entryInstanceId, setId: a.S.active.entries[0].sets[0].setId,
  ex: 0, set: 1, weight: '65', at: 1, seq: 1 })
afterEach(() => vi.useRealTimers())
describe('negotiated durable protocol', () => {
  it('keeps completion rest and next-set focus while older snapshots arrive, then preserves a local skip', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T09:00:00Z'))
    const a = phone(), w = watch(a.S), local = w.ctx.loadState()
    w.ctx.toggleSet(local, true)
    const rest = restOf(local), deadline = local.restUntil
    w.ctx.sendEvent({ t: 'set', sid: 's', ex: 0, set: 1, at: local.workout.rows[0][0].at, rest })
    const completion = w.sent.find(m => m.t === 'set')
    // Match Workout.emitEvent: reconcile the RPC-persisted pending edits before saving the cursor.
    local.pendingEdits = w.ctx.loadState().pendingEdits
    local.setIdx = 1; w.ctx.save(local)
    w.ctx.sendEvent({ t: 'focus', sid: 's', ex: 0, set: 2, at: Date.now() + 1 })
    for (let i = 0; i < 3; i++) {
      w.ctx.applySync(w.ctx.loadState(), w.snap)
      expect(w.ctx.loadState().restUntil).toBe(deadline)
      expect(w.ctx.loadState().workout.rows[0][0].done).toBe(true)
      expect(w.ctx.loadState().setIdx).toBe(1)
    }
    const committed = { ...w.snap, commitRev: w.snap.commitRev + 1, rows: structuredClone(w.snap.rows),
      ackedEvents: [completion.eventId], rest }
    committed.rows[0][0].done = true
    w.ctx.applySync(w.ctx.loadState(), committed)
    expect(w.ctx.loadState().restUntil).toBe(deadline)
    w.ctx.sendEvent({ t: 'rest', sid: 's', ...rest, seq: rest.seq + 1, leftSec: 0, totalSec: 0, endsAt: 0 })
    w.ctx.applySync(w.ctx.loadState(), committed)
    expect(w.ctx.loadState().restUntil).toBe(0)
    expect(w.ctx.loadState().setIdx).toBe(1)
    a.receive.dispose()
  })

  it('does not resurrect completion rest when a pending undo follows it', () => {
    const a = phone(), w = watch(a.S), local = w.ctx.loadState()
    w.ctx.toggleSet(local, true)
    w.ctx.sendEvent({ t: 'set', sid: 's', ex: 0, set: 1, at: local.workout.rows[0][0].at, rest: restOf(local) })
    w.ctx.sendEvent({ t: 'unset', sid: 's', ex: 0, set: 1, at: Date.now() + 1 })
    w.ctx.applySync(w.ctx.loadState(), w.snap)
    expect(w.ctx.loadState().workout.rows[0][0].done).toBe(false)
    expect(w.ctx.loadState().restUntil).toBe(0)
    a.receive.dispose()
  })

  it('applies phone rest/pause by commit revision and keeps uncommitted local timer intent', () => {
    const a = phone(), w = watch(a.S), local = w.ctx.loadState()
    local.restVersion = Date.now() + 864e5; local.pauseVersion = local.restVersion; local.pausedAt = Date.now()
    w.ctx.save(local)
    const next = { ...w.snap, commitRev: 2, pauseVersion: 1, pausedAt: 0,
      rest: { seq: 1, restId: 'phone', leftSec: 30, totalSec: 30, endsAt: Date.now() + 30000 } }
    w.ctx.applySync(w.ctx.loadState(), next)
    expect(w.ctx.loadState().pausedAt).toBe(0)
    expect(w.ctx.loadState().restId).toBe('phone')
    w.ctx.sendEvent({ t: 'rest', sid: 's', restId: 'local', seq: Date.now(), totalSec: 50, leftSec: 50, endsAt: Date.now() + 50000 })
    w.ctx.applySync(w.ctx.loadState(), next)
    expect(w.ctx.loadState().restId).toBe('local')
    a.receive.dispose()
  })
  it('preserves an offline effort edit over in-flight snapshots and retains the phone effort version', () => {
    const a = phone(), w = watch(a.S)
    w.ctx.sendEvent({ ...event(a), eventId: undefined, t: 'effort', value: 9, scale: 'rpe', effortVersion: 10 })
    const { wireHash: ignored, ...value } = { ...w.snap }
    value.rows = structuredClone(value.rows); value.rows[0][0].rpe = 8; value.rows[0][0].effortVersion = 5
    const snap = { ...value, wireHash: wireHash(value) }
    w.connection.onMessage(snap)
    expect(w.ctx.loadState().workout.rows[0][0]).toMatchObject({ rpe: 9, effortAt: 10 })
    w.ctx.applySync(w.ctx.loadState(), { ...snap, ackedEvents: [w.sent.find(m => m.t === 'effort').eventId] })
    expect(w.ctx.loadState().workout.rows[0][0]).toMatchObject({ rpe: 8, effortAt: 5 })
    a.receive.dispose()
  })
  it('restores the phone value if its snapshot arrives before a conflict receipt', async () => {
    const a = phone(), w = watch(a.S)
    w.ctx.sendEvent({ ...event(a), eventId: undefined })
    const ev = w.sent.find(m => m.t === 'weight')
    const { wireHash: ignored, ...value } = { ...w.snap, commitRev: 2 }
    value.rows = structuredClone(value.rows); value.rows[0][0].w = 80
    w.connection.onMessage({ ...value, wireHash: wireHash(value) })
    expect(w.ctx.loadState().workout.rows[0][0].w).toBe('65')
    w.connection.onMessage({ t: 'committed', eventId: ev.eventId, sid: 's', status: 'conflict', commitRev: 2 })
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(w.ctx.loadState().workout.rows[0][0].w).toBe(80)
    expect(w.ctx.loadState().pendingEdits).toHaveLength(0)
    a.receive.dispose()
  })
  it('accepts a slow watch clock and gives an exact durable commit', async () => {
    const a = phone(), ev = event(a)
    a.S.active.watchVersions = { [ev.entryInstanceId + ':' + ev.setId + ':weight']: Date.now() + 864e5 }
    a.receive(ev); await a.receive.idle()
    expect(a.S.active.entries[0].sets[0].w).toBe(65)
    expect(a.deps.sendAck).not.toHaveBeenCalled()
    expect(a.deps.send).toHaveBeenCalledWith(expect.objectContaining({ t: 'committed', status: 'applied', eventId: ev.eventId }))
    a.receive.dispose()
  })
  it('records concurrent same-field conflicts and replays the same decision', async () => {
    const a = phone(), ev = event(a), before = structuredClone(a.S)
    a.S.active.entries[0].sets[0].w = 80; stampWatchRevision(before, a.S)
    expect(watchConflict(a.S, ev)).toMatchObject({ field: 'weight' })
    a.receive(ev); await a.receive.idle()
    expect(a.S.active.entries[0].sets[0].w).toBe(80)
    expect(a.deps.send).toHaveBeenCalledWith(expect.objectContaining({ status: 'conflict' }))
    a.deps.send.mockClear(); a.receive(ev); await a.receive.idle()
    expect(a.deps.send).toHaveBeenCalledWith(expect.objectContaining({ status: 'conflict' }))
    a.receive.dispose()
  })
  it('merges different fields and sequential edits from the same watch actor', async () => {
    const a = phone(), ev = event(a), before = structuredClone(a.S)
    a.S.active.entries[0].sets[0].r = '12'; stampWatchRevision(before, a.S)
    a.receive(ev); a.receive({ ...ev, eventId: 'v3:B', deviceSeq: 2, weight: '70' }); await a.receive.idle()
    expect(a.S.active.entries[0].sets[0]).toMatchObject({ w: 70, r: '12' })
    expect(a.deps.send.mock.calls.filter(([m]) => m.t === 'committed').every(([m]) => m.status === 'applied')).toBe(true)
    a.receive.dispose()
  })
  it('keeps RECEIVED pending, waits for COMMITTED and reconciles on a newer snapshot', async () => {
    const a = phone(), w = watch(a.S)
    w.ctx.sendEvent({ ...event(a), eventId: undefined })
    const ev = w.sent.find(m => m.t === 'weight')
    expect(ev.protocolVersion).toBe(3)
    w.connection.onMessage({ t: 'received', eventId: ev.eventId, sid: ev.sid })
    expect(w.ctx.pendingCount()).toBe(1)
    expect(w.ctx.synchronizationStatus().phonePending).toBe(1)
    w.connection.onMessage({ t: 'committed', eventId: ev.eventId, sid: ev.sid, status: 'applied', commitRev: 2 })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(w.ctx.pendingCount()).toBe(0)
    expect(w.ctx.loadState().pendingEdits).toHaveLength(1)
    w.ctx.applySync(w.ctx.loadState(), { ...w.snap, commitRev: 2, ackedEvents: [] })
    expect(w.ctx.loadState().pendingEdits).toHaveLength(0)
    a.receive.dispose()
  })
  it('requests a full snapshot after a missing delta and applies a complete chunk transfer atomically', () => {
    const a = phone(), w = watch(a.S)
    w.connection.onMessage({ t: 'sync_delta', sid: 's', baseCommitRev: 999, commitRev: 1000, baseHash: 'missing' })
    expect(w.sent.at(-1)).toMatchObject({ t: 'sync_request', reason: 'revision_gap' })
    const { wireHash: ignored, ...value } = { ...w.snap, workout: 'large'.repeat(4000), commitRev: 2 }
    const next = { ...value, wireHash: wireHash(value) }, chunks = splitWire(next, 'large')
    for (const chunk of chunks.slice(1)) w.connection.onMessage(chunk)
    expect(w.ctx.loadState().commitRev).toBe(1)
    w.connection.onMessage(chunks[0])
    expect(w.ctx.loadState().commitRev).toBe(2)
    expect(w.ctx.loadState().workout.name).toBe(next.workout)
    const { wireHash: old, ...v } = { ...next, commitRev: 3 }; v.rows = structuredClone(v.rows); v.rows[0][0].done = true
    const last = { ...v, wireHash: wireHash(v) }
    w.connection.onMessage(diffWire(next, last))
    expect(w.ctx.loadState().workout.rows[0][0].done).toBe(true)
    a.receive.dispose()
  })
  it('retains a rejected event if the watch cannot save the conflict archive', async () => {
    const a = phone(), w = watch(a.S)
    w.ctx.sendEvent({ ...event(a), eventId: undefined })
    const ev = w.sent.find(m => m.t === 'weight')
    const originalSet = w.ctx.storage.set
    w.ctx.storage.set = opts => opts.key === 'sync_conflicts' ? opts.fail() : originalSet(opts)
    w.connection.onMessage({ t: 'committed', eventId: ev.eventId, sid: ev.sid, status: 'conflict', commitRev: 2 })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(w.ctx.pendingCount()).toBe(1)
    w.ctx.storage.set = originalSet
    w.connection.onMessage({ t: 'committed', eventId: ev.eventId, sid: ev.sid, status: 'conflict', commitRev: 2 })
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(w.ctx.pendingCount()).toBe(0)
    expect(w.disk.get('sync_conflicts')[0].event.eventId).toBe(ev.eventId)
    a.receive.dispose()
  })
})
