// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { persistentReceiver } from '../../../watch-app/src/lib/persistent-transfer.js'

const native = vi.hoisted(() => ({ callbacks: {}, disk: new Map(), addListener: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
  getDeviceInfo: vi.fn(), sendEvent: vi.fn(), loadSyncTransfer: vi.fn(), saveSyncTransfer: vi.fn(), drainInbox: vi.fn() }))
vi.mock('./mobile.js', () => ({ MOBILE: true, isAndroid: async () => true }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }))
let link
const drain = async () => { for (let i = 0; i < 160; i++) await Promise.resolve() }
const hello = id => native.callbacks.watchEvent({ t: 'hello', installationId: id, protocolVersion: 3,
  capabilities: { deviceSelection: true, planCatalogChunks: true, durableCommit: true, snapshotChunks: true } })
const messages = () => native.sendEvent.mock.calls.map(([v]) => JSON.parse(v.json))
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks()
  const values = new Map()
  vi.stubGlobal('localStorage', { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) })
  native.callbacks = {}; native.disk = new Map()
  native.addListener.mockImplementation(async (name, cb) => { native.callbacks[name] = cb; return { remove() {} } })
  native.connect.mockResolvedValue({ connected: true }); native.disconnect.mockResolvedValue({})
  native.drainInbox.mockResolvedValue({ events: [] })
  native.getDeviceInfo.mockResolvedValue({ ok: true, data: JSON.stringify({ device: { connected: true, name: 'WATCH GT' } }) })
  native.sendEvent.mockReset().mockResolvedValue({ ok: true })
  const key = p => p.channel + ':' + p.deviceId
  native.loadSyncTransfer.mockImplementation(async p => ({ json: native.disk.get(key(p)) || 'null' }))
  native.saveSyncTransfer.mockImplementation(async p => { native.disk.set(key(p), p.json); return {} })
  link = await import('./watch-link.js')
  await link.connectWatch()
})
afterEach(async () => { await link.disconnectWatch(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('requires current-route proof before following a different installation or accepting its training event', async () => {
  hello('watch-one')
  expect(link.watchConnection()).toMatchObject({ selectedId: '', selectionRequired: true, appConnected: false })
  expect(messages()).not.toContainEqual(expect.objectContaining({ t: 'hello_ack' }))
  expect(await link.selectWatchDevice('watch-one')).toEqual({ ok: true })
  hello('watch-one'); await drain()
  native.sendEvent.mockClear()
  const event = vi.fn(); const off = link.bindWatchLifecycle(event)
  hello('watch-two')
  native.callbacks.watchEvent({ t: 'set', sourceInstallationId: 'watch-two', installationId: 'watch-two', eventId: 'two:1' })
  expect(event).not.toHaveBeenCalled()
  expect(link.watchConnection()).toMatchObject({ selectedId: 'watch-one', peerId: 'watch-one', differentDevice: false, appConnected: false })
  expect(await link.sendToWatch({ t: 'ack', eventId: 'two:1' })).toBe(false)
  expect(messages().every(m => m.t === 'link_probe')).toBe(true); off()
})

it('first selection is allowed with a waiting phone training plan, and source/request must both match a fresh probe', async () => {
  const off = link.bindWatchLifecycle(() => false, { getState: () => ({ active: { start: 1 } }) })
  hello('watch-one')
  expect((await link.selectWatchDevice('watch-one')).ok).toBe(true)
  hello('watch-one'); await drain()
  const probe = link.probeWatchConnection(); await drain()
  const request = messages().findLast(m => m.t === 'link_probe')
  expect(request.targetInstallationId).toBe('watch-one')
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: request.requestId, sourceInstallationId: 'watch-two' })
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: 'old', sourceInstallationId: 'watch-one' })
  expect(link.watchConnection().appConnected).toBe(false)
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: request.requestId, sourceInstallationId: 'watch-one' })
  expect(await probe).toBe(true)
  expect(link.watchConnection().appConnected).toBe(true)
  await vi.advanceTimersByTimeAsync(15001)
  expect(link.watchConnection().appConnected).toBe(false)
  const timed = link.probeWatchConnection(); await drain(); await vi.advanceTimersByTimeAsync(5000)
  expect(await timed).toBe(false)
  hello('watch-two')
  expect((await link.selectWatchDevice('watch-two')).ok).toBe(false)
  native.callbacks.watchState({ state: 'disconnected', connected: false })
  expect(link.watchConnection()).toMatchObject({ appConnected: false, peerId: '', sdkConnected: false })
  off()
})

it('automatically follows only a freshly challenged Health route after reinstall and isolates old inboxes', async () => {
  const active = { start: 1, entries: [] }, receive = vi.fn(() => true)
  const off = link.bindWatchLifecycle(receive, { getState: () => ({ active }) })
  native.callbacks.watchEvent({ t: 'watch_start', sourceInstallationId: 'old', eventId: 'stale-start' })
  expect(receive).not.toHaveBeenCalled()
  hello('old'); await drain()
  let probe = messages().findLast(m => m.t === 'link_probe')
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: probe.requestId, sourceInstallationId: 'old' }); await drain()
  expect(link.watchConnection()).toMatchObject({ selectedId: 'old', appConnected: true })
  hello('new'); await drain()
  probe = messages().findLast(m => m.t === 'link_probe')
  expect(probe.targetInstallationId).toBe('new')
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: probe.requestId, sourceInstallationId: 'wrong' }); await drain()
  expect(link.watchConnection().selectedId).toBe('old')
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: probe.requestId, sourceInstallationId: 'new' }); await drain()
  expect(link.watchConnection()).toMatchObject({ selectedId: 'new', peerId: 'new', appConnected: true })
  expect(link.watchConnection().devices.map(d => d.id)).toEqual(['new'])
  receive.mockClear()
  native.callbacks.watchEvent({ t: 'set', eventId: 'old:1', sourceInstallationId: 'old' })
  expect(receive).not.toHaveBeenCalled()
  await link.drainWatchInbox()
  expect(native.drainInbox).toHaveBeenLastCalledWith({ deviceId: 'new' }); off()
})

it('ignores an old installation keepalive while challenging the newly discovered current route', async () => {
  hello('old'); await drain()
  let request = messages().findLast(m => m.t === 'link_probe')
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: request.requestId, sourceInstallationId: 'old' }); await drain()
  const oldProbe = link.probeWatchConnection(); await drain()
  const oldRequest = messages().findLast(m => m.t === 'link_probe')
  hello('new'); await drain()
  request = messages().findLast(m => m.t === 'link_probe')
  expect(request.targetInstallationId).toBe('new')
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: oldRequest.requestId, sourceInstallationId: 'old' }); await drain()
  expect(link.watchConnection().appConnected).toBe(false)
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: request.requestId, sourceInstallationId: 'new' }); await drain()
  expect(await oldProbe).toBe(false)
  expect(link.watchConnection()).toMatchObject({ selectedId: 'new', peerId: 'new', appConnected: true })
})

it('replays the current installation inbox after reconnect negotiation, preserving pre-hello isolation', async () => {
  const receive = vi.fn(() => true)
  const off = link.bindWatchLifecycle(receive, { getState: () => ({}) })
  hello('one'); await drain()
  const probe = messages().findLast(m => m.t === 'link_probe')
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: probe.requestId, sourceInstallationId: 'one' }); await drain()
  await vi.advanceTimersByTimeAsync(100)
  native.callbacks.watchState({ state: 'disconnected', connected: false })
  receive.mockClear()
  const event = { t: 'set', sourceInstallationId: 'one', eventId: 'one:cached', _inboxId: 'cached' }
  native.drainInbox.mockResolvedValue({ events: [event] })
  await link.drainWatchInbox()
  expect(receive).not.toHaveBeenCalled()
  native.callbacks.watchState({ state: 'connected', connected: true })
  hello('one'); await drain(); receive.mockClear()
  await vi.advanceTimersByTimeAsync(100)
  expect(receive).toHaveBeenCalledWith(event)
  off()
})

it('probes the selected app immediately even if Health device metadata never answers', async () => {
  hello('one'); await link.selectWatchDevice('one'); hello('one'); await drain()
  native.getDeviceInfo.mockImplementation(() => new Promise(() => {}))
  const probe = link.probeWatchConnection(); await drain()
  const request = messages().findLast(m => m.t === 'link_probe')
  expect(request).toBeTruthy()
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: request.requestId, sourceInstallationId: 'one' })
  expect(await probe).toBe(true)
})

it('never adopts a candidate from an expired challenge or an ACK received after disconnect', async () => {
  hello('candidate'); await drain()
  const probe = messages().findLast(m => m.t === 'link_probe')
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: 'old', sourceInstallationId: 'candidate' }); await drain()
  expect(link.watchConnection().appConnected).toBe(false)
  native.callbacks.watchState({ state: 'disconnected', connected: false })
  native.callbacks.watchEvent({ t: 'link_probe_ack', requestId: probe.requestId, sourceInstallationId: 'candidate' }); await drain()
  expect(link.watchConnection()).toMatchObject({ selectedId: '', appConnected: false })
})

it('streams the complete catalog on its own durable channel and reports synced only after watch apply succeeds', async () => {
  hello('watch-one'); await link.selectWatchDevice('watch-one'); hello('watch-one'); await drain()
  const disk = new Map(), applied = [], options = { channel: 'catalog', types: ['plan_catalog'] }
  let canApply = false
  const receiver = persistentReceiver({ read: async k => structuredClone(disk.get(k)), write: async (k, v) => { disk.set(k, structuredClone(v)); return true } },
    async msg => { if (!canApply) return { ok: false, error: 'transfer_storage' }; applied.push(msg); return { ok: true } }, () => Date.now(), options)
  native.sendEvent.mockImplementation(async ({ json }) => {
    const { targetInstallationId, ...m } = JSON.parse(json)
    if (m.transferId?.startsWith('c:')) {
      expect(targetInstallationId).toBe('watch-one')
      for (const reply of await receiver.receive(m)) native.callbacks.watchEvent({ ...reply, sourceInstallationId: 'watch-one' })
    }
    return { ok: true }
  })
  const catalog = { t: 'plan_catalog', date: '2026-11-19', todayIds: ['b'], plans: [{ id: 'a', name: '中文'.repeat(1800) }, { id: 'b', name: '今日训练' }] }
  expect(await link.pushWatchCatalog(catalog)).toBe(true)
  for (let i = 0; i < 35; i++) await vi.advanceTimersByTimeAsync(100)
  expect(link.watchCatalogStatus()).toMatchObject({ phase: 'failed', error: 'transfer_storage' })
  expect(applied).toHaveLength(0)
  expect([...native.disk.keys()]).toEqual(['catalog:watch-one'])
  canApply = true
  await vi.advanceTimersByTimeAsync(6000)
  expect(applied).toHaveLength(1)
  expect(applied[0].plans.map(p => p.id)).toEqual(['a', 'b'])
  expect(link.watchCatalogStatus()).toMatchObject({ phase: 'synced', count: 2, date: '2026-11-19' })
  const sentCount = messages().filter(m => m.t !== 'link_probe').length
  expect(await link.pushWatchCatalog(catalog)).toBe(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(messages().filter(m => m.t !== 'link_probe')).toHaveLength(sentCount)
})
