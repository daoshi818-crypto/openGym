import { describe, expect, it } from 'vitest'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'
import { afterEach, vi } from 'vitest'
import { applyPhonePresence, confirmPhoneSession, isPhoneSessionLive, validPhonePresence, phonePresenceLeaseMs } from '../../../watch-app/src/lib/session-presence.js'

describe('watch phone-session lease', () => {
  it('requires an app-level same-sid presence and an unexpired lease', () => {
    const runtime = {}
    const session = { sid: 'phone-session-1', generation: 'phone-session-1' }
    expect(isPhoneSessionLive(session, null, 1000)).toBe(false)
    confirmPhoneSession(runtime, session.sid, session.generation, 1000)
    expect(isPhoneSessionLive(session, runtime.phoneSessionPresence, 1000 + phonePresenceLeaseMs() - 1)).toBe(true)
    expect(isPhoneSessionLive(session, runtime.phoneSessionPresence, 1000 + phonePresenceLeaseMs())).toBe(false)
  })

  it('rejects mismatched, malformed, and stale presence without changing the lease', () => {
    const runtime = {}
    const session = { sid: 's1' }
    confirmPhoneSession(runtime, 's1', 1, 100)
    const before = runtime.phoneSessionPresence
    expect(validPhonePresence({ t: 'session_presence', sid: 's1', active: true })).toBe(false)
    expect(applyPhonePresence(runtime, { t: 'session_presence', sid: 's2', sessionGeneration: 2, active: true, sentAt: 200 }, 's1', 200)).toBe(false)
    expect(applyPhonePresence(runtime, { t: 'session_presence', sid: 's1', sessionGeneration: 2, active: true, sentAt: 200, commitRev: -1 }, 's1', 200)).toBe(false)
    expect(runtime.phoneSessionPresence).toBe(before)
    expect(session.sid).toBe('s1')
  })

  it('rejects queued presence outside the lease and bounded clock skew', () => {
    const runtime = {}
    expect(applyPhonePresence(runtime, { t: 'session_presence', sid: 's1', sessionGeneration: 1, active: true, sentAt: 100 }, 's1', 25000)).toBe(false)
    expect(runtime.phoneSessionPresence).toBeUndefined()
  })

  it('clears only the matching session and never carries a phone lease across sessions', () => {
    const runtime = {}
    confirmPhoneSession(runtime, 's1', 1, 100)
    expect(applyPhonePresence(runtime, { t: 'session_presence', sid: 's1', sessionGeneration: 2, active: true, sentAt: 200 }, 's1', 200)).toBe(true)
    expect(runtime.phoneSessionPresence.generation).toBe(2)
    expect(applyPhonePresence(runtime, { t: 'session_presence', sid: 's1', sessionGeneration: 1, active: false, sentAt: 300 }, 's1', 300)).toBe(true)
    expect(runtime.phoneSessionPresence.generation).toBe(2)
    expect(applyPhonePresence(runtime, { t: 'session_presence', sid: 's1', sessionGeneration: 2, active: false, sentAt: 400 }, 's1', 400)).toBe(true)
    expect(runtime.phoneSessionPresence).toBe(null)
    expect(isPhoneSessionLive({ sid: 's2' }, runtime.phoneSessionPresence, 200)).toBe(false)
  })
})



describe('phone-led watch edit staging', () => {
  it('keeps offline edits local and tags only newly staged live edits with the current generation', () => {
    const h = watchPersistence(), c = h.ctx
    loadWatchModule('event-id', c, ['allocateEventIdentity', 'rememberEventAt'])
    loadWatchModule('session', c, ['startSession', 'loadState', 'stageSessionEvent'])
    const state = c.startSession({ sid: 'phone-sid', name: 'Phone plan', protocolVersion: 3,
      exercises: [{ name: 'Row', entryInstanceId: 'ex1', sets: 1, setIds: ['set1'] }] })
    state.sessionOrigin = 'phone'; state.phoneSession = { sid: state.sid }
    const offline = c.stageSessionEvent(state, { t: 'set', sid: state.sid, ex: 0, set: 1, at: 10 })
    expect(offline.localOnly).toBe(true)
    expect(state.pendingEdits || []).toHaveLength(0)

    h.shared.phoneSessionPresence = { sid: state.sid, generation: 4, active: true, lastSeenAt: Date.now() }
    const live = c.stageSessionEvent(state, { t: 'focus', sid: state.sid, ex: 0, set: 1, at: 11 })
    expect(live).toMatchObject({ t: 'focus', phoneSessionGeneration: 4 })
    expect(state.pendingEdits).toContainEqual(expect.objectContaining({ eventId: live.eventId, phoneSessionGeneration: 4 }))
  })
})


afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('phone-led RPC replay fence', () => {
  it('does not queue offline edits or replay prior-generation sets after foreground reattachment', () => {
    vi.useFakeTimers()
    const h = watchPersistence(), sent = [], state = { active: true, sid: 'phone-sid', sessionOrigin: 'phone',
      phoneSession: { sid: 'phone-sid' }, protocolVersion: 3, pendingEdits: [], syncBase: null,
      workout: { exercises: [{ entryInstanceId: 'ex1' }], rows: [[{ setId: 'set1' }]] } }
    const connection = { getReadyState: ({ success }) => success({ status: 1 }), send: item => { sent.push(structuredClone(item.data)); item.success?.() } }
    const c = h.ctx
    Object.assign(c, { interconnect: { instance: () => connection }, WATCH_VERSION: 'test', console,
      loadState: () => state, save: () => {}, buildSessionSummary: () => ({}), summaryEventOf: () => ({}), closeSession() {} })
    loadWatchModule('event-id', c, ['allocateEventIdentity', 'rememberEventAt'])
    loadWatchModule('close-journal', c, ['journalEntry', 'pendingCloseEvents', 'pendingSummaries', 'pendingEntry', 'prepareClose', 'releaseCandidate', 'markPhase', 'markEntry', 'markDelivered'])
    loadWatchModule('rpc', c, ['startServer', 'sendEvent', 'pendingCount'])
    c.startServer({}); connection.onOpen()
    connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { sessionPresence: true, dependencyEvents: true } })

    expect(c.sendEvent({ t: 'set', sid: state.sid, eventId: 'offline-set', ex: 0, set: 1, at: 1 })).toBe(true)
    expect(c.pendingCount()).toBe(0)
    expect(sent.some(m => m.eventId === 'offline-set')).toBe(false)

    connection.onMessage({ t: 'session_presence', sid: state.sid, sessionGeneration: 1, active: true, sentAt: Date.now() })
    c.sendEvent({ t: 'set', sid: state.sid, eventId: 'live-set', ex: 0, set: 1, at: 2 })
    expect(sent.find(m => m.eventId === 'live-set')).toMatchObject({ phoneLed: true, phoneSessionGeneration: 1 })

    connection.onMessage({ t: 'session_presence', sid: state.sid, sessionGeneration: 2, active: true, sentAt: Date.now() })
    c.sendEvent({ t: 'focus', sid: state.sid, eventId: 'fresh-focus', ex: 0, set: 1, at: 3 })
    vi.advanceTimersByTime(200)
    expect(sent.find(m => m.eventId === 'fresh-focus')).toMatchObject({ phoneLed: true, phoneSessionGeneration: 2 })
    expect(sent.filter(m => m.eventId === 'live-set')).toHaveLength(1)
  })
})



describe('phone-led close recovery', () => {
  it('keeps a durable same-sid finish intent without watch workout rows or sending a summary', async () => {
    const h = watchPersistence(), c = h.ctx
    loadWatchModule('event-id', c, ['allocateEventIdentity', 'rememberEventAt'])
    loadWatchModule('protocol', c, ['applyEdit', 'applyRest'])
    loadWatchModule('close-journal', c, ['journalEntry', 'pendingCloseEvents', 'pendingSummaries', 'pendingEntry', 'prepareClose', 'releaseCandidate', 'markPhase', 'markEntry', 'markDelivered'])
    loadWatchModule('session', c, ['startSession', 'loadState', 'save', 'commitLocalClose'])
    const state = c.startSession({ sid: 'phone-sid', name: 'Phone plan', protocolVersion: 3,
      exercises: [{ name: 'Row', entryInstanceId: 'ex1', sets: 1, setIds: ['set1'] }] })
    state.sessionOrigin = 'phone'; state.phoneSession = { sid: state.sid }
    state.pendingEdits = [{ t: 'set', sid: state.sid, eventId: 'legacy-set', phoneSessionGeneration: 1 }]
    c.save(state)
    const closed = await c.commitLocalClose(state.sid, 'saved', Date.now())
    expect(closed.ok).toBe(true)
    expect(closed.entry.closeEvent).toMatchObject({ t: 'session_close', sid: state.sid, phoneLed: true })
    expect(closed.entry.closeEvent).not.toHaveProperty('workout')
    expect(closed.entry.closeEvent).not.toHaveProperty('completedSets')
    expect(closed.entry.closeEvent).not.toHaveProperty('summary')
    expect(closed.entry.summaryEvent.phoneLed).toBe(true)
    expect(closed.entry.pendingEvents).toEqual([])
    expect(closed.entry.parkedEvents).toEqual([{ t: 'set', sid: state.sid, eventId: 'legacy-set', phoneSessionGeneration: 1 }])
    expect(c.loadState().active).toBe(false)
  })
})
