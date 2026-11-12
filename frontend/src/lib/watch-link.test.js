import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { watchCatalogOf } from './watch-workout.js'

const native = vi.hoisted(() => ({
  events: {},
  addListener: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
  getDeviceInfo: vi.fn(), isSupported: vi.fn(),
  getVersion: vi.fn(),
  sendPlan: vi.fn(), sendEvent: vi.fn(), openWatchApp: vi.fn(),
  drainInbox: vi.fn(), completeInbox: vi.fn(),
  loadSyncTransfer: vi.fn(), saveSyncTransfer: vi.fn(),
}))
vi.mock('./mobile.js', () => ({ MOBILE: true, isAndroid: async () => true }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }))

let link
afterEach(async () => { await link?.disconnectWatch(); vi.useRealTimers() })
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  native.events = {}
  native.addListener.mockImplementation((name, cb) => { native.events[name] = cb })
  native.connect.mockResolvedValue({ connected: false })
  native.disconnect.mockResolvedValue({})
  native.sendPlan.mockReset().mockResolvedValue({ ok: true, code: 0 })
  native.openWatchApp.mockReset().mockResolvedValue({ ok: true, code: 0 })
  native.getVersion.mockResolvedValue({ initialized: true })
  native.drainInbox.mockReset().mockResolvedValue({ events: [], pending: 0 })
  native.completeInbox.mockReset().mockResolvedValue({})
  link = await import('./watch-link.js')
})

describe('watch app and plan delivery', () => {
  const workout = name => ({ name, exercises: [{ name: 'Squat', sets: 3, reps: 8 }] })
  const drain = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
  it('preserves Last time and effort capabilities in the actual native plan payload', async () => {
    const S = { unit: 'kg', effort: 'rir', routines: [{ id: 'back', name: 'Back', ex: [{ id: '0025', sets: 4, reps: 8 }] }], watchPlanIds: ['back'],
      workouts: [{ d: '2026-11-01', routineIds: ['back'], entries: [{ id: '0025', rid: 'back', target: { sets: 4 }, sets: [{ w: 42, r: 8, done: true }] }] }] }
    const plan = watchCatalogOf(S).plans[0], lastTime = plan.exercises[0].lastTime
    expect(lastTime).toMatchObject({ date: '2026-11-01', weightUnit: 'kg', sourceRoutineId: 'back', rows: [{ label: '42×8' }] })
    await link.pushPlanToWatch(plan, 'back')
    const sent = JSON.parse(native.sendPlan.mock.calls[0][0].json)
    expect(sent.exercises[0].lastTime).toEqual(lastTime)
    expect(sent.effortScale).toBe('rir')
    expect(sent.capabilities).toEqual({ setEffort: 1 })
  })
  it('confirms the training shortcut only after a same-session business receipt', async () => {
    native.isSupported.mockResolvedValue({ available: true })
    native.sendEvent.mockResolvedValue({ ok: true })
    await link.connectWatch()
    const status = vi.fn()
    const pending = link.continueOnWatch({ sid: 'today', workout: 'Today', exercises: workout('Today').exercises }, status)
    await drain()
    native.events.watchEvent({ t: 'hello', sid: 'other' })
    native.events.watchEvent({ t: 'sync_ack', sid: 'other', status: 'applied' })
    expect(status).not.toHaveBeenCalledWith('手表已确认，可继续训练')
    native.events.watchEvent({ t: 'sync_ack', sid: 'today', status: 'applied' })
    await drain()
    expect(status).not.toHaveBeenCalledWith('手表已确认，可继续训练')
    const plan = JSON.parse(native.sendPlan.mock.calls.at(-1)[0].json)
    native.events.watchEvent({ t: 'plan_ack', sid: plan.sid, planId: 'stale', status: 'applied' })
    await drain()
    expect(status).not.toHaveBeenCalledWith('手表已确认，可继续训练')
    native.events.watchEvent({ t: 'plan_ack', sid: plan.sid, planId: plan.planId, status: 'applied' })
    expect(await pending).toBe(true)
    expect(status).toHaveBeenLastCalledWith('手表已确认，可继续训练')
  })
  it('sends ended on phone completion and lets the global lifecycle reconcile hello before plan replay', async () => {
    native.sendEvent.mockResolvedValue({ ok: true })
    await link.pushPlanToWatch(workout('Today'), 'today')
    const global = vi.fn(() => true)
    link.bindWatchLifecycle(global)
    link.clearWatchPlan()
    await drain()
    expect(native.sendEvent.mock.calls.map(([m]) => JSON.parse(m.json))).toContainEqual(expect.objectContaining({ t: 'ended', sid: 'today' }))
    native.events.watchEvent({ t: 'hello', sid: 'today' })
    expect(global).toHaveBeenCalledWith({ t: 'hello', sid: 'today' })
    expect(native.sendPlan).toHaveBeenCalledOnce()
  })

  it('includes the resulting work-set count in phone group changes', async () => {
    native.sendEvent.mockResolvedValue({ ok: true })
    await link.pushAddSetToWatch('today', 0, 4)
    await link.pushRemoveSetToWatch('today', 0, 3)
    expect(native.sendEvent.mock.calls.map(([m]) => JSON.parse(m.json)))
      .toMatchObject([{ t: 'add_set', sets: 4 }, { t: 'remove_set', sets: 3 }])
  })

  it('opens the watch app after connecting and returns the SDK result', async () => {
    native.openWatchApp.mockResolvedValue({ ok: false, code: 4, data: 'offline' })
    expect(await link.openWatchApp()).toMatchObject({ ok: false, code: 4 })
    expect(native.connect).toHaveBeenCalledOnce()
    expect(native.openWatchApp).toHaveBeenCalledOnce()
    expect(native.events.watchEvent).toBeTypeOf('function')
  })

  it('sends a queued newer plan when the previous send fails', async () => {
    await link.connectWatch()
    let finish
    native.sendPlan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = link.pushPlanToWatch(workout('Old'), 'old')
    await drain()
    await link.pushPlanToWatch(workout('New'), 'new')
    expect(native.sendPlan).toHaveBeenCalledTimes(1)
    finish({ ok: false, code: 5 })
    await first
    await drain()
    expect(native.sendPlan).toHaveBeenCalledTimes(2)
    expect(JSON.parse(native.sendPlan.mock.calls[1][0].json).sid).toBe('new')
  })

  it('replays a hello that arrived during a send without overlapping sends', async () => {
    await link.connectWatch()
    let finish
    native.sendPlan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = link.pushPlanToWatch(workout('Today'), 'today')
    await drain()
    native.events.watchEvent({ t: 'hello', sid: '' })
    await drain()
    expect(native.sendPlan).toHaveBeenCalledTimes(1)
    finish({ ok: true, code: 0 })
    await first
    await drain()
    expect(native.sendPlan).toHaveBeenCalledTimes(2)
  })

  it('retains a failed plan for a later hello without retrying forever', async () => {
    await link.connectWatch()
    native.sendPlan.mockResolvedValue({ ok: false, code: 5 })
    await link.pushPlanToWatch(workout('Today'), 'today')
    await drain()
    expect(native.sendPlan).toHaveBeenCalledTimes(1)
    native.sendPlan.mockResolvedValue({ ok: true })
    native.events.watchEvent({ t: 'hello', sid: '' })
    await drain()
    expect(native.sendPlan).toHaveBeenCalledTimes(2)
    expect(link.watchLastError()).toBe('')
  })

  it('does not resurrect a finished workout when an in-flight send fails', async () => {
    await link.connectWatch()
    let finish
    native.sendPlan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = link.pushPlanToWatch(workout('Today'), 'today')
    await drain()
    link.clearWatchPlan()
    finish({ ok: false, code: 5 })
    await first
    native.events.watchEvent({ t: 'hello', sid: '' })
    await drain()
    expect(native.sendPlan).toHaveBeenCalledTimes(1)
  })

  it('keeps transport success unconfirmed until the current plan receipt arrives', async () => {
    await link.pushPlanToWatch(workout('Today'), 'today')
    const msg = JSON.parse(native.sendPlan.mock.calls[0][0].json)
    expect(msg.planId).toBeTypeOf('string')
    expect((await link.getWatchDiagnostics()).planDelivery).toBe('awaiting_receipt')
    native.events.watchEvent({ t: 'plan_ack', sid: msg.sid, planId: msg.planId,
      status: 'applied', page: 'Index', exercises: 1, watchVersion: '0.4.2' })
    expect(await link.getWatchDiagnostics()).toMatchObject({
      planDelivery: 'applied', watchVersion: '0.4.2',
      lastPlanReceipt: { status: 'applied', page: 'Index' },
    })
  })

  it('does not confirm a newer publication or session using a stale receipt', async () => {
    await link.pushPlanToWatch(workout('Old'), 'today')
    const old = JSON.parse(native.sendPlan.mock.calls[0][0].json)
    await link.pushPlanToWatch(workout('New'), 'today')
    native.events.watchEvent({ t: 'plan_ack', sid: old.sid, planId: old.planId, status: 'applied' })
    expect((await link.getWatchDiagnostics()).planDelivery).toBe('awaiting_receipt')
    const current = JSON.parse(native.sendPlan.mock.calls[1][0].json)
    native.events.watchEvent({ t: 'plan_ack', sid: 'another-session', planId: current.planId, status: 'applied' })
    expect((await link.getWatchDiagnostics()).planDelivery).toBe('awaiting_receipt')
  })

  it('records legacy hello, parse failure, rejection and why an active plan was cleared', async () => {
    await link.pushPlanToWatch(workout('Today'), 'today')
    native.events.watchEvent({ t: 'hello' })
    await drain()
    expect(await link.getWatchDiagnostics()).toMatchObject({
      watchVersion: 'not_reported', watchReceiptsSupported: false, planDelivery: 'awaiting_receipt',
    })
    native.events.watchEvent({ t: 'watch_rx', status: 'invalid_message', keys: ['data'] })
    const msg = JSON.parse(native.sendPlan.mock.calls.at(-1)[0].json)
    native.events.watchEvent({ t: 'plan_ack', sid: msg.sid, planId: msg.planId,
      status: 'rejected', reason: 'session_mismatch', page: 'Workout' })
    expect(await link.getWatchDiagnostics()).toMatchObject({ planDelivery: 'rejected',
      lastWatchRx: { status: 'invalid_message' } })
    link.clearWatchPlan(undefined, 'no_active_session')
    native.events.watchEvent({ t: 'hello' })
    await drain()
    expect(await link.getWatchDiagnostics()).toMatchObject({ planSid: '', planDelivery: 'idle',
      lastPlanClear: { sid: 'today', reason: 'no_active_session' },
      lastPublishedPlan: { sid: 'today', exercises: 1 } })
  })
})

describe('watch connection state', () => {
  it('retries a lost snapshot receipt and stops after an exact baseline receipt', async () => {
    vi.useFakeTimers()
    native.sendEvent.mockResolvedValue({ ok: true })
    await link.connectWatch()
    native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: { durableCommit: true, snapshotChunks: true } })
    await link.pushSyncToWatch({ sid: 's', commitRev: 1, exercises: [], rows: [], ackedEvents: [] })
    expect(native.sendEvent.mock.calls.map(([v]) => JSON.parse(v.json)).filter(v => v.t === 'sync')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(6500)
    expect(native.sendEvent.mock.calls.map(([v]) => JSON.parse(v.json)).filter(v => v.t === 'sync')).toHaveLength(2)
    const sent = JSON.parse(native.sendEvent.mock.calls.at(-1)[0].json)
    native.events.watchEvent({ t: 'sync_ack', sid: 's', status: 'applied', wireHash: sent.wireHash, commitRev: sent.commitRev })
    await vi.advanceTimersByTimeAsync(65000)
    expect(native.sendEvent.mock.calls.map(([v]) => JSON.parse(v.json)).filter(v => v.t === 'sync')).toHaveLength(2)
  })
  it('drains persisted native events after bind and deletes only the committed id', async () => {
    const receive = vi.fn(() => true)
    native.drainInbox.mockResolvedValueOnce({ events: [{ t: 'set', sid: 's', eventId: 'A', _inboxId: 'native:A' }], pending: 1 })
    const unbind = link.bindWatchLifecycle(receive, { getState: () => ({}) })
    await link.connectWatch()
    await link.drainWatchInbox()
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ _inboxId: 'native:A' }))
    expect(native.completeInbox).not.toHaveBeenCalled()
    await link.completeWatchInbox('native:A')
    expect(native.completeInbox).toHaveBeenCalledWith({ id: 'native:A' })
    unbind()
  })

  it('does not redispatch a 40-record backlog while its native inbox entries are still being committed', async () => {
    const batch = Array.from({ length: 40 }, (_, i) => ({ t: 'set', sid: 's', eventId: 'A' + i, _inboxId: 'native:' + i }))
    native.drainInbox.mockImplementation(async () => ({ events: batch.slice(0, 32), pending: batch.length }))
    native.completeInbox.mockImplementation(async ({ id }) => { const i = batch.findIndex(e => e._inboxId === id); if (i >= 0) batch.splice(i, 1) })
    const receive = vi.fn(() => true)
    link.bindWatchLifecycle(receive, { getState: () => ({}) })
    await link.connectWatch(); await link.drainWatchInbox()
    expect(receive).toHaveBeenCalledTimes(32)
    for (let i = 0; i < 32; i++) {
      await link.completeWatchInbox('native:' + i)
      await link.drainWatchInbox()
    }
    expect(receive).toHaveBeenCalledTimes(40)
    expect(new Set(receive.mock.calls.map(([e]) => e.eventId)).size).toBe(40)
  })

  it('releases an inbox claim after native deletion fails and retries the durable entry', async () => {
    vi.useFakeTimers()
    const event = { t: 'set', sid: 's', eventId: 'A', _inboxId: 'native:A' }
    native.drainInbox.mockResolvedValue({ events: [event], pending: 1 })
    native.completeInbox.mockRejectedValueOnce(new Error('disk busy'))
    const receive = vi.fn(() => true)
    const unbind = link.bindWatchLifecycle(receive, { getState: () => ({}) })
    await link.connectWatch(); await link.drainWatchInbox()
    expect(receive).toHaveBeenCalledTimes(1)
    await expect(link.completeWatchInbox('native:A')).rejects.toThrow('disk busy')
    await vi.advanceTimersByTimeAsync(1000)
    expect(receive).toHaveBeenCalledTimes(2)
    native.drainInbox.mockResolvedValue({ events: [], pending: 0 })
    await link.completeWatchInbox('native:A')
    await vi.advanceTimersByTimeAsync(1000)
    expect(receive).toHaveBeenCalledTimes(2)
    unbind()
  })

  it('blocks plan and state messages until a durable commit releases the barrier', async () => {
    native.sendEvent.mockResolvedValue({ ok: true })
    await link.connectWatch()
    const release = link.holdWatchOutbound()
    await link.pushPlanToWatch({ name: 'Today', exercises: [] }, 's')
    const sending = link.pushSyncToWatch({ sid: 's', exercises: [], rows: [] })
    expect(native.sendPlan).not.toHaveBeenCalled()
    expect(native.sendEvent).not.toHaveBeenCalled()
    release(); await sending
    expect(native.sendEvent).toHaveBeenCalledOnce()
  })

  it('negotiates deltas only after a verified watch baseline and falls back for old watches', async () => {
    native.sendEvent.mockResolvedValue({ ok: true })
    await link.connectWatch()
    native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: { durableCommit: true, snapshotChunks: true } })
    const snapshot = { sid: 's', commitRev: 1, exercises: [{ name: 'Bench'.repeat(250), sets: 1 }], rows: [[{ setId: 'a', done: false }]], ackedEvents: [] }
    await link.pushSyncToWatch(snapshot)
    const full = JSON.parse(native.sendEvent.mock.calls.at(-1)[0].json)
    expect(full).toMatchObject({ t: 'sync', protocolVersion: 3 })
    native.events.watchEvent({ t: 'sync_ack', sid: 's', status: 'applied', wireHash: full.wireHash, commitRev: 1 })
    await link.pushSyncToWatch({ ...snapshot, commitRev: 2, rows: [[{ setId: 'a', done: true }]] })
    expect(JSON.parse(native.sendEvent.mock.calls.at(-1)[0].json)).toMatchObject({ t: 'sync_delta', baseCommitRev: 1 })
    native.events.watchEvent({ t: 'sync_request' })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(JSON.parse(native.sendEvent.mock.calls.at(-1)[0].json).t).toBe('sync')
    native.events.watchEvent({ t: 'hello', protocolVersion: 2 })
    await link.pushSyncToWatch(snapshot)
    expect(JSON.parse(native.sendEvent.mock.calls.at(-1)[0].json)).toMatchObject({ t: 'sync', commitRev: 1 })
  })
  it('reads device fields from the SDK device envelope', async () => {
    native.getDeviceInfo.mockResolvedValue({
      ok: true, data: JSON.stringify({ device: { deviceName: 'WATCH', connected: true } }),
    })
    await link.connectWatch()
    const result = await link.getWatchDeviceInfo()
    expect(result.deviceName).toBe('WATCH')
    expect(link.watchDevice()).toMatchObject({ deviceName: 'WATCH', connected: true })
    expect(link.watchState()).toBe('connected')
  })

  it('clears cached connection on a native disconnect and explicit disconnect', async () => {
    await link.connectWatch()
    native.events.watchState({ state: 'connected', connected: true })
    native.events.watchState({ state: 'ready', connected: false })
    expect(link.watchDevice().connected).toBe(false)
    native.events.watchState({ state: 'connected', connected: true })
    await link.disconnectWatch()
    expect(link.watchState()).toBe('off')
    expect(link.watchDevice().connected).toBe(false)
  })

  it('clears an initialization error after a successful retry', async () => {
    native.connect.mockRejectedValueOnce(new Error('health service unavailable'))
    expect(await link.connectWatch()).toBe(false)
    expect(link.watchLastError()).toBe('health service unavailable')
    expect(await link.connectWatch()).toBe(true)
    expect(link.watchState()).toBe('ready')
    expect(link.watchLastError()).toBe('')
  })

  it('does not report a watch connected when only SDK initialization succeeded', async () => {
    await link.connectWatch()
    expect(link.watchState()).toBe('ready')
    expect(link.watchDevice()?.connected).not.toBe(true)
  })

  it('retries listener registration instead of staying half-bound and deaf to the watch', async () => {
    native.addListener.mockImplementationOnce(() => { throw new Error('bridge not ready') })
    expect(await link.connectWatch()).toBe(true)
    expect(native.events.watchEvent).toBeUndefined()      // nothing was silently "bound"
    expect(link.watchLastError()).toContain('bridge not ready')
    expect(await link.connectWatch()).toBe(true)
    expect(native.events.watchEvent).toBeTypeOf('function')
    expect(native.events.watchState).toBeTypeOf('function')
  })

  it('keeps delivering other messages when one lifecycle handler throws', async () => {
    await link.connectWatch()
    link.bindWatchLifecycle(() => { throw new Error('boom') })
    const seen = []
    link.bindWatchSync(ev => seen.push(ev.t))
    native.events.watchEvent({ t: 'focus', sid: 'today', ex: 1, set: 2, at: 10 })
    expect(seen).toEqual(['focus'])
    expect(link.watchLastError()).toContain('boom')
  })
})


describe('explicit watch transport diagnostics', () => {
  const drain = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }
  async function probe() {
    const result = link.requestWatchDiagnostics()
    await drain()
    const sent = JSON.parse(native.sendEvent.mock.calls.at(-1)[0].json)
    return { result, sent }
  }
  beforeEach(() => {
    vi.useFakeTimers()
    native.sendEvent.mockReset().mockResolvedValue({ ok: true, code: 0 })
  })

  it('requires the matching reply and keeps diagnostic events out of training handlers', async () => {
    const lifecycle = vi.fn(() => true), sync = vi.fn(), events = vi.fn()
    link.bindWatchLifecycle(lifecycle)
    link.bindWatchSync(sync)
    link.bindWatchEvents(events)
    const { result, sent } = await probe()
    expect(sent).toEqual({ t: 'watch_diagnostics_request', requestId: expect.any(String) })
    native.events.watchEvent({ t: 'watch_diagnostics', requestId: 'old', pending: 8 })
    expect((await link.getWatchDiagnostics()).watchDiagnosticRequest.status).toBe('pending')
    native.events.watchEvent({ t: 'watch_diagnostics', requestId: sent.requestId, pending: 2,
      events: [{ stage: 'send_fail', code: '77' }] })
    expect(await result).toBe(true)
    expect(await link.getWatchDiagnostics()).toMatchObject({
      watchDiagnosticRequest: { id: sent.requestId, status: 'received' },
      lastWatchTransport: { pending: 2, receivedAt: expect.any(Number), events: [{ code: '77' }] },
    })
    expect(lifecycle).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(events).not.toHaveBeenCalled()
    expect(native.connect).not.toHaveBeenCalled()
    expect(native.sendPlan).not.toHaveBeenCalled()
    expect(native.openWatchApp).not.toHaveBeenCalled()
  })

  it('does not treat SDK success as a reply and times out without reconnecting', async () => {
    const { result } = await probe()
    let done = false
    result.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(2499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe(false)
    expect((await link.getWatchDiagnostics()).watchDiagnosticRequest.status).toBe('timeout')
    expect(native.connect).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'failed'])('reports %s SDK sends without changing training state', async mode => {
    if (mode === 'rejected') native.sendEvent.mockRejectedValueOnce(new Error('offline'))
    else native.sendEvent.mockResolvedValueOnce({ ok: false, code: 5 })
    const { result } = await probe()
    expect(await result).toBe(false)
    expect((await link.getWatchDiagnostics()).watchDiagnosticRequest.status).toBe('send_failed')
    expect(native.sendEvent).toHaveBeenCalledOnce()
    expect(native.connect).not.toHaveBeenCalled()
  })

  it('coalesces simultaneous probes and settles them on disconnect', async () => {
    const first = link.requestWatchDiagnostics(), second = link.requestWatchDiagnostics()
    await drain()
    expect(native.sendEvent).toHaveBeenCalledOnce()
    await link.disconnectWatch()
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect((await link.getWatchDiagnostics()).watchDiagnosticRequest.status).toBe('disconnected')
  })

  it('does not confirm a new request using a late reply to the previous probe', async () => {
    const first = await probe()
    await vi.advanceTimersByTimeAsync(2500)
    expect(await first.result).toBe(false)
    const second = await probe()
    expect(second.sent.requestId).not.toBe(first.sent.requestId)
    native.events.watchEvent({ t: 'watch_diagnostics', requestId: first.sent.requestId })
    expect((await link.getWatchDiagnostics()).watchDiagnosticRequest.status).toBe('pending')
    native.events.watchEvent({ t: 'watch_diagnostics', requestId: second.sent.requestId })
    expect(await second.result).toBe(true)
  })
})


describe('paged persistent watch diagnostic retrieval', () => {
  const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  beforeEach(() => {
    vi.useFakeTimers()
    native.sendEvent.mockReset().mockResolvedValue({ ok: true })
  })
  it('retrieves exact matching pages without invoking workout handlers', async () => {
    const lifecycle = vi.fn(), sync = vi.fn(), event = vi.fn()
    link.bindWatchLifecycle(lifecycle); link.bindWatchSync(sync); link.bindWatchEvents(event)
    const result = link.requestWatchLog()
    expect(link.requestWatchLog()).toBe(result)
    await drain()
    const first = JSON.parse(native.sendEvent.mock.calls.at(-1)[0].json)
    expect(first).toMatchObject({ t: 'watch_log_request', offset: 0 })
    native.events.watchEvent({ t: 'watch_log', requestId: 'old', offset: 0, status: 'ok', events: [] })
    native.events.watchEvent({ t: 'watch_log', requestId: first.requestId, offset: 0, status: 'ok', boot: 'b',
      watchVersion: 'test', total: 2, nextOffset: 1, events: [{ at: 1, stage: 'dot_tap', setId: 'one', secret: 'private' }] })
    await drain()
    const second = JSON.parse(native.sendEvent.mock.calls.at(-1)[0].json)
    expect(second).toEqual({ ...first, offset: 1 })
    native.events.watchEvent({ t: 'watch_log', requestId: first.requestId, offset: 1, status: 'ok', boot: 'b',
      total: 2, nextOffset: 2, events: [{ at: 2, stage: 'app_start' }] })
    const log = await result
    expect(log).toMatchObject({ status: 'received', watchVersion: 'test', events: [{ stage: 'dot_tap' }, { stage: 'app_start' }] })
    expect(JSON.stringify(log)).not.toContain('private')
    expect(lifecycle).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled()
    expect(native.sendPlan).not.toHaveBeenCalled(); expect(native.connect).not.toHaveBeenCalled()
  })
  it('retries a dropped page once with the same identity, then reports timeout', async () => {
    const result = link.requestWatchLog()
    await drain()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toMatchObject({ status: 'timeout', events: [] })
    expect(native.sendEvent).toHaveBeenCalledTimes(2)
    expect(native.sendEvent.mock.calls[0]).toEqual(native.sendEvent.mock.calls[1])
    expect(native.connect).not.toHaveBeenCalled()
  })
  it('rejects malformed offsets instead of looping or accepting a changed export', async () => {
    const result = link.requestWatchLog()
    await drain()
    const req = JSON.parse(native.sendEvent.mock.calls.at(-1)[0].json)
    native.events.watchEvent({ t: 'watch_log', requestId: req.requestId, offset: 0, status: 'ok', total: 10, nextOffset: 0, events: [] })
    expect(await result).toMatchObject({ status: 'invalid_reply' })
    expect(native.sendEvent).toHaveBeenCalledOnce()
  })
})

describe('independent bilateral snapshot capabilities',()=>{
  it.each([[false,false],[true,false],[false,true],[true,true]])('negotiates selective=%s persistent=%s independently',async(selective,persistent)=>{
    native.isSupported.mockResolvedValue({available:true}); native.sendEvent.mockResolvedValue({ok:true,code:0})
    await link.connectWatch()
    native.events.watchEvent({t:'hello',protocolVersion:3,capabilities:{durableCommit:true,snapshotChunks:true,dependencyEvents:false,selectiveChunkAck:selective,persistentTransfers:persistent}})
    for(let i=0;i<20;i++) await Promise.resolve()
    const hello=native.sendEvent.mock.calls.map(([m])=>JSON.parse(m.json)).find(m=>m.t==='hello_ack')
    expect(hello.capabilities).toMatchObject({dependencyEvents:false,selectiveChunkAck:selective,persistentTransfers:persistent})
  })
})


describe('persistent phone adapter does not occupy the coordinator',()=>{
  it('persists TX through the native adapter and sends a business commit while a large transfer awaits its begin ACK',async()=>{
    vi.useFakeTimers()
    let saved={generation:0,active:null,queued:null}
    native.loadSyncTransfer.mockImplementation(async()=>({json:JSON.stringify(saved)}))
    native.saveSyncTransfer.mockImplementation(async({json})=>{saved=JSON.parse(json);return{ok:true}})
    native.sendEvent.mockResolvedValue({ok:true,code:0})
    await link.connectWatch()
    native.events.watchEvent({t:'hello',protocolVersion:3,capabilities:{durableCommit:true,snapshotChunks:true,dependencyEvents:true,selectiveChunkAck:true,persistentTransfers:true}})
    await vi.advanceTimersByTimeAsync(0)
    expect(await link.pushSyncToWatch({sid:'s',commitRev:2,padding:'x'.repeat(19500)})).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    const begin=native.sendEvent.mock.calls.map(([m])=>JSON.parse(m.json)).find(m=>m.t==='sync_begin')
    expect(begin.count).toBeGreaterThanOrEqual(20)
    expect(saved.active.meta.transferId).toBe(begin.transferId)
    expect(saved.active.chunks.join('')).toContain('xxxxx')
    await link.sendToWatch({t:'committed',sid:'s',eventId:'business-during-transfer',status:'applied',commitRev:3})
    expect(native.sendEvent.mock.calls.map(([m])=>JSON.parse(m.json)).at(-1)).toMatchObject({t:'committed',eventId:'business-during-transfer'})
    expect(saved.active.acknowledged).toEqual([])
    await link.disconnectWatch()
    const calls=native.sendEvent.mock.calls.length
    await vi.advanceTimersByTimeAsync(65000)
    expect(native.sendEvent).toHaveBeenCalledTimes(calls)
    expect(saved.active.meta.transferId).toBe(begin.transferId)
  })
})

it('waits for hello and boots training from complete phone rows and revision', async () => {
  native.sendEvent.mockResolvedValue({ ok: true })
  const state = { unit: 'kg', workouts: [], active: { start: 1, watchSid: 's', name: 'Boot', syncRev: 7,
    entries: [{ id: 'plain-bench', entryInstanceId: 'e', sets: [{ setId: 'r', w: 75, r: 9, done: true }] }] } }
  const unbind = link.bindWatchLifecycle(() => false, { getState: () => state, getTimer: () => null, checkpoint: async () => {} })
  try {
    await link.pushPlanToWatch({ name: 'Boot', exercises: [{ name: 'Bench', sets: 1, weight: 50, reps: 8 }] }, 's')
    expect(native.sendPlan).not.toHaveBeenCalled()
    native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: { durableCommit: true, snapshotChunks: true } })
    for (let i = 0; i < 80; i++) await Promise.resolve()
    expect(native.sendPlan).not.toHaveBeenCalled()
    expect(native.sendEvent.mock.calls.map(([m]) => JSON.parse(m.json))).toContainEqual(expect.objectContaining({
      t: 'sync', sid: 's', commitRev: 7, rows: [[{ setId: 'r', w: 75, r: 9, done: true, at: 0 }]]
    }))
  } finally { unbind() }
})


it('confirms atomic bootstrap only after an exact applied persistent snapshot receipt', async () => {
  vi.useFakeTimers()
  native.isSupported.mockResolvedValue({ available: true })
  native.sendEvent.mockResolvedValue({ ok: true })
  let saved = { generation: 0, active: null, queued: null }
  native.loadSyncTransfer.mockImplementation(async () => ({ json: JSON.stringify(saved) }))
  native.saveSyncTransfer.mockImplementation(async ({ json }) => { saved = JSON.parse(json); return { ok: true } })
  const state = { unit: 'kg', workouts: [], active: { start: 1, watchSid: 's', name: 'Boot', syncRev: 7,
    entries: [{ id: 'plain-bench', entryInstanceId: 'e', sets: [{ setId: 'r', w: 75, r: 9, done: true }] }] } }
  const unbind = link.bindWatchLifecycle(() => true, { getState: () => state, getTimer: () => null, checkpoint: async () => {} })
  try {
    const status = vi.fn()
    const pending = link.continueOnWatch({ sid: 's', workout: 'Boot', exercises: [{ name: 'Bench', sets: 1 }] }, status)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.sendPlan).not.toHaveBeenCalled()
    native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: { durableCommit: true, snapshotChunks: true, selectiveChunkAck: true, persistentTransfers: true } })
    await vi.advanceTimersByTimeAsync(0)
    const meta = saved.active.meta
    native.events.watchEvent({ t: 'sync_applied', ...meta, status: 'applied', hash: 'bad' })
    await vi.advanceTimersByTimeAsync(0)
    expect(status).not.toHaveBeenCalledWith('手表已确认，可继续训练')
    native.events.watchEvent({ ...meta, t: 'sync_applied', status: 'applied' })
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending).toBe(true)
    expect((await link.getWatchDiagnostics()).planDelivery).toBe('applied')
    expect(native.sendPlan).not.toHaveBeenCalled()
  } finally { unbind() }
})


it('keeps the negotiated legacy plan path for older watches', async () => {
  native.sendEvent.mockResolvedValue({ ok: true })
  const state = { active: { start: 1, watchSid: 'old', name: 'Old', entries: [] } }
  const unbind = link.bindWatchLifecycle(() => true, { getState: () => state, checkpoint: async () => {} })
  try {
    await link.pushPlanToWatch({ name: 'Old', exercises: [{ name: 'Bench', sets: 1 }] }, 'old')
    expect(native.sendPlan).not.toHaveBeenCalled()
    native.events.watchEvent({ t: 'hello', protocolVersion: 2 })
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(JSON.parse(native.sendPlan.mock.calls[0][0].json)).toMatchObject({ sid: 'old', t: 'plan' })
  } finally { unbind() }
})

it('does not publish a superseded training snapshot after checkpoint resumes', async () => {
  native.sendEvent.mockResolvedValue({ ok: true })
  let state = { unit: 'kg', active: { start: 1, watchSid: 'old', name: 'Old', entries: [] } }, release
  const checkpoint = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValue(undefined)
  const unbind = link.bindWatchLifecycle(() => true, { getState: () => state, getTimer: () => null, checkpoint })
  try {
    await link.pushPlanToWatch({ name: 'Old', exercises: [] }, 'old')
    native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: { durableCommit: true, snapshotChunks: true } })
    for (let i = 0; i < 40; i++) await Promise.resolve()
    state = { unit: 'kg', active: { start: 2, watchSid: 'new', name: 'New', syncRev: 3, entries: [] } }
    await link.pushPlanToWatch({ name: 'New', exercises: [] }, 'new')
    release()
    for (let i = 0; i < 80; i++) await Promise.resolve()
    const snapshots = native.sendEvent.mock.calls.map(([m]) => JSON.parse(m.json)).filter(m => m.t === 'sync')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ sid: 'new', commitRev: 3 })
    expect(native.sendPlan).not.toHaveBeenCalled()
  } finally { unbind() }
})


describe('negotiated compact command baselines', () => {
  const caps = { durableCommit: true, snapshotChunks: true, commandReceipts: true }
  const initial = () => ({ sid: 's', commitRev: 1, exercises: [{ name: 'Bench'.repeat(80), sets: 1 }], rows: [[{ setId: 'a', done: false }]], ackedEvents: [] })
  const messages = () => native.sendEvent.mock.calls.map(([m]) => JSON.parse(m.json))
  it('opts in explicitly and adopts an exact inline ACK without regressing on an older ACK', async () => {
    native.sendEvent.mockResolvedValue({ ok: true })
    await link.connectWatch()
    native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: { ...caps, commandReceipts: false } })
    await link.pushSyncToWatch(initial())
    const base = messages().at(-1), event = { t: 'set', protocolVersion: 3, eventId: 'click', sid: 's', baseCommitRev: 1, appliedRev: 1, appliedHash: base.wireHash }
    const next = { ...initial(), commitRev: 2, rows: [[{ setId: 'a', done: true }]] }
    expect(link.prepareWatchCommandState(event, next)).toBeNull()
    native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: caps })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(messages().findLast(m => m.t === 'hello_ack').capabilities.commandReceipts).toBe(true)
    const correction = link.prepareWatchCommandState(event, next)
    expect(correction.t).toBe('sync_delta')
    native.events.watchEvent({ t: 'sync_ack', status: 'applied', sid: 's', commitRev: 2, wireHash: 'invalid' })
    await link.pushSyncToWatch(next)
    expect(messages().at(-1).t).toBe('sync')
    native.events.watchEvent({ t: 'sync_ack', status: 'applied', sid: 's', commitRev: 2, wireHash: correction.wireHash })
    native.events.watchEvent({ t: 'sync_ack', status: 'applied', sid: 's', commitRev: 1, wireHash: base.wireHash })
    await link.pushSyncToWatch({ ...next, commitRev: 3 })
    expect(messages().at(-1)).toMatchObject({ t: 'sync_delta', baseCommitRev: 2, baseHash: correction.wireHash })
    native.events.watchEvent({ t: 'hello', protocolVersion: 2, capabilities: caps })
    expect(link.prepareWatchCommandState(event, next)).toBeNull()
  })
  it('recovers with fresh phone state after a persistent-only transfer', async () => {
    vi.useFakeTimers()
    let saved = { generation: 0, active: null, queued: null }
    native.loadSyncTransfer.mockImplementation(async () => ({ json: JSON.stringify(saved) }))
    native.saveSyncTransfer.mockImplementation(async ({ json }) => { saved = JSON.parse(json); return { ok: true } })
    native.sendEvent.mockResolvedValue({ ok: true })
    const state = { unit: 'kg', workouts: [], active: { start: 1, watchSid: 's', name: 'Recovery', syncRev: 1,
      entries: [{ entryInstanceId: 'e', name: 'Bench', sets: [{ setId: 'a', w: 60, r: 8, done: false }] }] } }
    const unbind = link.bindWatchLifecycle(() => true, { getState: () => state, getTimer: () => null })
    try {
      await link.connectWatch()
      native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: { ...caps, selectiveChunkAck: true, persistentTransfers: true } })
      await vi.advanceTimersByTimeAsync(0)
      const { watchSnapshotOf } = await import('./watch-workout.js')
      await link.pushSyncToWatch(watchSnapshotOf(state, null))
      await vi.advanceTimersByTimeAsync(0)
      const oldMeta = { ...saved.active.meta }
      state.active.syncRev = 4; state.active.entries[0].sets[0].done = true
      native.events.watchEvent({ t: 'sync_request', sid: 's' })
      await vi.advanceTimersByTimeAsync(0)
      expect(saved.queued.authoritativeSnapshot || saved.queued.snapshot).toMatchObject({ sid: 's', commitRev: 4, rows: [[{ done: true }]] })
      native.events.watchEvent({ ...oldMeta, t: 'sync_applied', status: 'applied' })
      await vi.advanceTimersByTimeAsync(0)
      expect(saved.active.meta.revision).toBe(4)
    } finally { unbind() }
  })
  it('keeps a newer inline baseline when an older persistent transfer is acknowledged late', async () => {
    vi.useFakeTimers()
    let saved = { generation: 0, active: null, queued: null }
    native.loadSyncTransfer.mockImplementation(async () => ({ json: JSON.stringify(saved) }))
    native.saveSyncTransfer.mockImplementation(async ({ json }) => { saved = JSON.parse(json); return { ok: true } })
    native.sendEvent.mockResolvedValue({ ok: true })
    await link.connectWatch()
    native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: { ...caps, selectiveChunkAck: true, persistentTransfers: true } })
    await vi.advanceTimersByTimeAsync(0)
    await link.pushSyncToWatch(initial())
    await vi.advanceTimersByTimeAsync(0)
    const oldMeta = { ...saved.active.meta }, oldSnapshot = saved.active.authoritativeSnapshot || saved.active.snapshot
    const next = { ...initial(), commitRev: 2, rows: [[{ setId: 'a', done: true }]] }
    const correction = link.prepareWatchCommandState({ t: 'set', protocolVersion: 3, eventId: 'click', sid: 's', appliedRev: 1, appliedHash: oldSnapshot.wireHash }, next)
    native.events.watchEvent({ t: 'sync_ack', status: 'applied', sid: 's', commitRev: 2, wireHash: correction.wireHash })
    native.events.watchEvent({ ...oldMeta, t: 'sync_applied', status: 'applied' })
    await vi.advanceTimersByTimeAsync(0)
    await link.pushSyncToWatch({ ...next, commitRev: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(saved.active.snapshot).toMatchObject({ t: 'sync_delta', baseCommitRev: 2, baseHash: correction.wireHash })
  })
})


describe('App automatic plan refresh after a durable command', () => {
  it('cancels an automatic plan already awaiting storage without suppressing a later revision', async () => {
    native.sendEvent.mockResolvedValue({ ok: true })
    const { watchPlanOf, watchSnapshotOf } = await import('./watch-workout.js')
    const { ensureWatchIdentity } = await import('./watch-identity.js')
    const S = { unit: 'kg', workouts: [], active: { start: 1, watchSid: 's', name: 'Bench', syncRev: 1,
      entries: [{ entryInstanceId: 'e', name: 'Bench', sets: [{ setId: 'a', w: 60, r: 8 }] }] } }
    ensureWatchIdentity(S.active, 's')
    let resume, waiting = false
    const unbind = link.bindWatchLifecycle(() => true, { getState: () => S, getTimer: () => null,
      checkpoint: () => waiting ? new Promise(resolve => { resume = resolve }) : Promise.resolve() })
    const publish = () => { const p = watchPlanOf(S); return link.pushPlanToWatch({ ...p.workout,
      protocolVersion: p.protocolVersion, weightUnit: p.weightUnit, structureRevision: p.structureRevision,
      effortScale: p.effortScale, capabilities: p.capabilities }, p.sid, p.profile, { automatic: true }) }
    try {
      await link.connectWatch()
      native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: { durableCommit: true, snapshotChunks: true, commandReceipts: true } })
      await link.pushSyncToWatch(watchSnapshotOf(S, null))
      const base = native.sendEvent.mock.calls.map(([v]) => JSON.parse(v.json)).findLast(m => m.t === 'sync')
      S.active.syncRev = 2; S.active.entries[0].sets[0].w = 62.5
      const correction = link.prepareWatchCommandState({ t: 'weight', sid: 's', protocolVersion: 3,
        eventId: 'w:1', appliedHash: base.wireHash, appliedRev: 1 }, watchSnapshotOf(S, null))
      expect(correction).not.toBeNull()
      waiting = true
      const publication = publish()
      for (let i = 0; i < 30; i++) await Promise.resolve()
      expect(resume).toBeTypeOf('function')
      native.sendEvent.mockClear()
      link.coverWatchCommandPlan(correction)
      waiting = false; resume(); await publication
      expect(native.sendEvent).not.toHaveBeenCalled()
      S.active.syncRev = 3
      await publish()
      expect(native.sendEvent).toHaveBeenCalledOnce()
    } finally { unbind() }
  })
  it.each(['during', 'after'])('does not echo first-row edits when the effect runs %s checkpoint', async timing => {
    native.sendEvent.mockResolvedValue({ ok: true })
    const { watchPlanOf } = await import('./watch-workout.js')
    const { createDurableWatchLifecycle } = await import('./watch-commit.js')
    const { stampWatchRevision } = await import('./watch-revision.js')
    const S = { unit: 'kg', workouts: [], active: { start: 1, watchSid: 's', name: 'Bench day', syncRev: 1,
      entries: [{ entryInstanceId: 'e', name: 'Bench', sets: [{ setId: 'a', w: 60, r: 8, done: false }] }] } }
    const { ensureWatchIdentity } = await import('./watch-identity.js')
    ensureWatchIdentity(S.active, 's')
    const publish = automatic => {
      const p = watchPlanOf(S)
      return link.pushPlanToWatch({ ...p.workout, protocolVersion: p.protocolVersion, weightUnit: p.weightUnit,
        structureRevision: p.structureRevision, effortScale: p.effortScale, capabilities: p.capabilities }, p.sid, p.profile, { automatic })
    }
    let effect = false
    const receive = createDurableWatchLifecycle({ getState: () => S, getTimer: () => null,
      update: (fn, ev) => { const before = structuredClone(S); fn(S); stampWatchRevision(before, S, ev?.installationId || 'watch', ev?.eventId) },
      checkpoint: async () => { if (effect && timing === 'during') { effect = false; await publish(true) } },
      commandState: link.prepareWatchCommandState, commandStateCommitted: link.coverWatchCommandPlan,
      holdOutbound: link.holdWatchOutbound, send: link.sendToWatch, sendSync: link.pushSyncToWatch,
      sendAck: link.pushAckToWatch, sendEnded: link.pushEndedToWatch, finish() {},
    })
    const unbind = link.bindWatchLifecycle(receive, { getState: () => S, getTimer: () => null })
    try {
      await link.connectWatch()
      native.events.watchEvent({ t: 'hello', protocolVersion: 3, capabilities: { durableCommit: true, snapshotChunks: true, commandReceipts: true } })
      await publish(false)
      for (let i = 0; i < 50; i++) await Promise.resolve()
      const messages = () => native.sendEvent.mock.calls.map(([v]) => JSON.parse(v.json))
      const base = messages().findLast(m => m.t === 'sync')
      native.events.watchEvent({ t: 'sync_ack', status: 'applied', sid: 's', commitRev: 1, wireHash: base.wireHash })
      native.sendEvent.mockClear()
      const event = { t: 'weight', sid: 's', protocolVersion: 3, eventId: 'watch:1', installationId: 'watch', seq: 1,
        entryInstanceId: 'e', setId: 'a', ex: 0, set: 1, weight: '62.5', at: Date.now(), baseCommitRev: 1, appliedRev: 1, appliedHash: base.wireHash }
      effect = true
      receive(event); await receive.idle()
      if (timing === 'after') await publish(true)
      for (let i = 0; i < 50; i++) await Promise.resolve()
      expect(S.active.entries[0].sets[0].w).toBe(62.5)
      const commit = messages().find(m => m.t === 'committed')
      expect(commit.state?.t).toBe('sync_delta')
      expect(messages().map(m => m.t)).toEqual(['committed'])
      native.events.watchEvent({ t: 'sync_ack', status: 'applied', sid: 's', commitRev: commit.commitRev, wireHash: commit.state.wireHash })
      expect((await link.getWatchDiagnostics()).planDelivery).toBe('applied')
      await publish(false)
      expect(messages().filter(m => m.t === 'sync' || m.t === 'sync_delta')).toHaveLength(1)
      S.active.entries[0].name = 'New exercise'
      await publish(true)
      expect(messages().filter(m => m.t === 'sync' || m.t === 'sync_delta')).toHaveLength(2)
    } finally { receive.dispose(); unbind() }
  })
})
