// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wireHash } from '../../../watch-app/src/lib/sync-wire.js'

const native = vi.hoisted(() => ({ events: {}, addListener: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), openWatchApp: vi.fn(),
  cancelWorkoutStart: vi.fn(), sendEvent: vi.fn(), sendPlan: vi.fn(), drainInbox: vi.fn() }))
vi.mock('./mobile.js', () => ({ MOBILE: true, isAndroid: async () => true }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }))
const selected = 'watch-gt-selected'
const state = { unit: 'kg', routines: [{ id: 'r-private', name: 'Unrelated private routine' }], workouts: [], watchClosed: {} }
const makeWorkout = (sid = 'current') => ({ name: 'Today', start: 1234, watchSid: sid, watchSessionGeneration: 1, entries: [
  { id: 'bench', entryInstanceId: 'exercise-a', sets: [{ setId: 'row-a', w: 50, r: 10 }] },
] })
let link, handoff, stop, stopLifecycle, foreground, onStore
const update = active => { state.active = active; onStore() }
const settle = async () => { for (let i = 0; i < 90; i++) await Promise.resolve() }
const sent = () => native.sendEvent.mock.calls.map(([input]) => JSON.parse(input.json))
const starts = () => sent().filter(m => m.t === 'START_SESSION' || m.transferId?.startsWith('start:'))
const emit = (message, sourceInstallationId = selected) => native.events.watchEvent({ ...message, sourceInstallationId })
const online = connected => native.events.watchState({ state: connected ? 'connected' : 'ready', connected })
const hello = async (epoch = 'one', protocolVersion = 4) => {
  emit({ t: 'hello', helloId: epoch, linkEpoch: epoch, installationId: selected, protocolVersion,
    capabilities: { deviceSelection: true, stateSnapshot: protocolVersion === 4, sessionPresence: true, planCatalogChunks: true } })
  await settle()
  const probe = sent().findLast(m => m.t === 'link_probe')
  if (probe) emit({ t: 'link_probe_ack', requestId: probe.requestId })
  await settle()
}
const snapshot = (data = {}, source = selected) => {
  const query = sent().findLast(m => m.t === 'STATE_QUERY')
  const value = { t: 'STATE_SNAPSHOT', protocolVersion: 4, requestId: query.requestId, sid: '', active: false, ...data }
  emit({ ...value, wireHash: wireHash(value) }, source)
}

beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); vi.resetAllMocks()
  const disk = new Map([['opengym_blueos_devices_v1', JSON.stringify({ selectedId: selected, devices: [{ id: selected }] })]])
  vi.stubGlobal('localStorage', { getItem: k => disk.get(k), setItem: (k, value) => disk.set(k, value) })
  state.active = null; state.watchClosed = {}
  native.events = {}
  native.connect.mockResolvedValue({ connected: true }); native.disconnect.mockResolvedValue({})
  native.openWatchApp.mockResolvedValue({ ok: true }); native.sendEvent.mockResolvedValue({ ok: true })
  native.drainInbox.mockResolvedValue({ events: [] })
  native.addListener.mockImplementation(async (name, cb) => { native.events[name] = cb; return { remove() {} } })
  link = await import('./watch-link.js'); handoff = await import('./watch-current-workout.js')
  stopLifecycle = link.bindWatchLifecycle(() => true, { getState: () => state, currentWorkoutOnly: true, checkpoint: async () => {} })
  stop = handoff.bindCurrentWorkoutWatchHandoff({ getState: () => state, getTimer: () => null,
    subscribe: cb => { onStore = cb; return () => {} }, subscribeForeground: cb => { foreground = cb; cb(true) } })
  await link.connectWatch()
})
afterEach(async () => { stop(); stopLifecycle(); await link.disconnectWatch(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('current phone workout watch handoff', () => {
  it('wakes the selected SDK-connected watch before hello and sends only the latest workout after verified idle', async () => {
    expect(link.watchConnection()).toMatchObject({ sdkConnected: true, appConnected: false, peerId: '' })
    expect(native.openWatchApp).not.toHaveBeenCalled()
    update(makeWorkout()); await settle()
    expect(native.openWatchApp).toHaveBeenCalledExactlyOnceWith({ requireOnline: true, workoutStartToken: expect.any(String) })
    expect(starts()).toEqual([])
    await hello()
    snapshot({}, 'different-watch'); await settle()
    expect(starts()).toEqual([])
    state.active.entries[0].sets[0].w = 52.5; onStore()
    snapshot(); await settle()
    const [start] = starts()
    expect(start).toMatchObject({ t: 'START_SESSION', sid: 'current', workout: 'Today', targetInstallationId: selected,
      exercises: [{ entryInstanceId: 'exercise-a', sets: [{ setId: 'row-a', weight: 52.5, reps: '10' }] }] })
    expect(JSON.stringify(sent())).not.toContain('Unrelated private routine')
    expect(start).not.toHaveProperty('profile')
    expect(native.sendPlan).not.toHaveBeenCalled()
    emit({ t: 'SESSION_ACCEPTED', protocolVersion: 4, requestId: start.requestId, sid: start.sid, status: 'accepted' })
    await settle()
    expect(handoff.currentWorkoutWatchStatus().phase).toBe('synced')
    onStore(); foreground(false); foreground(true); await settle()
    expect(starts()).toHaveLength(1)
    expect(native.openWatchApp).toHaveBeenCalledTimes(1)
  })
  it('automatically recovers a failed pre-start wake after a genuine disconnect and reconnect, without looping', async () => {
    native.openWatchApp.mockResolvedValueOnce({ ok: false })
    update(makeWorkout()); await settle()
    expect(handoff.currentWorkoutWatchStatus().phase).toBe('failed')
    for (let i = 0; i < 4; i++) { online(true); onStore() }
    await settle(); expect(native.openWatchApp).toHaveBeenCalledTimes(1)
    online(false); online(true); await settle()
    expect(native.openWatchApp).toHaveBeenCalledTimes(2)
    await hello('reconnect'); snapshot(); await settle()
    expect(starts()).toHaveLength(1)
  })
  it('keeps an in-flight start at most once across reconnection and reconciles when the watch is already training', async () => {
    update(makeWorkout()); await settle(); await hello(); snapshot(); await settle()
    expect(starts()).toHaveLength(1)
    online(false); online(true); await settle(); await hello('after'); snapshot({ sid: 'current', active: true }); await settle()
    expect(starts()).toHaveLength(1)
    expect(native.openWatchApp).toHaveBeenCalledTimes(1)
    expect(handoff.currentWorkoutWatchStatus().phase).toBe('synced')
  })
  it('never wakes a background, ended, watch-led or history-edit workout', async () => {
    foreground(false); update(makeWorkout()); await settle()
    expect(native.openWatchApp).not.toHaveBeenCalled()
    update(null); foreground(true); await settle()
    state.watchClosed.current = { sid: 'current' }
    update(makeWorkout()); await settle()
    update({ ...makeWorkout('editor'), editingWorkoutId: 'old' }); await settle()
    update({ ...makeWorkout('watch-led'), watchStarted: true }); await settle()
    expect(native.openWatchApp).not.toHaveBeenCalled()
    expect(starts()).toEqual([])
  })
  it('cancels a queued launch on stop and ignores a late launch completion or watch idle', async () => {
    let complete
    native.openWatchApp.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    update(makeWorkout()); await settle()
    const token = native.openWatchApp.mock.calls[0][0].workoutStartToken
    update(null); await settle()
    expect(native.cancelWorkoutStart).toHaveBeenCalledWith({ token })
    complete({ ok: true }); await settle(); await hello(); snapshot(); await settle()
    expect(starts()).toEqual([])
    expect(handoff.currentWorkoutWatchStatus().phase).toBe('idle')
  })
  it('offers explicit retry after failure, rejects a legacy hello and does not overwrite another watch session', async () => {
    native.openWatchApp.mockResolvedValueOnce({ ok: false })
    update(makeWorkout()); await settle()
    handoff.retryCurrentWorkoutOnWatch(); await settle()
    expect(native.openWatchApp).toHaveBeenCalledTimes(2)
    await hello('legacy', 3)
    expect(await link.pushSyncToWatch({ sid: 'current' })).toBe(false)
    expect(starts()).toEqual([])
    await hello('modern'); snapshot({ sid: 'watch-other', active: true }); await settle()
    expect(starts()).toEqual([])
    expect(handoff.currentWorkoutWatchStatus().phase).toBe('conflict')
  })
})
