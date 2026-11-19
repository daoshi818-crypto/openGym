// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadWatchModule, stripImports, watchPersistence, watchSource } from './watch-test-harness.js'
import { watchCatalogOf } from './watch-workout.js'
import { startFromWatch } from './watch-events.js'
import { wireHash } from '../../../watch-app/src/lib/sync-wire.js'
import { makeTransfer } from '../../../watch-app/src/lib/persistent-transfer.js'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-19T12:00:00')) })
afterEach(() => vi.useRealTimers())
const drain = async () => { for (let i = 0; i < 220; i++) await Promise.resolve() }
function home() {
  const ctx = { Date, setTimeout, clearTimeout, WATCH_VERSION: 'test', loadState: () => ({}), storage: { getSync: () => null },
    startServer() {}, router: {}, bindRuntime() {} }
  const source = stripImports(watchSource('Index/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1])
  runInNewContext(source.replace('export default', 'this.page ='), ctx)
  return Object.assign(ctx.page, ctx.page.data, { catalogModel: { current: null } })
}
const routine = id => ({ id, name: id, ex: [{ id: '0025', sets: 3, reps: 8 }] })
const state = () => ({ routines: ['a', 'b', 'c'].map(routine), week: { 4: ['b', 'a'] }, dayPlan: {}, workouts: [], unit: 'kg' })

it('shows ordered combined today and only other routines below, with a small reactive projection', () => {
  const p = home(), catalog = watchCatalogOf(state(), '2026-11-19')
  p.onCatalog(catalog)
  expect(p.hasToday).toBe(true)
  expect(p.workoutName).toBe('b + a')
  expect(p.plans.map(p => p.id)).toEqual(['c'])
  expect(p.selected).toEqual({ id: 'today:2026-11-19', name: 'b + a' })
  expect(p.plans[0]).not.toHaveProperty('entries')
  expect(p.catalogModel.current).toBe(catalog)
  p.onCatalog({ ...catalog, todayPlan: { ...catalog.todayPlan, name: '更新后的今日训练' } })
  expect(p.workoutName).toBe('更新后的今日训练')
  p.onCatalog({ t: 'plan_catalog', date: '2026-11-19', todayPlan: null, plans: [] })
  expect(p.needSync).toBe(false); expect(p.hasToday).toBe(false); expect(p.selected).toBeNull()
  expect(p.workoutName).toBe(''); expect(p.setCount).toBe(0)
})
it('expires the today card across midnight, retains the offline library and clears the page timer', async () => {
  const p = home(); p.onCatalog(watchCatalogOf(state(), '2026-11-19')); p.visible = true; p.checkDay()
  expect(p.hasToday).toBe(true)
  vi.setSystemTime(new Date('2026-11-20T00:01:00'))
  await vi.advanceTimersByTimeAsync(60000)
  expect(p.hasToday).toBe(false); expect(p.plans).toHaveLength(3)
  p.onHide(); expect(vi.getTimerCount()).toBe(0)
})
it('starts a combined today session on the phone without losing routine provenance or order', () => {
  const S = state(), plan = watchCatalogOf(S, '2026-11-19').todayPlan
  expect(startFromWatch(S, { t: 'watch_start', sid: 's', startedAt: Date.now(), plan })).toBe('started')
  expect(S.active.routineIds).toEqual(['b', 'a'])
  expect(S.active.entries.map(e => e.rid)).toEqual(['b', 'a'])
})
it('publishes the catalog and an applied receipt only after confirmed storage, and preserves a newer catalog', async () => {
  const { ctx, storage, disk } = watchPersistence(), sent = [], changed = vi.fn()
  const connection = { getReadyState({ success }) { success({ status: 1 }) }, send({ data, success }) { sent.push(data); success() } }
  Object.assign(ctx, { console, Date, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    interconnect: { instance: () => connection }, loadState: () => ({}), save() {}, WATCH_VERSION: 'test',
    pendingSummaries: () => [], pendingCloseEvents: () => [] })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('rpc', ctx, ['startServer'])
  ctx.startServer({ onCatalog: changed }); await drain()
  const original = storage.set, message = { t: 'plan_catalog', date: '2026-11-19', plans: [], at: Date.now(), catalogId: 'catalog:1' }
  message.contentHash = wireHash(message)
  let release
  storage.set = value => { if (value.key === 'plan_catalog') release = () => original(value); else original(value) }
  connection.onMessage({ data: message }); await drain()
  expect(changed).not.toHaveBeenCalled()
  expect(sent.filter(m => m.t === 'plan_catalog_ack')).toEqual([])
  release(); await drain()
  expect(changed).toHaveBeenCalledOnce()
  expect(sent.findLast(m => m.t === 'plan_catalog_ack').status).toBe('applied')
  const old = { ...message, at: message.at - 1000, catalogId: 'catalog:0' }; delete old.contentHash; old.contentHash = wireHash(old)
  connection.onMessage({ data: old }); await drain(); release(); await drain()
  expect(sent.findLast(m => m.t === 'plan_catalog_ack').status).toBe('retained')
  expect(disk.get('plan_catalog').catalogId).toBe('catalog:1')
  expect(changed).toHaveBeenCalledOnce()
})
it('does not block training transfer receipts behind a delayed catalog disk write', async () => {
  const { ctx, storage } = watchPersistence(), sent = []
  const connection = { getReadyState({ success }) { success({ status: 1 }) }, send({ data, success }) { sent.push(data); success() } }
  Object.assign(ctx, { console, Date, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    interconnect: { instance: () => connection }, loadState: () => ({}), save() {}, WATCH_VERSION: 'test',
    pendingSummaries: () => [], pendingCloseEvents: () => [] })
  loadWatchModule('rpc', ctx, ['startServer'])
  ctx.startServer({}); await drain()
  connection.onMessage({ data: { t: 'hello_ack', protocolVersion: 3, capabilities: { planCatalogChunks: true, persistentTransfers: true, selectiveChunkAck: true } } })
  const original = storage.set, held = []
  storage.set = item => { if (item.key.startsWith('catalog_')) held.push(item); else original(item) }
  const library = makeTransfer({ t: 'plan_catalog', sid: 'catalog', commitRev: 1, plans: [], date: '2026-11-19' }, 1, Date.now(), { channel: 'catalog', types: ['plan_catalog'] })
  const training = makeTransfer({ t: 'sync', sid: 'training', commitRev: 1, exercises: [] }, 1, Date.now())
  connection.onMessage({ data: { ...library.meta, t: 'sync_begin' } }); await drain()
  expect(held).toHaveLength(1)
  connection.onMessage({ data: { ...training.meta, t: 'sync_begin' } }); await drain()
  await vi.advanceTimersByTimeAsync(150)
  expect(sent).toContainEqual(expect.objectContaining({ t: 'sync_begin_ack', transferId: training.meta.transferId }))
  for (const item of held) original(item)
  await drain()
})
