// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEF, useStore } from '../store/useStore.js'
import { watchCatalogOf } from './watch-workout.js'
import { createDurableWatchLifecycle } from './watch-commit.js'
import { navToWorkout, setNav } from './nav.js'
import * as link from './watch-link.js'

const native = vi.hoisted(() => ({ events: {}, addListener: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), sendEvent: vi.fn(), drainInbox: vi.fn(), completeInbox: vi.fn() }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }))
vi.mock('./mobile.js', async importOriginal => ({ ...await importOriginal(), MOBILE: true, isAndroid: async () => true,
  initReminderSync() {}, initHealthSync() {}, nativeSave: async () => {}, writeJsonFile: async () => {} }))
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear()
  vi.clearAllMocks()
  native.addListener.mockImplementation((name, cb) => { native.events[name] = cb; return { remove() {} } })
  native.connect.mockResolvedValue({ connected: true }); native.disconnect.mockResolvedValue({})
  native.sendEvent.mockResolvedValue({ ok: true }); native.drainInbox.mockResolvedValue({ events: [] }); native.completeInbox.mockResolvedValue({})
  const S = structuredClone(DEF)
  S.active = null; S.routines = [{ id: 'back', name: 'Back', prog: 'off', ex: [{ id: '0025', sets: 4, reps: 8, weight: 40 }] }]; S.watchPlanIds = ['back']
  useStore.setState({ S, user: null })
})
afterEach(async () => { await link.disconnectWatch(); vi.clearAllTimers(); vi.useRealTimers(); setNav(() => {}) })

it.each([false, true])('starts through bridge/store/router even when Inbox cleanup stalls (%s)', async stalledCleanup => {
  if (stalledCleanup) native.completeInbox.mockImplementationOnce(() => new Promise(() => {}))
  const nav = vi.fn(); setNav(nav)
  const receive = createDurableWatchLifecycle({ getState: () => useStore.getState().S,
    update: (fn, ev) => useStore.getState().update(fn, true, { watchActor: ev?.installationId || 'watch', watchEventId: ev?.eventId }),
    transaction: fn => useStore.getState().withWatchTransaction(fn), checkpoint: () => useStore.getState().checkpointWatchState(),
    getTimer: () => null, send: link.sendToWatch, sendAck: link.pushAckToWatch, sendSync: () => {}, sendEnded: () => {},
    completeInbox: link.completeWatchInbox, holdOutbound: link.holdWatchOutbound, onStarted: () => navToWorkout() })
  const unbind = link.bindWatchLifecycle(receive, { getState: () => useStore.getState().S })
  try {
    await link.connectWatch()
    const plan = watchCatalogOf(useStore.getState().S).plans[0]
    const ev = { t: 'watch_start', protocolVersion: 3, eventId: 'start:one', sid: 'watch-start-one', startedAt: Date.now(), plan,
      dependencyEvents: true, dependsOn: [], _inboxId: 'native-start-one' }
    native.events.watchEvent(ev)
    // A bridge cleanup Promise is allowed to be slow/lost. Do not await idle here:
    // on the regression version it never settles and navigation never runs.
    for (let i = 0; i < 60; i++) await Promise.resolve()
    expect(useStore.getState().S.active?.watchSid).toBe(ev.sid)
    expect(nav).toHaveBeenCalledExactlyOnceWith('/workout')
    expect(JSON.parse(localStorage.getItem('gym_state_v1')).active.watchSid).toBe(ev.sid)
    expect(native.completeInbox).toHaveBeenCalledWith({ id: ev._inboxId })
  } finally { unbind(); receive.dispose() }
})
