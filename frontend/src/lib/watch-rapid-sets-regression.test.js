// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { watchPersistence, loadWatchModule, stripImports, watchSource, watchInteractionDeps, watchSdkTimers } from './watch-test-harness.js'
import { applyEdit, applyFocus, applyRest, restOf } from '../../../watch-app/src/lib/protocol.js'
import * as effort from '../../../watch-app/src/lib/effort-scale.js'
import { lastTimeView } from '../../../watch-app/src/lib/watch-last-time.js'
import { createDurableWatchLifecycle } from './watch-commit.js'
import { ensureWatchIdentity } from './watch-identity.js'
import { stampWatchRevision } from './watch-revision.js'
import { watchSnapshotOf } from './watch-workout.js'
import { createCommandStateCache } from './watch-command-state.js'
import { broadcastPhoneRest } from './watch-rest-broadcast.js'
import { canonicalWire, wireHash } from '../../../watch-app/src/lib/sync-wire.js'
function boot(connected = false, disk) {
  const h = watchPersistence(disk), c = h.ctx
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
  const pick = p.pickSetDot(p.setDots[0]); await vi.advanceTimersByTimeAsync(150)
  expect(await pick).toBe(true)
  expect(p.state.setIdx).toBe(0); expect(p.state.workout.rows[0][0].done).toBe(true)
  expect(await p.onUndo()).toBe(true); expect(p.state.workout.rows[0][0].done).toBe(false)
  expect(p.state.pendingEdits.filter(e => e.t === 'unset')).toHaveLength(1)
})

it('keeps native dot array and row identities through refreshes and cursor changes', () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh()
  const dots = p.setDots, items = dots.slice()
  for (let i = 0; i < 100; i++) p.refresh()
  expect(p.setDots).toBe(dots)
  p.state.setIdx = 3; p.refresh()
  expect(p.setDots).toBe(dots)
  for (let i = 0; i < items.length; i++) expect(p.setDots[i]).toBe(items[i])
  expect(p.setDots.map(d => d.current)).toEqual([false, false, false, true, false])
  expect(new Set(p.setDots.map(d => d.key)).size).toBe(5)
  p.state.exIdx = 1; p.state.setIdx = 0; p.refresh()
  expect(p.setDots).not.toBe(dots); expect(p.setDots).toHaveLength(2)
  expect(p.setDots.every(d => !items.some(old => old.key === d.key))).toBe(true)
})

it('does not persist or enqueue repeated taps on the selected dot', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const before = h.c.loadState(), write = vi.spyOn(h.storage, 'set')
  for (let i = 0; i < 40; i++) {
    p.pickSetDot(p.setDots[0]); await vi.advanceTimersByTimeAsync(150)
  }
  expect(h.c.loadState()).toEqual(before)
  expect(write.mock.calls.filter(([item]) => item.key === 'session_state')).toHaveLength(0)
})

it('coalesces a 200-tap burst into the final stable target before accepting one durable intent', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const dots = p.setDots, write = vi.spyOn(h.storage, 'set')
  let picked
  for (let i = 0; i < 200; i++) picked = p.pickSetDot(dots[i % 5])
  expect(h.c.loadState().setIdx).toBe(0)
  await vi.advanceTimersByTimeAsync(150); expect(await picked).toBe(true)
  expect(h.c.loadState().setIdx).toBe(4)
  expect(h.c.loadState().pendingEdits.filter(e => e.t === 'focus')).toHaveLength(1)
  expect(write.mock.calls.filter(([item]) => item.key === 'session_state')).toHaveLength(1)
  expect(p.setDots).toBe(dots)
})

it('retains the last tap during slow storage with only one write in flight', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const dots = p.setDots, writes = [], original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? writes.push(item) : original(item)
  const first = p.pickSetDot(dots[1]); await vi.advanceTimersByTimeAsync(150)
  expect(writes).toHaveLength(1)
  for (let i = 0; i < 100; i++) p.pickSetDot(dots[2 + i % 3])
  const last = p.pickSetDot(dots[4])
  await vi.advanceTimersByTimeAsync(150); expect(writes).toHaveLength(1)
  original(writes.shift()); await vi.advanceTimersByTimeAsync(150)
  expect(writes).toHaveLength(1)
  original(writes.shift()); await vi.advanceTimersByTimeAsync(150)
  expect(await first).toBe(true); expect(await last).toBe(true)
  expect(h.c.loadState().setIdx).toBe(4)
  expect(h.c.loadState().pendingEdits.filter(e => e.t === 'focus').map(e => e.set)).toEqual([2, 5])
})

it('renders the tapped group immediately while session storage takes two seconds', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  const s = h.c.loadState(); s.workout.rows[0][2].w = '77.5'; h.c.save(s)
  p.state = h.c.loadState(); p.refresh()
  const writes = [], original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? writes.push(item) : original(item)
  const picked = p.pickSetDot(p.setDots[2])
  expect(p.state.setIdx).toBe(2)
  expect(p.weightNum).toBe('77.5')
  expect(p.setDots.map(d => d.current)).toEqual([false, false, true, false, false])
  expect(h.c.loadState().setIdx).toBe(0)
  await vi.advanceTimersByTimeAsync(2000)
  expect(writes).toHaveLength(1); expect(p.state.setIdx).toBe(2)
  original(writes.shift()); expect(await picked).toBe(true)
  expect(h.c.loadState().setIdx).toBe(2)
})

it('keeps a newer dot visible when an older dot finishes writing', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const dots = p.setDots, writes = [], original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? writes.push(item) : original(item)
  const picked = p.pickSetDot(dots[1]); await vi.advanceTimersByTimeAsync(150)
  p.pickSetDot(dots[4]); expect(p.state.setIdx).toBe(4)
  original(writes.shift()); await vi.advanceTimersByTimeAsync(150)
  expect(p.state.setIdx).toBe(4)
  original(writes.shift()); expect(await picked).toBe(true)
  expect(h.c.loadState().setIdx).toBe(4)
})

it('returns the preview to the saved group on storage failure without sending a focus', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const writes = [], original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? writes.push(item) : original(item)
  const picked = p.pickSetDot(p.setDots[2]); expect(p.state.setIdx).toBe(2)
  await vi.advanceTimersByTimeAsync(150); writes.shift().fail()
  expect(await picked).toBe(false); expect(p.state.setIdx).toBe(0)
  expect(p.inputNotice).toContain('存储失败')
  expect(h.c.loadState().pendingEdits || []).toHaveLength(0)
})

it.each(['leave', 'completion-reset'])('keeps the preview out of shared saves during %s', mode => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  if (mode === 'completion-reset') {
    const s = h.c.loadState(); s.completionAcknowledged = true; h.c.save(s); p.state = h.c.loadState()
    // Arm this refresh side effect only after preview selection.
    p.effortOn = true
  }
  p.refresh(); p.pickSetDot(p.setDots[2])
  if (mode === 'leave') p.leaveTraining()
  else { p.effortOn = false; p.refresh() }
  expect(h.c.loadState().setIdx).toBe(0)
  expect(p.state.setIdx).toBe(2)
})

it.each(['hide', 'destroy', 'new-session'])('cancels uncommitted dot input on %s', async mode => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); p.pickSetDot(p.setDots[4])
  if (mode === 'hide') p.onHide()
  else if (mode === 'destroy') p.onDestroy()
  else { h.c.startSession(plan('new')); p.adoptSession(h.c.loadState()) }
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.c.loadState().setIdx).toBe(0)
  expect(h.c.loadState().pendingEdits || []).toHaveLength(0)
})

it('returning to the current dot cancels an uncommitted move without a durable write', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const write = vi.spyOn(h.storage, 'set')
  p.pickSetDot(p.setDots[4]); const back = p.pickSetDot(p.setDots[0])
  await vi.advanceTimersByTimeAsync(150)
  expect(await back).toBe(false); expect(h.c.loadState().setIdx).toBe(0)
  expect(write.mock.calls.filter(([item]) => item.key === 'session_state')).toHaveLength(0)
})

it('resolves a stale dot by stable row identity rather than its old selected index', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const old = p.setDots[0], s = h.c.loadState()
  s.workout.rows[0].reverse(); s.workout.exercises[0].setIds.reverse()
  h.c.save(s); p.state = h.c.loadState(); p.refresh()
  const pick = p.pickSetDot(old); await vi.advanceTimersByTimeAsync(150)
  expect(await pick).toBe(true); expect(h.c.loadState().setIdx).toBe(4)
  expect(h.c.loadState().pendingEdits.at(-1).setId).toBe('row0-0')
})

it('keeps the tapped causal version when a newer phone snapshot arrives before dot commit', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const rev = p.state.commitRev || 0, pick = p.pickSetDot(p.setDots[4]), msg = snapshot(h, 's', rev + 10)
  expect((await h.c.commitWireSnapshot(msg, transfer(msg))).ok).toBe(true)
  p.state = h.c.loadState(); p.refresh()
  await vi.advanceTimersByTimeAsync(150); expect(await pick).toBe(true)
  expect(h.c.loadState().pendingEdits.at(-1).baseCommitRev).toBe(rev)
})

it.each(['paused', 'rest', 'deleted'])('rejects queued dot input after the target becomes %s', async change => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const pick = p.pickSetDot(p.setDots[4]), s = h.c.loadState()
  if (change === 'paused') s.pausedAt = Date.now()
  else if (change === 'rest') s.restUntil = Date.now() + 10000
  else { s.workout.rows[0].pop(); s.workout.exercises[0].setIds.pop(); s.workout.exercises[0].sets-- }
  h.c.save(s); p.state = h.c.loadState(); p.refresh()
  await vi.advanceTimersByTimeAsync(150); expect(await pick).toBe(false)
  expect(h.c.loadState().pendingEdits || []).toHaveLength(0)
})

it('phone focus remains authoritative when it changes while a dot tap is queued', async () => {
  vi.useFakeTimers(); const a = paired()
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  try {
    const rev = a.p.state.commitRev, pick = a.p.pickSetDot(a.p.setDots[4]), before = structuredClone(a.S)
    a.S.active.watchFocus = { ex: 0, set: 2, at: Date.now() + 1 }
    stampWatchRevision(before, a.S)
    await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
    await vi.advanceTimersByTimeAsync(150); await pick
    for (const ev of a.c.loadState().pendingEdits || []) expect(ev.baseCommitRev).toBe(rev)
    await a.pump()
    expect(a.S.active.watchFocus.set).toBe(2)
    expect(a.p.state.setIdx).toBe(1)
    expect(a.c.pendingCount()).toBe(0)
    expect(a.c.synchronizationStatus().conflicts).toBe(0)
  } finally { a.receive.dispose() }
})

it('queues one completion for the displayed row while a dot selection is waiting to commit', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const pick = p.pickSetDot(p.setDots[3])
  const completion = p.onCurrentSetAction()
  expect(p.onCurrentSetAction()).toBe(completion)
  expect(h.c.loadState().workout.rows.flat().some(r => r.done)).toBe(false)
  await vi.advanceTimersByTimeAsync(150); expect(await pick).toBe(true)
  expect(await completion).toBe(true)
  expect(h.c.loadState().workout.rows[0][3].done).toBe(true)
  expect(h.c.loadState().workout.rows[0][0].done).toBe(false)
})

it.each(['another-dot', 'hide', 'failed-write', 'phone-rest'])('does not complete a different or cancelled preview after %s', async mode => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const dots = p.setDots, writes = [], original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? writes.push(item) : original(item)
  const pick = p.pickSetDot(dots[3]), completion = p.onCurrentSetAction()
  if (mode === 'another-dot') p.pickSetDot(dots[4])
  else if (mode === 'hide') p.onHide()
  else if (mode === 'phone-rest') {
    const s = h.c.loadState(); s.restUntil = Date.now() + 30000
    h.storage.set = original; h.c.save(s); p.state = h.c.loadState(); p.refresh()
  }
  await vi.advanceTimersByTimeAsync(150)
  if (mode === 'failed-write') writes.shift().fail()
  else while (writes.length) { original(writes.shift()); await vi.advanceTimersByTimeAsync(150) }
  await pick; expect(await completion).toBe(false)
  expect(h.c.loadState().workout.rows.flat().some(r => r.done)).toBe(false)
})

it('keeps a queued completion from becoming undo when the phone completes that row first', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); const pick = p.pickSetDot(p.setDots[3]), completion = p.onCurrentSetAction()
  const s = h.c.loadState(); s.workout.rows[0][3].done = true; s.workout.rows[0][3].at = Date.now()
  h.c.save(s); p.state = h.c.loadState(); p.refresh()
  await vi.advanceTimersByTimeAsync(150); await pick; await completion
  expect(h.c.loadState().workout.rows[0][3].done).toBe(true)
  expect(h.c.loadState().pendingEdits.some(e => e.t === 'unset' || e.t === 'set')).toBe(false)
})

it('rechecks the completion identity inside the transaction after a deleting snapshot', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan()); const { ctx: p } = bluePage(h, true)
  p.refresh(); p.bindRpc()
  const writes = [], original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? writes.push(item) : original(item)
  const pick = p.pickSetDot(p.setDots[3]), completion = p.onCurrentSetAction()
  await vi.advanceTimersByTimeAsync(150); expect(writes).toHaveLength(1)
  const raw = snapshot(h, 's', 10)
  raw.exercises[0].sets = 3; raw.exercises[0].setIds = raw.exercises[0].setIds.slice(0, 3)
  raw.rows[0] = raw.rows[0].slice(0, 3); raw.setIdx = 1
  const msg = canonicalWire(raw), syncing = h.c.commitWireSnapshot(msg, transfer(msg))
  original(writes.shift()); await vi.advanceTimersByTimeAsync(0)
  expect(writes).toHaveLength(1); expect(p.state.setIdx).toBe(3)
  original(writes.shift()); await vi.advanceTimersByTimeAsync(0)
  while (writes.length) { original(writes.shift()); await vi.advanceTimersByTimeAsync(0) }
  await syncing; await pick; await completion
  expect(h.c.loadState().workout.rows.flat().some(r => r.done)).toBe(false)
  expect(h.c.loadState().pendingEdits.some(e => e.t === 'set' || e.t === 'unset')).toBe(false)
})

it('SDK timers release the dot gate before completing and skipping the selected row', async () => {
  vi.useFakeTimers(); const h = boot(); h.c.startSession(plan())
  const timers = watchSdkTimers(), dotContext = { Date, ...timers }
  loadWatchModule('workout-interaction', dotContext, ['createSetDotPicker'])
  h.c.createSetDotPicker = dotContext.createSetDotPicker
  const { ctx: p } = bluePage(h, true)
  p.refresh()
  await p.onComplete()
  p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); p.touchCancel()
  await p.onSkipRest()
  await vi.advanceTimersByTimeAsync(1100)
  const pick = p.pickSetDot(p.setDots[3])
  expect(p.interactionBlocked()).toBe(true)
  await vi.advanceTimersByTimeAsync(150)
  expect(p.interactionBlocked()).toBe(false)
  expect(await pick).toBe(true)
  expect(timers.rejected).toEqual([])
  expect(p.state.setIdx).toBe(3)
  p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); p.touchCancel()
  await p.onCurrentSetAction()
  expect(h.c.loadState().workout.rows[0][3].done).toBe(true)
  p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); p.touchCancel()
  expect(await p.onSkipRest()).toBe(true)
  expect(p.state.restUntil).toBe(0)
  expect(p.localCommitPending).toBe(false)
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
it('unlocks undo and later sets after a dot tap, phone completion of set two, and watch rest skip', async () => {
  vi.useFakeTimers(); const a = paired()
  try {
    const timers = watchSdkTimers(), ctx = { Date, ...timers }
    loadWatchModule('workout-interaction', ctx, ['createSetDotPicker'])
    a.c.createSetDotPicker = ctx.createSetDotPicker
    a.S.active.entries[0].sets[0].done = true
    a.S.active.watchFocus = { ex: 0, set: 1, at: Date.now() }
    await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
    const pick = a.p.pickSetDot(a.p.setDots[1])
    await vi.advanceTimersByTimeAsync(150)
    await pick
    const before = structuredClone(a.S), now = Date.now()
    a.S.active.entries[0].sets[1].done = true
    a.S.active.entries[0].sets[1].at = now
    a.S.active.watchFocus = { ex: 0, set: 2, at: now }
    a.S.active.restVersion = now
    stampWatchRevision(before, a.S)
    const timer = { restId: 'phone-set-two', startedAt: now, endsAt: now + 60000, total: 60, seq: now }
    await a.sync({ ...watchSnapshotOf(a.S, timer), t: 'sync', protocolVersion: 3 })
    expect(a.p.isRest).toBe(true)
    a.p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); a.p.touchCancel()
    expect(await a.p.onSkipRest()).toBe(true)
    expect([a.p.state.setIdx, a.p.rowDone, a.p.isRest]).toEqual([1, true, false])
    a.p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); a.p.touchCancel()
    expect(a.p.interactionBlocked()).toBe(false)
    expect(await a.p.onCurrentSetAction()).toBe(true)
    expect(a.c.loadState().workout.rows[0][1].done).toBe(false)
    a.p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); a.p.touchCancel()
    const third = a.p.pickSetDot(a.p.setDots[2])
    await vi.advanceTimersByTimeAsync(150); expect(await third).toBe(true)
    a.p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); a.p.touchCancel()
    expect(await a.p.onCurrentSetAction()).toBe(true)
    expect(a.c.loadState().workout.rows[0][2].done).toBe(true)
  } finally { a.receive.dispose() }
})

it.each(['none', 'skip', 'new-round', 'same-round'])('phone rest updates reconcile the actual page with preview=%s', async mode => {
  vi.useFakeTimers(); const a = paired()
  try {
    await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
    const before = structuredClone(a.S), now = Date.now()
    a.S.active.entries[0].sets[0].done = true
    a.S.active.entries[0].sets[0].at = now
    a.S.active.restVersion = now
    stampWatchRevision(before, a.S)
    const timer = { restId: 'phone-rest', startedAt: now, endsAt: now + 60000, total: 60, seq: now }
    const start = canonicalWire({ ...watchSnapshotOf(a.S, timer), t: 'sync', protocolVersion: 3 })
    expect((await a.c.commitWireSnapshot(start, transfer(start))).ok).toBe(true)
    a.shared.rpc.handlers.onSync(start, { persisted: true })
    expect(a.p.isRest).toBe(true)
    if (mode !== 'none') a.p.queueRestNudge(5)
    const previous = structuredClone(a.S)
    a.S.active.restVersion = mode === 'same-round' ? now : now + 1
    stampWatchRevision(previous, a.S)
    const nextTimer = mode === 'same-round' ? timer : mode === 'new-round' ? { ...timer, restId: 'next-rest', total: 30, endsAt: now + 30000, seq: now + 1 } : null
    const stop = canonicalWire({ ...watchSnapshotOf(a.S, nextTimer), t: 'sync', protocolVersion: 3 })
    expect((await a.c.commitWireSnapshot(stop, transfer(stop, 'p:phone-stop'))).ok).toBe(true)
    a.shared.rpc.handlers.onSync(stop, { persisted: true })
    const expected = mode === 'same-round' ? now + 65000 : nextTimer?.endsAt || 0
    expect(a.c.loadState().restUntil).toBe(nextTimer?.endsAt || 0)
    expect(a.p.state.restUntil).toBe(expected)
    expect(a.p.isRest).toBe(!!expected)
    expect(!!a.p.restCrownDirty).toBe(mode === 'same-round')
    expect(a.c.diagnosticLog().events.findLast(e => e.stage === 'page_sync')).toMatchObject({ restUntil: expected, crownDirty: mode === 'same-round' })
    await vi.advanceTimersByTimeAsync(400)
    expect(a.c.loadState().pendingEdits.filter(e => e.t === 'rest')).toHaveLength(mode === 'same-round' ? 1 : 0)
    expect(a.p.isRest).toBe(!!expected)
  } finally { a.receive.dispose() }
})

it('records a page callback failure separately from a durable phone receipt', async () => {
  vi.useFakeTimers(); const a = paired(true, true)
  try {
    await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
    a.shared.rpc.handlers.onSync = () => { throw new Error('page refresh failed') }
    expect(await a.p.onComplete()).toBe(true)
    await a.pump(false)
    expect(a.c.pendingCount()).toBe(0)
    expect(a.c.loadState().workout.rows[0][0].done).toBe(true)
    expect(a.c.diagnosticLog().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'page_sync_error', detail: 'page refresh failed' }),
    ]))
  } finally { a.receive.dispose() }
})

function paired(bootstrapPlan = true, compact = false) {
  const commandStates = createCommandStateCache()
  const h = boot(true), workout = plan()
  const S = { unit: 'kg', workouts: [], active: { start: Date.now(), watchSid: 's', name: '5+2',
    entries: workout.exercises.map(ex => ({ id: 'plain-bench', name: ex.name, entryInstanceId: ex.entryInstanceId,
      sets: ex.setIds.map(setId => ({ setId, w: 50, r: '8', done: false })) })) } }
  ensureWatchIdentity(S.active)
  stampWatchRevision({}, S)
  let timer = null, cursor = 0
  const replies = [], snapshots = []
  const deps = { getState: () => S, getTimer: () => timer, checkpoint: async () => {},
    commandState: compact ? commandStates.prepare : undefined,
    update: (fn, ev) => { const prev = structuredClone(S); fn(S); stampWatchRevision(prev, S, ev?.installationId || 'watch', ev?.eventId) },
    rest: ev => { timer = ev.leftSec ? { ...ev, source: 'watch' } : null },
    send: msg => replies.push(structuredClone(msg)), sendAck() {}, sendEnded() {}, finish() {},
    sendSync: snap => snapshots.push({ ...snap, t: 'sync', protocolVersion: 3 }) }
  const receive = createDurableWatchLifecycle(deps)
  if (bootstrapPlan) h.c.startSession(workout)
  const { ctx: p } = bluePage(h, true)
  p.bindRpc()
  h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true, commandReceipts: compact } })
  async function sync(value) {
    const msg = canonicalWire(value)
    commandStates.remember(msg)
    const result = await h.c.commitWireSnapshot(msg, transfer(msg, 'p:pair-' + msg.commitRev))
    expect(result.ok).toBe(true)
    p.onSyncUpdate(msg, { persisted: true })
    await vi.advanceTimersByTimeAsync(1)
  }
  async function pump(withSnapshots = true, device = h) {
    for (let i = 0; i < 90; i++) {
      for (const msg of device.sent.slice(cursor)) if (msg.eventId && msg.t !== 'hello') receive(msg)
      cursor = device.sent.length
      await receive.idle()
      for (const msg of replies.splice(0)) device.connection.onMessage(msg)
      if (withSnapshots && snapshots.length) await sync(snapshots.pop())
      if (withSnapshots) snapshots.length = 0
      await vi.advanceTimersByTimeAsync(150)
      if (!device.c.pendingCount() && cursor === device.sent.length) break
    }
  }
  return { ...h, p, S, deps, receive, sync, pump, snapshots, commandStates, replies }
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

// Reproduce App's mount/session-start rest effect, absent from earlier RPC-only fixtures.
it('idle phone rest effect does not reject the first watch completion', async () => {
  vi.useFakeTimers(); const a = paired()
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  try {
    broadcastPhoneRest({ enabled: true, active: a.S.active, timer: null, stopSource: 'phone', update: fn => {
      const before = structuredClone(a.S); fn(a.S); stampWatchRevision(before, a.S)
    }, send() {} })
    expect(await a.p.onComplete()).toBe(true)
    await a.pump()
    expect(a.S.active.entries[0].sets[0].done).toBe(true)
    expect(a.c.loadState().workout.rows[0][0].done).toBe(true)
    expect(a.S.watchConflicts || {}).toEqual({})
  } finally { a.receive.dispose() }
})
it('watch save closes the phone after pending set and rest confirmations', async () => {
  vi.useFakeTimers(); const a = paired()
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  a.deps.finish = () => { a.S.workouts.push(a.S.active); a.S.active = null }
  try {
    expect(await a.p.onComplete()).toBe(true)
    await a.p.onEnd('saved')
    await a.pump(false)
    expect(a.S.active).toBeNull()
    expect(a.S.workouts).toHaveLength(1)
    expect(a.c.journalEntry('s')).toMatchObject({ closeCommitted: true, delivery: 'delivered' })
    expect(a.c.pendingCount()).toBe(0)
  } finally { a.receive.dispose() }
})

it('boots atomically from the full phone snapshot before the first completion', async () => {
  vi.useFakeTimers(); const a = paired(false)
  // New peers receive the full snapshot, without first activating a bare plan.
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  try {
    expect(await a.p.onComplete()).toBe(true)
    await a.pump()
    expect(a.S.active.entries[0].sets[0].done).toBe(true)
    expect(a.c.loadState().workout.rows[0][0].done).toBe(true)
    expect(a.S.watchConflicts || {}).toEqual({})
  } finally { a.receive.dispose() }
})
it('save drains after each set was already committed and snapshots consumed', async () => {
  vi.useFakeTimers(); const a = paired()
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  a.deps.finish = () => { a.S.workouts.push(a.S.active); a.S.active = null }
  try {
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(710)
      expect(await a.p.onComplete()).toBe(true)
      expect(await a.p.onSkipRest()).toBe(true)
      await a.pump()
    }
    await vi.advanceTimersByTimeAsync(710)
    await a.p.saveEnd()
    await a.pump(false)
    expect(a.S.active).toBeNull()
    expect(a.S.workouts).toHaveLength(1)
    expect(a.c.pendingCount()).toBe(0)
    expect(a.c.journalEntry('s')).toMatchObject({ closeCommitted: true, delivery: 'delivered' })
  } finally { a.receive.dispose() }
})


it.each(['saved', 'abandoned'])('offline %s survives watch process restart and lost phone receipts', async disposition => {
  vi.useFakeTimers(); const a = paired()
  await a.sync({ ...watchSnapshotOf(a.S, null), t: 'sync', protocolVersion: 3 })
  a.deps.finish = () => { a.S.workouts.push(a.S.active); a.S.active = null }
  try {
    a.connection.getReadyState = ({ success }) => success({ status: 0 })
    a.connection.onClose()
    expect(await a.p.onComplete()).toBe(true)
    a.p.finishOn = true
    if (disposition === 'abandoned') {
      a.p.askAbandon()
      expect(a.p.closeMode).toBe('abandon')
      expect(a.p.finishOn).toBe(false)
      expect(a.c.loadState().active).toBe(true)
      a.p.cancelClose()
      expect(a.c.loadState().active).toBe(true)
      a.p.askAbandon(); await a.p.abandonEnd()
    } else { a.p.askEnd(); await a.p.saveEnd() }
    expect(a.c.journalEntry('s').closeEvent.disposition).toBe(disposition)
    expect(a.S.active).not.toBeNull()
    const restarted = boot(true, a.disk)
    restarted.c.startServer({})
    restarted.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true } })
    // Phone commits, but the first business receipt is lost in transit.
    const realSend = a.deps.send
    let lost = false
    a.deps.send = msg => { if (!lost && msg.t === 'committed') { lost = true; return } realSend(msg) }
    await a.pump(false, restarted)
    await vi.advanceTimersByTimeAsync(6500)
    await a.pump(false, restarted)
    expect(lost).toBe(true)
    expect(a.S.active).toBeNull()
    expect(a.S.workouts).toHaveLength(disposition === 'saved' ? 1 : 0)
    expect(a.S.watchClosed.s.disposition).toBe(disposition)
    expect(restarted.c.pendingCount()).toBe(0)
    expect(restarted.c.journalEntry('s').closeCommitted).toBe(true)
  } finally { a.receive.dispose() }
})


it('negotiated command receipts alone converge every complete/skip across rapid 5+2', async () => {
  vi.useFakeTimers(); const a = paired(true, true)
  await a.sync(watchSnapshotOf(a.S, null))
  try {
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(710)
      a.p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); a.p.touchCancel()
      expect(await a.p.onComplete()).toBe(true)
      a.p.touchStart({ touches: [{ clientX: 100, clientY: 100 }] }); a.p.touchCancel()
      expect(await a.p.onSkipRest()).toBe(true)
      await a.pump(false)
      expect(a.snapshots).toHaveLength(0)
      const state = a.c.loadState()
      expect(state.workout.rows.flat().filter(r => r.done)).toHaveLength(i + 1)
      expect(a.S.active.entries.flatMap(e => e.sets).filter(r => r.done)).toHaveLength(i + 1)
      expect(state.pendingEdits).toHaveLength(0)
      expect(state.syncBase.commitRev).toBe(a.S.active.syncRev)
      expect(state.syncBase.wireHash).toBe(canonicalWire(state.syncBase).wireHash)
      expect(a.c.synchronizationStatus().conflicts).toBe(0)
    }
    expect(a.p.allFinished).toBe(true)
    expect(a.sent.some(m => m.t === 'sync_request')).toBe(false)
  } finally { a.receive.dispose() }
})


it('inline phone authority settles conflicting weight and preserves independent reps without a transfer', async () => {
  vi.useFakeTimers(); const a = paired(true,true); await a.sync(watchSnapshotOf(a.S,null))
  try {
    a.c.sendEvent({t:'weight',sid:'s',ex:0,set:1,weight:'65',at:Date.now()})
    a.c.sendEvent({t:'reps',sid:'s',ex:0,set:2,reps:'12',at:Date.now()+1})
    const before=structuredClone(a.S);a.S.active.entries[0].sets[0].w=80;stampWatchRevision(before,a.S)
    await a.pump(false)
    expect(a.snapshots).toHaveLength(0)
    const state=a.c.loadState()
    expect(state.workout.rows[0][0].w).toBe(80)
    expect(state.workout.rows[0][1].r).toBe('12')
    expect(state.pendingEdits).toHaveLength(0)
    expect(a.c.synchronizationStatus().conflicts).toBe(0)
    expect(a.disk.get('sync_conflicts').every(c=>c.reviewed&&c.resolution==='phone')).toBe(true)
  }finally{a.receive.dispose()}
})

it('lost inline decisions survive watch restart and replay exactly once without replaying rest', async () => {
  vi.useFakeTimers();const a=paired(true,true);await a.sync(watchSnapshotOf(a.S,null))
  let drop=true,restCalls=0;const send=a.deps.send,rest=a.deps.rest
  a.deps.send=msg=>{if(!drop)send(msg)};a.deps.rest=ev=>{restCalls++;rest(ev)}
  try{
    await a.p.onComplete();await a.pump(false)
    expect(a.c.pendingCount()).toBeGreaterThan(0)
    const first=Object.values(a.S.watchCommits)[0].decision
    const restarted=boot(true,a.disk);restarted.c.startServer({})
    restarted.connection.onMessage({t:'hello_ack',protocolVersion:3,capabilities:{dependencyEvents:true,commandReceipts:true}})
    drop=false;await a.pump(false,restarted)
    expect(restarted.c.pendingCount()).toBe(0)
    expect(restarted.c.loadState().pendingEdits).toHaveLength(0)
    expect(restarted.c.loadState().workout.rows[0][0].done).toBe(true)
    expect(a.S.active.entries.flatMap(e=>e.sets).filter(r=>r.done)).toHaveLength(1)
    expect(restCalls).toBe(1)
    expect(Object.values(a.S.watchCommits)[0].decision).toEqual(first)
    expect(a.snapshots).toHaveLength(0)
  }finally{a.receive.dispose()}
})

it('corrupt inline state requests fresh recovery without inventing an applied baseline', async () => {
  vi.useFakeTimers();const a=paired(true,true);await a.sync(watchSnapshotOf(a.S,null))
  const base=a.c.loadState().syncBase,send=a.deps.send
  a.deps.send=msg=>send(msg.state?{...msg,state:{...msg.state,wireHash:'corrupt'}}:msg)
  try{
    await a.p.onComplete();await a.pump(false)
    expect(a.sent.some(m=>m.t==='sync_request')).toBe(true)
    expect(a.c.loadState().syncBase).toEqual(base)
    expect(a.c.loadState().pendingEdits.length).toBeGreaterThan(0)
    await a.sync(watchSnapshotOf(a.S,null))
    expect(a.c.loadState().pendingEdits).toHaveLength(0)
    expect(a.c.loadState().workout.rows[0][0].done).toBe(true)
  }finally{a.receive.dispose()}
})

it.each(['event_decisions','session_state'])('inline state remains retryable when %s cannot be persisted',async key=>{
  vi.useFakeTimers();const a=paired(true,true);await a.sync(watchSnapshotOf(a.S,null))
  try{
    a.c.sendEvent({t:'reps',sid:'s',ex:0,set:2,reps:'12',at:Date.now()})
    const ev=a.c.loadState().pendingEdits[0]
    a.receive({...ev,appliedHash:a.c.loadState().syncBase.wireHash,appliedRev:a.c.loadState().commitRev});await a.receive.idle()
    const receipt=a.replies.splice(0).find(m=>m.t==='committed'),original=a.storage.set
    a.storage.set=item=>item.key===key?item.fail():original(item)
    a.connection.onMessage(receipt);await vi.advanceTimersByTimeAsync(10)
    expect(a.c.pendingCount()).toBe(1)
    expect(a.c.loadState().pendingEdits.some(e=>e.eventId===ev.eventId)).toBe(true)
    a.storage.set=original;a.connection.onMessage(receipt);await vi.advanceTimersByTimeAsync(10)
    expect(a.c.pendingCount()).toBe(0)
    expect(a.c.loadState().pendingEdits).toHaveLength(0)
    expect(a.c.loadState().syncBase.wireHash).toBe(receipt.state.wireHash)
  }finally{a.receive.dispose()}
})

it('recovers an overlapping independent command receipt and ignores its duplicate after recovery', async () => {
  vi.useFakeTimers(); const a = paired(true, true); await a.sync(watchSnapshotOf(a.S, null))
  try {
    a.c.sendEvent({ t: 'reps', sid: 's', ex: 0, set: 2, reps: '11', at: Date.now() })
    a.c.sendEvent({ t: 'weight', sid: 's', ex: 1, set: 2, weight: '65', at: Date.now() + 1 })
    const state = a.c.loadState(), base = state.syncBase
    const events = state.pendingEdits.filter(e => e.committedRev == null)
    expect(events).toHaveLength(2)
    for (const ev of events) a.receive({ ...ev, appliedHash: base.wireHash, appliedRev: base.commitRev })
    await a.receive.idle()
    const replies = a.replies.splice(0).filter(m => m.t === 'committed')
    expect(replies).toHaveLength(2)
    expect(replies.every(m => m.state?.baseHash === base.wireHash)).toBe(true)
    for (const receipt of replies) { a.connection.onMessage(receipt); await vi.advanceTimersByTimeAsync(10) }
    expect(a.sent.some(m => m.t === 'sync_request')).toBe(true)
    await a.sync(watchSnapshotOf(a.S, null))
    const recovered = a.c.loadState()
    expect(recovered.pendingEdits).toHaveLength(0)
    expect(recovered.workout.rows[0][1].r).toBe('11')
    expect(recovered.workout.rows[1][1].w).toBe(65)
    a.connection.onMessage(replies[0]); await vi.advanceTimersByTimeAsync(10)
    expect(a.c.loadState().syncBase).toEqual(recovered.syncBase)
    expect(a.c.loadState().pendingEdits).toHaveLength(0)
  } finally { a.receive.dispose() }
})
