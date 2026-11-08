// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { watchPersistence, loadWatchModule, stripImports, watchSource, watchInteractionDeps } from './watch-test-harness.js'
import { applyEdit, applyFocus, applyRest, restOf } from '../../../watch-app/src/lib/protocol.js'
import * as effort from '../../../watch-app/src/lib/effort-scale.js'
import { lastTimeView } from '../../../watch-app/src/lib/watch-last-time.js'
import { createDurableWatchLifecycle } from './watch-commit.js'
import { stampWatchRevision } from './watch-revision.js'
import { watchSnapshotOf } from './watch-workout.js'
import { wireHash } from '../../../watch-app/src/lib/sync-wire.js'
function boot(connected = false) {
  const h = watchPersistence(), c = h.ctx
  Object.assign(c, watchInteractionDeps, effort, { lastTimeView, console, applyEdit, applyFocus, applyRest, restOf, WATCH_VERSION: 'test', startSessionHr: vi.fn(), stopSessionHr: vi.fn(), tick: vi.fn(), restOver: vi.fn(), router: { push: vi.fn(), replace: vi.fn() } })
  loadWatchModule('event-id', c, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', c, ['prepareClose', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markEntry', 'markDelivered', 'releaseCandidate', 'markPhase'])
  loadWatchModule('session', c, ['startSession', 'save', 'loadState', 'closeSession', 'buildSessionSummary', 'summaryEventOf', 'toggleSet', 'nextUndone', 'nextUndoneFrom', 'addRestTime', 'applySync', 'calories'])
  const sent = [], connection = { getReadyState: ({ success }) => success({ status: connected ? 1 : 0 }), send: ({ data, success }) => { sent.push(data); success?.() } }
  c.interconnect = { instance: () => connection }
  loadWatchModule('rpc', c, ['startServer', 'sendEvent', 'replayPendingEvents', 'pendingCount', 'isConnected', 'persistenceStatus', 'synchronizationStatus'])
  return { ...h, c, sent, connection }
}
function plan(sid = 's') { return { sid, protocolVersion: 3, name: '5+2', exercises: [5, 2].map((sets, i) => ({ name: 'Exercise ' + i, entryInstanceId: 'ex' + i, sets, setIds: Array.from({ length: sets }, (_, j) => 'row' + i + '-' + j), weight: '50', reps: '8', restSec: 90 })) } }
function snapshot(h, sid = 's', rev = 1) {
  const p = plan(sid), value = { t: 'sync', ...p, commitRev: rev, startedAt: Date.now(), exIdx: 0, setIdx: 0, rows: p.exercises.map(ex => ex.setIds.map(setId => ({ setId, w: '50', r: '8', done: false, at: 0 }))), rest: { endsAt: 0, totalSec: 0, leftSec: 0, seq: 1 } }
  return { ...value, wireHash: wireHash(value) }
}
const transfer = (msg, id = 'p:test') => ({ transferId: id, sid: msg.sid, revision: msg.commitRev, hash: 'transport-hash' })
function page(h) {
  runInNewContext(stripImports(watchSource('Workout/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'this.page ='), h.c)
  const p = { ...h.c.page, ...h.c.page.data, state: h.c.loadState(), visible: true, restSeq: 0 }
  p.setRestScreenLock = vi.fn(); p.focusCrown = vi.fn()
  p.refresh = function() { this.isRest = !!this.state.restUntil; this.paused = !!this.state.pausedAt; this.rowDone = !!this.state.workout.rows[this.state.exIdx][this.state.setIdx].done; this.autoFocusIgnoreUntil = 0 }
  return p
}
// Faithful SDK facade: methods bind to the live ctx, whose setter ignores receiver.
function bluePage(h, fullRender = false) {
  const ordinary = page(h), methods = h.c.page, bound = {}
  const data = { ...methods.data, state: h.c.loadState(), visible: true, restSeq: 0 }
  const ctx = new Proxy({}, {
    get: (_, key) => Object.hasOwn(data, key) ? data[key] : bound[key],
    set: (_, key, value) => { if (!Object.hasOwn(bound, key)) data[key] = value; return true },
  })
  for (const [key, fn] of Object.entries(methods)) if (typeof fn === 'function') bound[key] = fn.bind(ctx)
  if (!fullRender) bound.refresh = vi.fn(function() { ordinary.refresh.call(ctx) })
  bound.setRestScreenLock = vi.fn(); bound.focusCrown = vi.fn()
  return { ctx, bound }
}
afterEach(() => vi.useRealTimers())
it('keeps received snapshot private with one session write before confirmation', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan())
  const before = h.c.loadState(), msg = snapshot(h), writes = [], original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? writes.push(item) : original(item)
  const result = h.c.commitWireSnapshot(msg, transfer(msg))
  expect(writes).toHaveLength(1); expect(h.c.loadState()).toEqual(before)
  original(writes[0]); expect((await result).ok).toBe(true)
  expect(h.disk.get('session_state').appliedTransfers).toHaveLength(1)
})
it('failed snapshot does not publish unconfirmed authoritative state', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan())
  const before = h.c.loadState(), msg = snapshot(h), original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? item.fail() : original(item)
  expect((await h.c.commitWireSnapshot(msg, transfer(msg))).ok).toBe(false)
  expect(h.c.loadState()).toEqual(before); expect(h.disk.get('session_state')).toEqual(before)
})
it('new sid does not replay inactive old pending edits, focus, pause or heart rate', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan('old'))
  await h.c.commitSessionAction('old', s => { s.exIdx = 1; s.setIdx = 1; s.pausedAt = 123; s.hr.count = 8; s.restTotalSec = 400; h.c.stageSessionEvent(s, { t: 'focus', sid: 'old', ex: 0, set: 2, at: Date.now() }) })
  const old = h.c.loadState(); old.active = false; h.c.save(old)
  const msg = snapshot(h, 'new'); expect((await h.c.commitWireSnapshot(msg, transfer(msg))).ok).toBe(true)
  const s = h.c.loadState()
  expect([s.sid, s.exIdx, s.setIdx]).toEqual(['new', 0, 0]); expect(s.pendingEdits.map(e => e.sid)).toEqual(['old'])
  expect(s.hr.count).toBe(0); expect(s.restTotalSec || 0).toBe(0); expect(s.pausedAt || 0).toBe(0)
})
it('actual Workout 5+2 complete/skip retains every set, focus and intention through old snapshots', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const p = page(h), old = snapshot(h)
  for (let i = 0; i < 7; i++) {
    await vi.advanceTimersByTimeAsync(750); expect(await p.onComplete()).toBe(true); expect(await p.onSkipRest()).toBe(true)
    expect((await h.c.commitWireSnapshot(old, transfer(old, 'p:old-' + i))).ok).toBe(true)
    p.state = h.c.loadState(); p.refresh()
    expect(p.state.workout.rows.flat().filter(r => r.done)).toHaveLength(i + 1)
    const expected = i < 4 ? [0, i + 1] : i < 6 ? [1, i - 4] : [1, 1]
    expect([p.state.exIdx, p.state.setIdx]).toEqual(expected)
  }
  expect(h.c.loadState().pendingEdits.filter(e => e.t === 'set')).toHaveLength(7)
  expect(h.c.loadState().pendingEdits.filter(e => e.t === 'rest')).toHaveLength(7)
})
it('set dots select a completed row for undo without completing another row', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const p = page(h)
  await p.onComplete(); await p.onSkipRest(); p.refreshSetDots()
  expect(await p.pickSetDot(p.setDots[0])).toBe(true)
  expect(p.state.setIdx).toBe(0); expect(p.state.workout.rows[0][0].done).toBe(true)
  expect(await p.onUndo()).toBe(true); expect(p.state.workout.rows[0][0].done).toBe(false)
  expect(p.state.pendingEdits.filter(e => e.t === 'unset')).toHaveLength(1)
})


it('BlueOS bound-method Proxy page never leaks draft flags or changes UI before storage succeeds', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan())
  const { ctx, bound } = bluePage(h)
  const writes = [], original = h.storage.set, before = h.c.loadState()
  h.storage.set = item => item.key === 'session_state' ? writes.push(item) : original(item)
  const action = ctx.onComplete()
  expect(ctx.state).toEqual(before)
  expect(ctx.sessionActionDraft).not.toBe(true)
  expect(bound.refresh).not.toHaveBeenCalled(); expect(bound.setRestScreenLock).not.toHaveBeenCalled()
  original(writes.shift()); expect(await action).toBe(true)
  expect(ctx.sessionActionDraft).not.toBe(true)
  expect(bound.refresh).toHaveBeenCalledOnce()
  const skip = ctx.onSkipRest()
  expect(writes).toHaveLength(1)
  original(writes.shift()); expect(await skip).toBe(true)
  expect(ctx.state.restUntil).toBe(0)
})


it('durable new-session notification replaces old page and clears session-only interaction state without another write', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan('old')); const p = page(h)
  p.closeMode = 'complete'; p.effortOn = true; p.menuOn = true; p.finishOn = true; p.lastOpen = true
  p.completionIgnoreUntil = Date.now() + 99999; p.restStartAt = 123; p.restCrownDirty = true
  p.effortTarget = { sid: 'old' }; p.pageIndex = 1
  const old = h.c.loadState(); old.active = false; h.c.save(old)
  const msg = snapshot(h, 'new'); expect((await h.c.commitWireSnapshot(msg, transfer(msg))).ok).toBe(true)
  const write = vi.spyOn(h.storage, 'set')
  p.onSyncUpdate(msg, { persisted: true })
  expect([p.state.sid, p.state.exIdx, p.state.setIdx]).toEqual(['new', 0, 0])
  expect([p.closeMode, p.effortOn, p.menuOn, p.finishOn, p.lastOpen, p.restCrownDirty]).toEqual(['', false, false, false, false, false])
  expect(p.completionIgnoreUntil).toBe(0); expect(p.restStartAt).toBe(0); expect(p.effortTarget).toBe(null); expect(p.pageIndex).toBe(0)
  expect(write.mock.calls.filter(([item]) => item.key === 'session_state')).toHaveLength(0)
  expect(await p.onComplete()).toBe(true); expect(p.state.workout.rows[0][0].done).toBe(true)
  p.onSyncUpdate(snapshot(h, 'old'), { persisted: true }); expect(p.state.sid).toBe('new')
})


it('SDK Proxy 5+2 with real render survives delayed disk, old downlinks and the exercise boundary', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  const old = snapshot(h), writes = [], original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? writes.push(item) : original(item)
  p.refresh()
  async function durable(action) {
    const done = action(); expect(writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(25); original(writes.shift()); expect(await done).toBe(true)
    expect(p.sessionActionDraft).not.toBe(true)
  }
  for (let i = 0; i < 7; i++) {
    // Genuine touch clears the deliberate synthetic-tap suppression after auto-focus.
    await vi.advanceTimersByTimeAsync(1100)
    p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); p.touchCancel()
    await durable(() => p.onComplete())
    p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); p.touchCancel()
    await durable(() => p.onSkipRest())
    const downlink = h.c.commitWireSnapshot(old, transfer(old, 'p:proxy-' + i))
    expect(writes).toHaveLength(1); original(writes.shift()); expect((await downlink).ok).toBe(true)
    p.onSyncUpdate(old, { persisted: true })
    expect(p.state.workout.rows.flat().filter(r => r.done)).toHaveLength(i + 1)
    expect([p.state.exIdx, p.state.setIdx]).toEqual(i < 4 ? [0, i + 1] : i < 6 ? [1, i - 4] : [1, 1])
    expect(p.exName).toBe(i < 4 ? 'Exercise 0' : 'Exercise 1')
  }
  expect(p.allFinished).toBe(true)
  expect(h.disk.get('session_state').pendingEdits.filter(e => e.t === 'set')).toHaveLength(7)
})
it('SDK Proxy write failure preserves live page and disk and permits retry', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p, bound } = bluePage(h)
  const before = h.c.loadState(), original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? item.fail() : original(item)
  expect(await p.onComplete()).toBe(false); expect(p.state).toEqual(before)
  expect(h.disk.get('session_state')).toEqual(before); expect(bound.refresh).not.toHaveBeenCalled()
  expect(p.sessionActionDraft).not.toBe(true); expect(p.localCommitPending).toBe(false)
  h.storage.set = original; expect(await p.onComplete()).toBe(true)
  expect(p.state.workout.rows[0][0].done).toBe(true)
})

it('legacy pending without sid replays only in its original session and remains queued across a new sid', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan('old'))
  let s = h.c.loadState(); s.pendingEdits = [{ t: 'focus', eventId: 'legacy', ex: 0, set: 2, at: Date.now() }]; h.c.save(s)
  const current = snapshot(h, 'old'); expect((await h.c.commitWireSnapshot(current, transfer(current, 'p:legacy'))).ok).toBe(true)
  expect(h.c.loadState().setIdx).toBe(1)
  s = h.c.loadState(); s.active = false; h.c.save(s)
  const next = snapshot(h, 'new'); expect((await h.c.commitWireSnapshot(next, transfer(next, 'p:new'))).ok).toBe(true)
  expect(h.c.loadState().setIdx).toBe(0); expect(h.c.loadState().pendingEdits[0]).toMatchObject({ sid: 'old', eventId: 'legacy' })
})

// Exercise phone revisions + exact receipts, not just old watch snapshots.
function paired() {
  const h = boot(true), workout = plan()
  const S = { unit: 'kg', workouts: [], active: { start: Date.now(), watchSid: 's', name: '5+2',
    entries: workout.exercises.map(ex => ({ id: 'plain-bench', name: ex.name, entryInstanceId: ex.entryInstanceId,
      sets: ex.setIds.map(setId => ({ setId, w: 50, r: '8', done: false })) })) } }
  stampWatchRevision({}, S)
  let timer = null, cursor = 0
  const replies = [], snapshots = []
  const deps = { getState: () => S, getTimer: () => timer, checkpoint: async () => {},
    update: (fn, ev) => { const prev = structuredClone(S); fn(S); stampWatchRevision(prev, S, ev?.installationId || 'watch', ev?.eventId) },
    rest: ev => { timer = ev.leftSec ? { ...ev, source: 'watch' } : null },
    send: msg => replies.push(structuredClone(msg)), sendAck() {}, sendEnded() {}, finish() {},
    sendSync: snap => snapshots.push({ ...snap, t: 'sync', protocolVersion: 3 }) }
  const receive = createDurableWatchLifecycle(deps)
  h.c.startSession(workout)
  const { ctx: p } = bluePage(h, true)
  p.bindRpc()
  h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true } })
  async function sync(value) {
    const msg = { ...value, wireHash: wireHash(value) }
    const result = await h.c.commitWireSnapshot(msg, transfer(msg, 'p:pair-' + msg.commitRev))
    expect(result.ok).toBe(true)
    p.onSyncUpdate(msg, { persisted: true })
    await vi.advanceTimersByTimeAsync(1)
  }
  async function pump(withSnapshots = true) {
    for (let i = 0; i < 90; i++) {
      for (const msg of h.sent.slice(cursor)) if (msg.eventId && msg.t !== 'hello') receive(msg)
      cursor = h.sent.length
      await receive.idle()
      for (const msg of replies.splice(0)) h.connection.onMessage(msg)
      if (withSnapshots && snapshots.length) await sync(snapshots.pop())
      if (withSnapshots) snapshots.length = 0
      await vi.advanceTimersByTimeAsync(150)
      if (!h.c.pendingCount() && cursor === h.sent.length) break
    }
  }
  return { ...h, p, S, deps, receive, sync, pump, snapshots }
}
it('phone receipts and snapshots preserve rapid watch-only 5+2 completion across the fifth set', async () => {
  vi.useFakeTimers(); const a = paired()
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  try {
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(710)
      a.p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); a.p.touchCancel()
      expect(await a.p.onComplete()).toBe(true)
      a.p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); a.p.touchCancel()
      expect(await a.p.onSkipRest()).toBe(true)
      await a.pump(i % 2 === 0)
      expect(a.S.active.entries.flatMap(e => e.sets).filter(r => r.done)).toHaveLength(i + 1)
      expect(a.c.synchronizationStatus().conflicts).toBe(0)
      expect([a.p.state.exIdx, a.p.state.setIdx]).toEqual(i < 4 ? [0, i + 1] : i < 6 ? [1, i - 4] : [1, 1])
      expect(a.p.localCommitPending).toBe(false)
    }
  } finally { a.receive.dispose() }
})

it('real Workout restores phone authority when a persisted snapshot overtakes a negative receipt', async () => {
  vi.useFakeTimers(); const a = paired()
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  try {
    a.c.sendEvent({ t: 'weight', sid: 's', ex: 0, set: 1, weight: '65', at: Date.now() })
    const ev = a.c.loadState().pendingEdits.at(-1)
    const before = structuredClone(a.S)
    a.S.active.entries[0].sets[0].w = 80; stampWatchRevision(before, a.S)
    await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
    expect(a.c.loadState().workout.rows[0][0].w).toBe('65')
    a.connection.onMessage({ t: 'committed', sid: 's', eventId: ev.eventId, status: 'conflict', resolution: 'phone', commitRev: a.S.active.syncRev })
    await vi.advanceTimersByTimeAsync(10)
    expect(a.c.loadState().workout.rows[0][0].w).toBe(80)
    expect(a.p.state.workout.rows[0][0].w).toBe(80)
    expect(a.c.pendingCount()).toBe(0)
    expect(a.c.synchronizationStatus().conflicts).toBe(0)
  } finally { a.receive.dispose() }
})

it('drains a full rapid 5+2 backlog without rolling focus back at the exercise boundary', async () => {
  vi.useFakeTimers(); const a = paired()
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  try {
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(710)
      a.p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); a.p.touchCancel()
      expect(await a.p.onComplete()).toBe(true)
      a.p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); a.p.touchCancel()
      expect(await a.p.onSkipRest()).toBe(true)
    }
    expect(a.c.loadState().pendingEdits.filter(e => e.t === 'set')).toHaveLength(7)
    await a.pump()
    expect(a.c.pendingCount()).toBe(0)
    expect(a.S.active.entries.flatMap(e => e.sets).filter(r => r.done)).toHaveLength(7)
    expect([a.p.state.exIdx, a.p.state.setIdx]).toEqual([1, 1])
    expect(a.p.localCommitPending).toBe(false)
    expect(a.c.synchronizationStatus().conflicts).toBe(0)
  } finally { a.receive.dispose() }
})

it('phone wins a conflicting parent while unrelated pending work and heart rate survive reconciliation', async () => {
  vi.useFakeTimers(); const a = paired()
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  try {
    a.c.sendEvent({ t: 'weight', sid: 's', ex: 0, set: 1, weight: '65', at: Date.now() })
    a.c.sendEvent({ t: 'reps', sid: 's', ex: 0, set: 2, reps: '12', at: Date.now() + 1 })
    const ev = a.c.loadState().pendingEdits.find(e => e.t === 'weight')
    const local = a.c.loadState(); local.hr.count = 3; local.hr.max = 150; a.c.save(local)
    const before = structuredClone(a.S)
    a.S.active.entries[0].sets[0].w = 80; stampWatchRevision(before, a.S)
    await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
    a.connection.onMessage({ t: 'committed', sid: 's', eventId: ev.eventId, status: 'conflict', resolution: 'phone', commitRev: a.S.active.syncRev })
    await vi.advanceTimersByTimeAsync(10)
    expect(a.p.state.workout.rows[0][0].w).toBe(80)
    expect(a.c.loadState().pendingEdits.some(e => e.t === 'reps')).toBe(true)
    expect(a.p.state.workout.rows[0][1].r).toBe('12')
    expect(a.c.loadState().hr.count).toBe(3)
    await a.pump()
    expect(a.S.active.entries[0].sets[0].w).toBe(80)
    expect(a.S.active.entries[0].sets[1].r).toBe('12')
  } finally { a.receive.dispose() }
})

it.each(['sync_conflicts', 'event_decisions', 'session_state'])('retains the exact pending event when phone resolution cannot save %s', async key => {
  vi.useFakeTimers(); const a = paired()
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  try {
    a.c.sendEvent({ t: 'weight', sid: 's', ex: 0, set: 1, weight: '65', at: Date.now() })
    const ev = a.c.loadState().pendingEdits.at(-1)
    const before = structuredClone(a.S)
    a.S.active.entries[0].sets[0].w = 80; stampWatchRevision(before, a.S)
    await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
    const receipt = { t: 'committed', sid: 's', eventId: ev.eventId, status: 'conflict', resolution: 'phone', commitRev: a.S.active.syncRev }
    const original = a.storage.set
    a.storage.set = item => item.key === key ? item.fail() : original(item)
    a.connection.onMessage(receipt); await vi.advanceTimersByTimeAsync(10)
    expect(a.c.pendingCount()).toBe(1)
    expect(a.c.loadState().pendingEdits.some(e => e.eventId === ev.eventId)).toBe(true)
    a.storage.set = original
    a.connection.onMessage(receipt); await vi.advanceTimersByTimeAsync(10)
    expect(a.c.pendingCount()).toBe(0)
    expect(a.p.state.workout.rows[0][0].w).toBe(80)
    expect(a.disk.get('event_decisions')[ev.eventId]).toMatchObject({ status: 'conflict', resolution: 'phone' })
  } finally { a.receive.dispose() }
})
