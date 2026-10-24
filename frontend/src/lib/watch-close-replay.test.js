// @vitest-environment node
// W08: the watch recorded the calories, its app closed, the phone saved the workout, and the
// watch is opened again. The frozen segment summary must reach the original phone record —
// once, with the same segment id, without creating a record, without ending another workout,
// and without the watch having been in the foreground when the phone saved.
import { describe, expect, it } from 'vitest'
import { applyEdit, applyRest } from '../../../watch-app/src/lib/protocol.js'
import { createWatchLifecycle } from './watch-session.js'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'

const SID = 'case-close-1'
const KCAL = 123.4
const NOW = Date.now()
const flush = () => new Promise(r => setTimeout(r, 5))

function device() {
  const { disk, ctx } = watchPersistence()
  Object.assign(ctx, { Date, console, applyEdit, applyRest })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', ctx, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
  loadWatchModule('session', ctx, ['startSession', 'loadState', 'save', 'toggleSet', 'endSession', 'closeSession', 'buildSessionSummary', 'summaryEventOf'])
  const sent = []
  const connection = {
    sent,
    send({ data, success }) { sent.push(data); success?.() },
    // A fresh process is not connected yet: onOpen is the only thing that opens it, as on the watch.
    getReadyState({ fail }) { fail?.({}) },
  }
  const rpcCtx = { ...ctx, interconnect: { instance: () => connection }, WATCH_VERSION: 'test-watch',
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {} }
  loadWatchModule('rpc', rpcCtx, ['startServer', 'sendEvent', 'sendControl', 'pendingCount', 'persistenceStatus'])
  return { disk, ctx, rpc: rpcCtx, connection, sent }
}

/** Reopen the watch app: start the transport and let the phone connection come up. */
function open(h) {
  h.rpc.startServer({})
  h.connection.onOpen()
}

function watchSession(h, { startedAt = Date.now() - 600000 } = {}) {
  const s = h.ctx.startSession({ sid: SID, name: 'Upper',
    exercises: [{ name: 'Bench', entryInstanceId: 'entry-A', setIds: ['set-A1'], sets: 1, reps: '8', weight: '60' }] })
  s.startedAt = startedAt
  s.segmentStartedAt = startedAt
  h.ctx.save(s)
  return s
}

// Freeze the summary the way the watch does once it has recorded calories, then let the app
// go away: only the journal (and whatever was already on disk) survives.
async function frozenDevice(kcal = KCAL) {
  const h = device()
  const event = {
    t: 'summary', sid: SID, eventId: 'watch-summary:' + SID + ':1', seq: 201, at: NOW, endedAt: NOW,
    calories: kcal, algorithmVersion: 1, sampleCount: 10, sampledDurationMs: 60000, final: true,
  }
  await h.ctx.prepareClose({ sid: SID, disposition: 'saved', closedAt: NOW, eventId: 'phone:' + SID + ':close-1' }, event)
  return h
}

function savedRecord() {
  return {
    id: 'saved-1', watchSid: SID, watchSids: [SID, SID + ':resume'], start: NOW - 600000, end: NOW, finishedAt: NOW, name: 'Upper',
    entries: [{ id: 'plain-bench', entryInstanceId: 'entry-A', sets: [{ setId: 'set-A1', w: 60, r: '8', done: true }] }],
  }
}

// What the phone holds after it saved the workout and closed the watch session.
function phoneState(extra = {}) {
  return {
    unit: 'kg', workouts: [savedRecord()], active: null, routines: [], dayPlan: {}, week: {}, watchPlanIds: [],
    watchClosed: { [SID]: { sid: SID, disposition: 'saved', closedAt: NOW, eventId: 'phone:' + SID + ':close-1' } },
    ...extra,
  }
}

function phone(S) {
  const sent = [], acks = [], syncs = [], ends = [], finished = []
  const deps = {
    getState: () => S, update: fn => fn(S), getTimer: () => null,
    sendEnded: msg => ends.push(msg), sendSync: msg => syncs.push(msg),
    sendAck: (upto, eventId) => acks.push({ upto, eventId }),
    send: msg => sent.push(msg), finish: at => finished.push(at), stop: () => {}, rest: () => {},
  }
  return { sent, acks, syncs, ends, finished, receive: createWatchLifecycle(deps) }
}

describe('a closed watch delivers the calories it already recorded (W08)', () => {
  it('answers hello with the close and the frozen summary reaches the original record exactly once', async () => {
    const h = await frozenDevice()
    const S = phoneState(), app = phone(S)
    app.receive({ t: 'hello', sid: SID })
    const closes = app.sent.filter(m => m.t === 'session_close')
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({ sid: SID, disposition: 'saved' })
    expect(app.ends).toHaveLength(1)
    expect(app.ends[0]).toMatchObject({ sid: SID, reason: 'finished' })

    open(h)
    for (const msg of [...closes, ...app.ends]) h.connection.onMessage(msg)
    await flush()
    const summaries = h.sent.filter(m => m.t === 'summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ sid: SID, calories: KCAL, eventId: 'watch-summary:' + SID + ':1' })

    app.receive(summaries[0])
    expect(S.workouts).toHaveLength(1)
    expect(S.workouts[0].id).toBe('saved-1')
    expect(S.workouts[0].calories).toBeCloseTo(KCAL, 5)
    expect(S.workouts[0].watchSegments[SID].calories).toBeCloseTo(KCAL, 5)
    expect(app.acks.at(-1)).toEqual({ upto: expect.any(Number), eventId: 'watch-summary:' + SID + ':1' })
    expect(app.finished).toHaveLength(0)      // no new history, no "save again" prompt
    expect(S.watchPendingSaves).toBeUndefined() // the phone already saved it: nothing to decide
    expect(S.active).toBeNull()

    // The phone's business ack retires the frozen entry; nothing is rebuilt afterwards.
    h.connection.onMessage({ t: 'ack', upto: summaries[0].at, eventId: summaries[0].eventId })
    await flush()
    expect(h.rpc.pendingCount()).toBe(0)
    expect(h.disk.get('watch_close_journal_v1').entries[SID].delivery).toBe('delivered')
    h.connection.onClose(); h.connection.onOpen()
    await flush()
    expect(h.sent.filter(m => m.t === 'summary')).toHaveLength(1)
  })

  it('produces the same single summary in any order of the two close messages, or when they repeat', async () => {
    const orders = [['ended', 'session_close'], ['session_close', 'ended'], ['session_close', 'session_close', 'ended', 'ended']]
    for (const order of orders) {
      const h = await frozenDevice()
      open(h)
      const msg = {
        ended: { t: 'ended', sid: SID, endedAt: NOW, reason: 'finished' },
        session_close: { t: 'session_close', sid: SID, disposition: 'saved', closedAt: NOW, eventId: 'phone:' + SID + ':close-1' },
      }
      for (const t of order) h.connection.onMessage(msg[t])
      await flush()
      const summaries = h.sent.filter(m => m.t === 'summary')
      expect(summaries, order.join(',')).toHaveLength(1)
      expect(summaries[0].eventId).toBe('watch-summary:' + SID + ':1')
      expect(summaries[0].calories).toBeCloseTo(KCAL, 5)
    }
  })

  it('freezes the live session before closing it, and replays the same value after a restart', async () => {
    const h = device()
    watchSession(h)
    open(h)
    h.connection.onMessage({ t: 'session_close', sid: SID, disposition: 'saved', closedAt: Date.now(), eventId: 'close-1' })
    await flush()
    const frozen = h.disk.get('watch_close_journal_v1').entries[SID]
    expect(frozen.summaryEvent.calories).toBeGreaterThanOrEqual(0)
    expect(h.ctx.loadState().active).toBe(false)
    expect(h.sent.filter(m => m.t === 'summary')).toHaveLength(1)

    // Restart the app from disk: the summary is rebuilt from the journal, never recomputed.
    const h2 = device()
    for (const [key, value] of h.disk) h2.disk.set(key, value)
    open(h2)
    await flush()
    const resent = h2.sent.filter(m => m.t === 'summary')
    expect(resent).toHaveLength(1)
    expect(resent[0]).toMatchObject({ eventId: frozen.summaryEvent.eventId, calories: frozen.summaryEvent.calories })
  })

  it('keeps the frozen summary while the phone is offline, and sends it once the watch reconnects', async () => {
    const h = await frozenDevice()
    h.rpc.startServer({})          // app open, no phone connection
    await flush()
    expect(h.sent.filter(m => m.t === 'summary')).toHaveLength(0)

    const h2 = device()
    for (const [key, value] of h.disk) h2.disk.set(key, value)
    open(h2)
    await flush()
    const sent = h2.sent.filter(m => m.t === 'summary')
    expect(sent).toHaveLength(1)
    expect(sent[0].eventId).toBe('watch-summary:' + SID + ':1')
  })

  it('does not revive a closed training, create a record or touch another active workout', async () => {
    const h = await frozenDevice()
    const other = { id: 'other', watchSid: 'other-sid', start: 900000,
      entries: [{ id: 'row', sets: [{ w: 20, r: '5', done: false }] }] }
    const S = phoneState({ active: other }), app = phone(S)
    open(h)
    h.connection.onMessage({ t: 'session_close', sid: SID, disposition: 'saved', closedAt: NOW, eventId: 'close-1' })
    await flush()
    const summary = h.sent.find(m => m.t === 'summary')
    app.receive(summary)
    expect(S.workouts).toHaveLength(1)
    expect(S.workouts[0].id).toBe('saved-1')
    expect(S.active).toBe(other)
    expect(S.active.id).toBe('other')
    expect(S.workouts[0].entries[0].sets[0].done).toBe(true)
  })

  it('replaces the same segment on a repeat and only adds a different resumed segment', () => {
    const S = phoneState(), app = phone(S)
    const summary = { t: 'summary', sid: SID, eventId: 'watch-summary:' + SID + ':1', seq: 201, at: NOW, calories: KCAL }
    app.receive(summary)
    expect(S.workouts[0].calories).toBeCloseTo(KCAL, 5)
    app.receive(summary)
    app.receive({ ...summary, seq: 202, at: NOW + 1, eventId: 'watch-summary:dup' })
    expect(S.workouts[0].calories).toBeCloseTo(KCAL, 5)       // replaced, never added to itself
    app.receive({ t: 'summary', sid: SID + ':resume', eventId: 'watch-summary:2', seq: 301, at: NOW + 2, calories: 50 })
    expect(S.workouts[0].calories).toBeCloseTo(KCAL + 50, 5)   // a second segment is a second segment
  })

  it('does not invent a record for a session the phone never saved', () => {
    const S = phoneState({ workouts: [] }), app = phone(S)
    app.receive({ t: 'summary', sid: SID, eventId: 'x', at: 1, calories: KCAL })
    expect(S.workouts).toHaveLength(0)
    expect(S.active).toBeNull()
    expect(app.acks).toHaveLength(0)   // unconfirmed: the watch keeps its entry
  })
})
