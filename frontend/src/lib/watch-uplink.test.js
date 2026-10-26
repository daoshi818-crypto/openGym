// @vitest-environment node
// End-to-end: a watch "complete set" event must reach the phone, be applied and
// acknowledged with the same eventId. The shipped watch modules run against a fake device
// (two page bundles sharing one runtime, like the app), and the shipped phone lifecycle.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEdit, applyRest, restOf, applyFocus } from '../../../watch-app/src/lib/protocol.js'
import { createWatchLifecycle } from './watch-session.js'
import { startFromWatch } from './watch-events.js'
import { watchPlanOf, watchSnapshotOf } from './watch-workout.js'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'

function device() {
  const { disk, ctx, storage } = watchPersistence()
  Object.assign(ctx, { Date, console, applyEdit, applyRest })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', ctx, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
  loadWatchModule('session', ctx, ['startSession', 'loadState', 'save', 'toggleSet', 'nextUndone', 'endSession', 'closeSession', 'buildSessionSummary', 'summaryEventOf', 'setRowValue'])
  const sent = []
  const connection = {
    sent,
    send({ data, success }) { sent.push(data); success?.() },
    getReadyState({ success }) { success({ status: 1 }) },
  }
  // A second bundle: same runtime and disk, its own module instance (as on the watch).
  const rpcCtx = { ...ctx, interconnect: { instance: () => connection }, WATCH_VERSION: 'test-watch',
    setTimeout, clearTimeout, setInterval, clearInterval }
  loadWatchModule('rpc', rpcCtx, ['startServer', 'sendEvent', 'sendControl', 'pendingCount', 'persistenceStatus'])
  return { disk, storage, ctx, rpc: rpcCtx, connection, sent }
}

// A phone session with stable identities, as the app builds it when starting normally.
function phoneSession() {
  const S = { workouts: [], unit: 'kg', restSec: 60, bodyweight: [{ w: 80 }] }
  startFromWatch(S, {
    sid: 'case-up-1', startedAt: Date.now(),
    plan: { id: 'plan-1', name: 'Upper', entries: [
      { id: 'plain-bench', sets: [{ w: 50, r: '8', done: false }, { w: 50, r: '8', done: false }] },
      { id: 'plain-bench', sets: [{ w: 40, r: '10', done: false }, { w: 40, r: '10', done: false }] },
    ] },
  })
  return S
}

function phone(S) {
  const acks = [], rejected = []
  const deps = {
    getState: () => S, update: fn => fn(S), getTimer: () => null,
    sendEnded: () => {}, sendSync: () => {},
    sendAck: (upto, eventId) => { acks.push({ upto, eventId }) },
    send: msg => { if (msg.t === 'event_rejected') rejected.push(msg) },
    finish: () => {}, stop: () => {}, rest: () => {},
  }
  return { acks, rejected, receive: createWatchLifecycle(deps) }
}

function startWatch(h, S) {
  const plan = watchPlanOf(S)
  h.ctx.startSession({ name: plan.workout.name, sid: plan.sid, exercises: plan.workout.exercises })
  h.rpc.startServer({})
  h.connection.onOpen()
  return h.ctx.loadState()
}

function completeCurrent(h) {
  const s = h.ctx.loadState()
  const exIdx = s.exIdx, setIdx = s.setIdx
  const row = h.ctx.toggleSet(s, true)
  const ev = { t: 'set', sid: s.sid, ex: exIdx, set: setIdx + 1,
    reps: row.r != null ? String(row.r) : '', weight: row.w != null ? String(row.w) : '',
    at: row.at, rest: restOf(s) }
  h.rpc.sendEvent(ev)
  return { ev, row }
}

describe('watch → phone completed set (W06)', () => {
  afterEach(() => vi.useRealTimers())
  it('recovers uplink on a valid downlink after an SDK error without another onOpen', () => {
    vi.useFakeTimers()
    const h = device(), S = phoneSession(), app = phone(S)
    startWatch(h, S)
    h.connection.onError({ code: 7 })
    h.connection.getReadyState = ({ success }) => success({ status: 0 })
    const before = h.sent.length
    completeCurrent(h)
    expect(h.sent.slice(before).filter(e => e.t === 'set')).toHaveLength(0)
    h.connection.onMessage({ data: { t: 'sync', sid: S.active.watchSid } })
    const event = h.sent.slice(before).find(e => e.t === 'set')
    expect(event).toBeTruthy()
    app.receive(event)
    expect(S.active.entries[0].sets[0].done).toBe(true)
    h.connection.onMessage({ t: 'ack', eventId: event.eventId })
    expect(h.rpc.pendingCount()).toBe(0)
  })

  it('probes readiness and uploads offline edits when the firmware omits onOpen', () => {
    vi.useFakeTimers()
    const h = device(), S = phoneSession(), app = phone(S)
    startWatch(h, S)
    h.connection.onClose()
    h.connection.getReadyState = ({ success }) => success({ status: 0 })
    const before = h.sent.length
    completeCurrent(h)
    h.connection.getReadyState = ({ success }) => success({ status: 1 })
    vi.advanceTimersByTime(4000)
    const event = h.sent.slice(before).find(e => e.t === 'set')
    expect(event).toBeTruthy()
    app.receive(event)
    expect(S.active.entries[0].sets[0].done).toBe(true)
  })

  it('ignores a late readiness callback from before a disconnect', () => {
    vi.useFakeTimers()
    const h = device(), S = phoneSession()
    startWatch(h, S)
    h.connection.onClose()
    let reply
    h.connection.getReadyState = ({ success }) => { reply = success }
    completeCurrent(h)
    h.connection.onClose()
    const before = h.sent.length
    reply({ status: 1 })
    expect(h.sent).toHaveLength(before)
    expect(h.rpc.pendingCount()).toBe(1)
    h.connection.getReadyState = ({ success }) => success({ status: 1 })
    vi.advanceTimersByTime(4000)
    expect(h.sent.slice(before).some(e => e.t === 'set')).toBe(true)
  })

  it('retries readiness when a firmware probe callback is lost', () => {
    vi.useFakeTimers()
    const h = device(), S = phoneSession()
    startWatch(h, S)
    h.connection.onClose()
    h.connection.getReadyState = () => {}
    completeCurrent(h)
    const before = h.sent.length
    h.connection.getReadyState = ({ success }) => success({ status: 1 })
    vi.advanceTimersByTime(8000)
    expect(h.sent.slice(before).some(e => e.t === 'set')).toBe(true)
    expect(h.rpc.pendingCount()).toBe(1)
  })
  it('updates the phone row, acknowledges that exact event and clears the watch outbox', () => {
    const h = device(), S = phoneSession(), app = phone(S)
    startWatch(h, S)

    const before = h.sent.length
    const { ev } = completeCurrent(h)
    const uplink = h.sent.slice(before)
    expect(uplink).toHaveLength(1)
    expect(uplink[0]).toMatchObject({ t: 'set', sid: 'case-up-1', ex: 0, set: 1 })
    expect(uplink[0].eventId).toMatch(/^watch:case-up-1:/)
    expect(uplink[0].entryInstanceId).toBe(S.active.entries[0].entryInstanceId)
    expect(uplink[0].setId).toBe(S.active.entries[0].sets[0].setId)

    app.receive(uplink[0])
    expect(S.active.entries[0].sets[0].done).toBe(true)
    expect(app.acks.at(-1)).toEqual({ upto: ev.at, eventId: uplink[0].eventId })
    expect(app.rejected).toHaveLength(0)

    h.connection.onMessage({ t: 'ack', upto: ev.at, eventId: uplink[0].eventId })
    expect(h.rpc.pendingCount()).toBe(0)
  })

  it('keeps the phone row when the same event is replayed ten times', () => {
    const h = device(), S = phoneSession(), app = phone(S)
    startWatch(h, S)
    const before = h.sent.length
    completeCurrent(h)
    const msg = h.sent[before]
    for (let i = 0; i < 10; i++) app.receive(msg)
    expect(S.active.entries[0].sets[0].done).toBe(true)
    expect(S.active.entries[1].sets[0].done).toBe(false)
    expect(S.active.entries[0].sets[1].done).toBe(false)
    expect(app.acks.filter(a => a.eventId === msg.eventId)).toHaveLength(10)
  })

  it('keeps an unconfirmed set in the outbox when only a later event is acknowledged', () => {
    const h = device(), S = phoneSession(), app = phone(S)
    startWatch(h, S)
    const before = h.sent.length
    completeCurrent(h)
    const setMsg = h.sent[before]
    // A focus for the next set: an independent event with its own identity.
    h.rpc.sendEvent({ t: 'focus', sid: S.active.watchSid, ex: 1, set: 1, at: Date.now(), source: 'watch' })
    const focusMsg = h.sent.at(-1)
    expect(focusMsg.t).toBe('focus')
    expect(h.rpc.pendingCount()).toBe(2)
    // The phone applies the focus only; the set stays unconfirmed until its own ack.
    app.receive(focusMsg)
    h.connection.onMessage({ t: 'ack', upto: focusMsg.at, eventId: focusMsg.eventId })
    expect(h.rpc.pendingCount()).toBe(1)
    app.receive(setMsg)
    expect(S.active.entries[0].sets[0].done).toBe(true)
  })

  it('still lets a phone-side completion reach the watch (no regression)', () => {
    const h = device(), S = phoneSession()
    const s = startWatch(h, S)
    S.active.entries[1].sets[0].done = true
    const snapshot = watchSnapshotOf(S, null, Date.now())
    // What the watch applies for a phone `set`: mark the matching stable set.
    const rows = s.workout.rows[1]
    const index = rows.findIndex(r => r.setId === S.active.entries[1].sets[0].setId)
    expect(index).toBe(0)
    rows[index].done = true
    expect(S.active.watchSid).toBe('case-up-1')
    expect(snapshot.rows[1][0].done).toBe(true)
    expect(applyFocus(s, { sid: 'case-up-1', ex: 1, set: 1, at: Date.now(), source: 'phone' })).toBe(true)
  })
})
