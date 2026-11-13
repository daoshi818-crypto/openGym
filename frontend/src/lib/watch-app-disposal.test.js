// App teardown must release native callback roots across repeated launches.
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { loadWatchModule, stripImports, watchPersistence, watchSource } from './watch-test-harness.js'

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

function appHarness() {
  vi.useFakeTimers()
  const h = watchPersistence(), definition = { openGymRuntime: h.shared }
  const log = vi.fn(), stopped = vi.fn()
  Object.assign(h.ctx, { bindRuntime() {}, WATCH_VERSION: 'test', recordDiagnostic: log,
    flushDiagnosticLog() {}, console: { log() {} } })
  runInNewContext(stripImports(watchSource('app.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'globalThis.app ='), h.ctx)
  const app = h.ctx.app
  app.onCreate.call({ $def: definition })
  h.shared.hrCapture = { stop: stopped }
  return { ...h, app, definition, stopped, log }
}

it('closes RPC and cancels App timers when the application is destroyed', () => {
  const h = appHarness(), close = vi.fn(), onState = vi.fn(), sent = []
  const connection = { close, send: ({ data, success }) => { sent.push(data); success?.() }, getReadyState: ({ success }) => success({ status: 0 }) }
  Object.assign(h.ctx, { interconnect: { instance: () => connection }, loadState: () => ({ active: false }),
    pendingSummaries: () => [], pendingEntry: () => null, journalEntry: () => null, rememberEventAt() {} })
  loadWatchModule('rpc', h.ctx, ['startServer', 'stopServer'])
  h.ctx.startServer({ onState })
  connection.onOpen()
  const lateMessage = connection.onMessage, lateOpen = connection.onOpen
  h.app.onDestroy.call({ $def: h.definition })
  expect(close).toHaveBeenCalledOnce()
  expect(h.stopped).toHaveBeenCalledOnce()
  const count = sent.length
  onState.mockClear()
  lateOpen(); lateMessage({ t: 'hello_ack', protocolVersion: 3 })
  vi.advanceTimersByTime(30000)
  expect(sent).toHaveLength(count)
  expect(onState).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('ignores late storage completion after teardown without starting another SDK write', async () => {
  const h = appHarness(), pending = [], writes = []
  h.storage.set = args => { writes.push(args.key); pending.push(args) }
  const first = h.ctx.writeStoredAtomic('session_state', () => ({ sid: 's' }))
  const second = h.ctx.writeStoredAtomic('session_state', () => ({ sid: 's', exIdx: 1 }))
  h.app.onDestroy.call({ $def: h.definition })
  pending[0].success()
  await Promise.resolve()
  expect(writes).toEqual(['session_state'])
  expect((await first).ok).toBe(false)
  expect((await second).ok).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not revive an earlier binding when the SDK reuses the same connection object', () => {
  const h = appHarness(), onState = vi.fn()
  const connection = { close() {}, send: ({ success }) => success?.(), getReadyState: ({ success }) => success({ status: 0 }) }
  Object.assign(h.ctx, { interconnect: { instance: () => connection }, loadState: () => ({ active: false }),
    pendingSummaries: () => [], pendingEntry: () => null, journalEntry: () => null, rememberEventAt() {} })
  loadWatchModule('rpc', h.ctx, ['startServer', 'stopServer'])
  h.ctx.startServer({ onState })
  const oldOpen = connection.onOpen
  h.ctx.stopServer(); h.ctx.startServer({ onState })
  onState.mockClear(); oldOpen()
  expect(onState).not.toHaveBeenCalled()
  connection.onOpen()
  expect(onState).toHaveBeenCalledWith(true)
  h.app.onDestroy.call({ $def: h.definition })
})
