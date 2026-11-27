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
  negotiateV3(h)
  return h.ctx.loadState()
}

function negotiateV3(h, capabilities = {}) {
  h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities })
}

function commitV3(h, event, commitRev = 1) {
  h.connection.onMessage({ t: 'committed', sid: event.sid, eventId: event.eventId,
    status: 'applied', commitRev })
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
  it('recovers V3 uplink after an SDK error when the phone renegotiates without another onOpen', async () => {
    vi.useFakeTimers()
    const h = device(), S = phoneSession(), app = phone(S)
    startWatch(h, S)
    h.connection.onError({ code: 7 })
    h.connection.getReadyState = ({ success }) => success({ status: 0 })
    const before = h.sent.length
    completeCurrent(h)
    expect(h.sent.slice(before).filter(e => e.t === 'set')).toHaveLength(0)
    negotiateV3(h)
    await vi.advanceTimersByTimeAsync(120)
    const event = h.sent.slice(before).find(e => e.t === 'set')
    expect(event).toBeTruthy()
    app.receive(event)
    expect(S.active.entries[0].sets[0].done).toBe(true)
    commitV3(h, event)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rpc.pendingCount()).toBe(0)
  })

  it('probes readiness, renegotiates V3, and uploads offline edits when firmware omits onOpen', async () => {
    vi.useFakeTimers()
    const h = device(), S = phoneSession(), app = phone(S)
    startWatch(h, S)
    h.connection.onClose()
    h.connection.getReadyState = ({ success }) => success({ status: 0 })
    const before = h.sent.length
    completeCurrent(h)
    h.connection.getReadyState = ({ success }) => success({ status: 1 })
    vi.advanceTimersByTime(4000)
    negotiateV3(h)
    await vi.advanceTimersByTimeAsync(120)
    const event = h.sent.slice(before).find(e => e.t === 'set')
    expect(event).toBeTruthy()
    app.receive(event)
    expect(S.active.entries[0].sets[0].done).toBe(true)
  })

  it('ignores a late readiness callback and renegotiates V3 after a later probe', async () => {
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
    negotiateV3(h)
    await vi.advanceTimersByTimeAsync(120)
    expect(h.sent.slice(before).some(e => e.t === 'set')).toBe(true)
  })

  it('retries a lost readiness probe, renegotiates V3, and uploads the pending event', async () => {
    vi.useFakeTimers()
    const h = device(), S = phoneSession()
    startWatch(h, S)
    h.connection.onClose()
    h.connection.getReadyState = () => {}
    completeCurrent(h)
    const before = h.sent.length
    h.connection.getReadyState = ({ success }) => success({ status: 1 })
    vi.advanceTimersByTime(8000)
    negotiateV3(h)
    await vi.advanceTimersByTimeAsync(120)
    expect(h.sent.slice(before).some(e => e.t === 'set')).toBe(true)
    expect(h.rpc.pendingCount()).toBe(1)
  })
  it('updates the phone row, acknowledges that exact event and clears the watch outbox', async () => {
    vi.useFakeTimers()
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

    commitV3(h, uplink[0])
    await vi.advanceTimersByTimeAsync(0) // V3 clears only after the exact durable commit receipt.
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

  it('keeps an earlier independent event when a later V3 event receives its exact commit', async () => {
    vi.useFakeTimers()
    const h = device(), S = phoneSession()
    startWatch(h, S)
    negotiateV3(h, { dependencyEvents: true })
    const before = h.sent.length
    const first = { t: 'weight', sid: S.active.watchSid, ex: 0, set: 1, eventId: 'independent-weight',
      entryInstanceId: 'entry-a', setId: 'row-a', weight: 51, protocolVersion: 3, dependencyEvents: true, dependsOn: [] }
    const later = { t: 'focus', sid: S.active.watchSid, ex: 1, set: 1, eventId: 'independent-focus',
      entryInstanceId: 'entry-b', setId: 'row-b', protocolVersion: 3, dependencyEvents: true, dependsOn: [], narrowDependencies: true }
    h.rpc.sendEvent(first)
    h.rpc.sendEvent(later)
    vi.advanceTimersByTime(120) // paced uplink, not recursive SDK draining
    const sent = h.sent.slice(before).filter(e => e.eventId)
    expect(sent.map(e => e.eventId)).toEqual([first.eventId, later.eventId])
    expect(h.rpc.pendingCount()).toBe(2)
    // A later independent durable commit cannot cumulatively clear the earlier event.
    commitV3(h, later, 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rpc.pendingCount()).toBe(1)
    expect(h.disk.get('rpc_outbox')[0].msg.eventId).toBe(first.eventId)
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


describe('frozen extension intention with a legacy phone', () => {
  afterEach(() => vi.useRealTimers())
  it('preserves V3 identity and FIFO without dependency capability using exact committed receipts', async () => {
    vi.useFakeTimers()
    const h=device(), S=phoneSession(), app=phone(S)
    startWatch(h,S)
    h.connection.onClose()
    h.connection.getReadyState=({success})=>success({status:0})
    const frozen=[]
    for(const weight of ['61','62']) {
      const result=await h.ctx.commitSessionAction(S.active.watchSid, draft => {
        draft.workout.rows[0][0].w=weight
        h.ctx.stageSessionEvent(draft,{t:'weight',sid:draft.sid,ex:0,set:1,weight,at:Date.now()})
      })
      expect(result.ok).toBe(true)
      frozen.push(structuredClone(h.ctx.loadState().pendingEdits.at(-1)))
      h.rpc.sendEvent(frozen.at(-1))
    }
    expect(frozen.every(e=>e.protocolVersion===3 && e.dependencyEvents)).toBe(true)
    expect(frozen[1].dependsOn).toContain(frozen[0].eventId)
    const before=h.sent.length
    h.connection.onOpen()
    h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: {} })
    await vi.advanceTimersByTimeAsync(500) // No second event before the exact legacy head ACK.
    const first=h.sent.slice(before).filter(m=>m.t==='weight')
    expect(first).toEqual([frozen[0]])
    app.receive(first[0])
    expect(S.active.entries[0].sets[0].w).toBe(61)
    commitV3(h, first[0], 1)
    await vi.advanceTimersByTimeAsync(200)
    const sent=h.sent.slice(before).filter(m=>m.t==='weight')
    expect(sent).toEqual(frozen)
    app.receive(sent[1])
    commitV3(h, sent[1], 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(S.active.entries[0].sets[0].w).toBe(62)
    expect(h.rpc.pendingCount()).toBe(0)
    const committedEdits = h.ctx.loadState().pendingEdits
    expect(committedEdits).toHaveLength(2)
    expect(committedEdits.map(event => event.committedRev)).toEqual([1, 2])
    expect(app.rejected).toHaveLength(0)
  })
})


describe('connection negotiation and conflict review durability', () => {
  afterEach(() => vi.useRealTimers())
  it('renegotiates dependencies on reconnect instead of reusing old peer capabilities', async () => {
    vi.useFakeTimers()
    const h = device(), S = phoneSession()
    startWatch(h, S)
    h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true } })
    expect(h.rpc.runtime().rpc.peerCapabilities.dependencyEvents).toBe(true)
    h.connection.onClose()
    h.connection.onOpen()
    expect(h.rpc.runtime().rpc.peerCapabilities).toEqual({})
  })

  it('serializes durable conflict review with a new archived conflict without losing either', async () => {
    vi.useFakeTimers()
    const h = device(), S = phoneSession()
    startWatch(h, S)
    h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true } })
    h.ctx.writeStored('sync_conflicts', [{ event: { eventId: 'old' }, reviewed: false }])
    const realSet = h.storage.set
    let held
    h.storage.set = options => {
      if (options.key === 'sync_conflicts' && !held) { held = options; return }
      realSet(options)
    }
    h.connection.onMessage({ t: 'conflict_reviewed', eventId: 'old' })
    await vi.advanceTimersByTimeAsync(0)
    expect(held).toBeTruthy()
    expect(h.ctx.readStored('sync_conflicts')[0].reviewed).toBe(false)
    const result = await h.ctx.commitSessionAction(S.active.watchSid, draft => {
      h.ctx.stageSessionEvent(draft, { t: 'weight', sid: draft.sid, ex: 0, set: 1, weight: '63', at: Date.now() })
    })
    expect(result.ok).toBe(true)
    const event = h.ctx.loadState().pendingEdits.at(-1)
    h.rpc.sendEvent(event)
    h.connection.onMessage({ t: 'committed', sid: event.sid, eventId: event.eventId, status: 'conflict', commitRev: 2 })
    realSet(held)
    await vi.advanceTimersByTimeAsync(0)
    const archive = h.ctx.readStored('sync_conflicts')
    expect(archive.find(c => c.event.eventId === 'old').reviewed).toBe(true)
    expect(archive.find(c => c.event.eventId === event.eventId).event).toEqual(event)
    expect(h.rpc.pendingCount()).toBe(0)
  })
})
