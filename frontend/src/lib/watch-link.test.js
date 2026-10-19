import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  events: {},
  addListener: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
  getDeviceInfo: vi.fn(), isSupported: vi.fn(),
  getVersion: vi.fn(),
  sendPlan: vi.fn(), sendEvent: vi.fn(), openWatchApp: vi.fn(),
}))
vi.mock('./mobile.js', () => ({ MOBILE: true, isAndroid: async () => true }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }))

let link
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
  link = await import('./watch-link.js')
})

describe('watch app and plan delivery', () => {
  const workout = name => ({ name, exercises: [{ name: 'Squat', sets: 3, reps: 8 }] })
  const drain = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
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
})
