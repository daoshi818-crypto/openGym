// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadWatchModule, stripImports, watchPersistence, watchSource } from './watch-test-harness.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function boot() {
  const h = watchPersistence(), { ctx, storage } = h, sent = []
  const connection = { getReadyState: ({ success }) => success({ status: 0 }),
    send: ({ data, success }) => { sent.push(data); success() } }
  const router = { replace: vi.fn() }
  Object.assign(ctx, { interconnect: { instance: () => connection }, console, router, WATCH_VERSION: 'test',
    bindRuntime() {}, pendingSummaries: () => [], pendingCloseEvents: () => [] })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('session', ctx, ['loadState', 'commitPhoneStart'])
  loadWatchModule('session-presence', ctx, ['confirmPhoneSession', 'applyPhonePresence', 'isPhoneSessionLive'])
  loadWatchModule('rpc', ctx, ['startServer', 'isPhoneConnected'])
  const script = stripImports(watchSource('Index/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1])
  runInNewContext(script.replace('export default', 'this.page ='), ctx)
  const home = Object.assign(ctx.page, ctx.page.data, ctx.page.staticData)
  return { ...h, home, connection, router, sent, reads: vi.spyOn(storage, 'getSync'), writes: vi.spyOn(storage, 'set') }
}

const start = { t: 'START_SESSION', protocolVersion: 4, requestId: 'start1', sid: 's1', workout: '上肢',
  exercises: [{ entryInstanceId: 'e1', exerciseId: 'bench', name: '卧推', sets: [{ setId: 'set1', reps: 8, weight: 40 }] }] }
const finishRpc = () => vi.advanceTimersByTimeAsync(350)

it('ignores old inline/chunk catalog traffic without loading the old cache or blocking START', async () => {
  const h = boot(), previous = { plans: [{ id: 'old' }] }
  h.disk.set('plan_catalog', previous)
  h.home.onInit(); h.home.onReady(); h.connection.onOpen()
  h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { planCatalogChunks: true } })
  h.connection.onMessage({ t: 'plan_catalog', plans: [{ id: 'new' }] })
  for (const t of ['sync_begin', 'sync_chunk', 'sync_resume', 'sync_cancel', 'sync_inline']) {
    h.connection.onMessage({ t, transferId: 'c:library' })
  }
  await finishRpc()
  expect(h.sent.find(m => m.t === 'hello').capabilities).not.toHaveProperty('planCatalogChunks')
  expect(h.sent.some(m => m.t === 'plan_catalog_ack' || m.transferId === 'c:library')).toBe(false)
  expect(h.shared.rpc).not.toHaveProperty('catalogReceiver')
  expect(h.reads.mock.calls.some(([item]) => item.key.includes('catalog'))).toBe(false)
  expect(h.writes.mock.calls.some(([item]) => item.key.includes('catalog'))).toBe(false)
  expect(h.disk.get('plan_catalog')).toEqual(previous)
  expect(h.router.replace).not.toHaveBeenCalled()
  h.connection.onMessage({ t: 'STATE_QUERY', requestId: 'query1' })
  h.connection.onMessage(start)
  await finishRpc()
  expect(h.disk.get('session_state').workout.exercises.map(ex => ex.name)).toEqual(['卧推'])
  expect(h.sent).toContainEqual(expect.objectContaining({ t: 'SESSION_ACCEPTED', sid: 's1', status: 'accepted' }))
  expect(h.router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Workout' })
})

it('opens a durable START exactly once if it arrives before Index is ready', async () => {
  const h = boot()
  h.home.onInit(); h.connection.onOpen()
  h.connection.onMessage({ t: 'STATE_QUERY', requestId: 'query1' })
  h.connection.onMessage(start)
  await finishRpc()
  expect(h.disk.get('session_state').sid).toBe('s1')
  expect(h.router.replace).not.toHaveBeenCalled()
  h.home.onReady(); h.home.onShow()
  h.connection.onMessage(start)
  await finishRpc()
  expect(h.router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Workout' })
})

it('does not open a START that fails storage, and opens once after a valid retry', async () => {
  const h = boot(), write = h.storage.set
  h.home.onInit(); h.home.onReady(); h.connection.onOpen()
  h.storage.set = args => { if (args.key === 'session_state') args.fail(); else write(args) }
  h.connection.onMessage({ t: 'STATE_QUERY', requestId: 'query1' })
  h.connection.onMessage(start)
  await finishRpc()
  expect(h.router.replace).not.toHaveBeenCalled()
  expect(h.ctx.loadState().active).toBe(false)
  expect(h.sent).toContainEqual(expect.objectContaining({ t: 'SESSION_ACCEPTED', status: 'rejected', reason: 'storage_failed' }))
  h.storage.set = write
  h.connection.onMessage(start)
  await finishRpc()
  expect(h.router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Workout' })
})
