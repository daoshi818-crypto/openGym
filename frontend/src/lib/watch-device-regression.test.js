// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { watchSource, stripImports, watchInteractionDeps, watchPersistence, loadWatchModule } from './watch-test-harness.js'
import * as effort from '../../../watch-app/src/lib/effort-scale.js'
import * as protocol from '../../../watch-app/src/lib/protocol.js'
import { lastTimeView } from '../../../watch-app/src/lib/watch-last-time.js'
import { dependenciesFor, causalAncestor, selectReadyEvent } from '../../../watch-app/src/lib/event-dependencies.js'

// Model the observed BlueOS Vm.ctx contract (Studio framework 7af9d62):
// bound methods, receiver-ignoring writes, raw staticData, strong reactiveMap.
// This is a bridge-contract regression, not an on-device heap measurement.
function nativePage(definition) {
  const data = structuredClone(definition.data), staticData = structuredClone(definition.staticData || {})
  const retained = new Map(), methods = {}, focus = vi.fn()
  const wrap = value => {
    if (!value || typeof value !== 'object') return value
    if (!retained.has(value)) retained.set(value, new Proxy(value, { get: (t, k) => wrap(t[k]), set: (t, k, v) => { t[k] = v; return true } }))
    return retained.get(value)
  }
  const page = new Proxy({}, {
    get: (_, key) => key === '$element' ? () => ({ requestFocus: focus })
      : Object.hasOwn(staticData, key) ? staticData[key]
        : Object.hasOwn(methods, key) ? methods[key] : wrap(data[key]),
    set: (_, key, value) => { if (!Object.hasOwn(staticData, key) && !Object.hasOwn(methods, key)) data[key] = value; return true },
  })
  for (const [key, fn] of Object.entries(definition)) if (typeof fn === 'function') methods[key] = fn.bind(page)
  return { page, retained, data, focus }
}
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-19T04:30:00Z'))
  const h = watchPersistence(), ctx = h.ctx
  Object.assign(ctx, watchInteractionDeps, effort, protocol, { Date, console, lastTimeView,
    setTimeout, clearTimeout, setInterval, clearInterval, startServer() {}, startSessionHr() {}, stopSessionHr() {},
    tick() {}, restOver() {}, crownTick() {}, persistenceStatus: () => ({}), storageStatus: () => ({}), synchronizationStatus: () => ({}),
    pendingCount: () => 0, isConnected: () => true, router: { replace() {}, push() {} }, brightness: {} })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('session', ctx, ['startSession', 'loadState', 'save', 'setRowValue', 'nextUndone', 'calories', 'commitSessionAction', 'toggleSet', 'stageSessionEvent'])
  ctx.sendEvent = ev => ctx.stageSessionEvent(ctx.loadState(), ev)
  ctx.startSession({ sid: 'device', name: '推日', protocolVersion: 3, exercises: [
    { entryInstanceId: 'bench', name: '哑铃卧推', sets: 5, weight: 12, reps: 12, restSec: 60, muscles: { chest: 1 } },
  ] })
  const source = process.env.WATCH_BASELINE_SOURCE ? readFileSync(process.env.WATCH_BASELINE_SOURCE, 'utf8') : watchSource('Workout/index.ux')
  runInNewContext(stripImports(source.match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'this.definition ='), ctx)
  const native = nativePage(ctx.definition)
  native.page.onInit({}); native.page.onReady()
  return { ...h, ...native, ctx }
}
afterEach(() => vi.useRealTimers())

it('does not put successive session documents into the native strong proxy map', () => {
  const { page, retained, ctx } = setup()
  for (let i = 0; i < 50; i++) { const s = ctx.loadState(); s.rev = i; page.adoptSession(s); page.refresh() }
  const sessions = [...retained.keys()].filter(o => o.sid === 'device' && o.workout)
  expect(sessions).toHaveLength(0)
})
it('reuses visible zone and overview objects throughout 30 minutes of HR display ticks', () => {
  const { page } = setup()
  const zones = page.zoneRows, firstZone = zones[0], overview = page.overviewRows, firstEntry = overview[0]
  for (let i = 0; i < 900; i++) { vi.setSystemTime(Date.now() + 2000); page.tickMetrics(true); page.updateOfficialViews() }
  expect(page.zoneRows).toBe(zones); expect(page.zoneRows[0]).toBe(firstZone)
  expect(page.overviewRows).toBe(overview); expect(page.overviewRows[0]).toBe(firstEntry)
})
it('selects weight, handles both native and wrapped crown events, and keeps a raw local number draft', async () => {
  const { page, ctx, focus } = setup()
  page.editWeight(); expect(page.selectedField).toBe('w')
  await page.onRotation({ detail: { state: 1, direction: true, delta: 1 } })
  expect(page.weightNum).toBe('12.5'); expect(ctx.loadState().workout.rows[0][0].w).toBe(12)
  await page.onRotation({ state: 2, direction: false, delta: -1 })
  expect(ctx.loadState().workout.rows[0][0].w).toBe(12)
  await page.onRotation({ state: 3, delta: 1 })
  expect(ctx.loadState().pendingEdits || []).toHaveLength(0)
  vi.advanceTimersByTime(1); expect(focus).toHaveBeenCalledWith(true)
  page.onHide(); const calls = focus.mock.calls.length
  vi.advanceTimersByTime(100); expect(focus).toHaveBeenCalledTimes(calls)
})
it('ignores an unselected crown without creating a storage transaction', async () => {
  const { page, storage } = setup(), set = vi.spyOn(storage, 'set')
  await page.onRotation({ delta: 1, state: 2 })
  expect(set).not.toHaveBeenCalled()
})
it('keeps the offline dependency frontier linear while preserving every causal ancestor', () => {
  const pending = []
  for (let i = 0; i < 256; i++) {
    const event = { eventId: 'f' + i, t: 'focus', sid: 's', dependencyEvents: true }
    event.dependsOn = dependenciesFor(event, pending, true); pending.push(event)
  }
  expect(pending.reduce((n, e) => n + e.dependsOn.length, 0)).toBe(255)
  const seen = new Set(), stack = [pending.at(-1).eventId], byId = new Map(pending.map(e => [e.eventId, e]))
  while (stack.length) { const id = stack.pop(); if (!seen.has(id)) { seen.add(id); stack.push(...byId.get(id).dependsOn) } }
  expect(seen.size).toBe(256)
})
it('does not infer dependency ancestry through a legacy or independent event', () => {
  const event = { sid: 's', t: 'focus', eventId: 'new' }
  expect(dependenciesFor(event, [{ sid: 's', t: 'focus', eventId: 'a' }, { sid: 's', t: 'focus', eventId: 'b', dependsOn: ['a'] }])).toEqual(['a', 'b'])
})
it('does not retain a new coordinate object for every touch-move callback', () => {
  const { page, retained } = setup()
  for (let swipe = 0; swipe < 200; swipe++) {
    page.touchStart({ touches: [{ clientX: 250, clientY: 200 }] })
    for (let move = 0; move < 20; move++) page.touchMove({ touches: [{ clientX: 250 - move * 8, clientY: 200 }] })
    page.touchEnd({ touches: [] })
  }
  expect([...retained.keys()].filter(o => Object.keys(o).sort().join(',') === 'x,y')).toHaveLength(2)
})
it('requires durable same-session applied ancestry for compact field conflict checks', () => {
  const event = { sid: 's', dependsOn: ['parent'] }
  const records = { parent: { sid: 's', status: 'applied', parents: ['grandparent'] }, grandparent: { sid: 's', status: 'applied' } }
  expect(causalAncestor(event, 'grandparent', id => records[id])).toBe(true)
  for (const status of ['received', 'rejected', 'conflict']) {
    records.parent.status = status
    expect(causalAncestor(event, 'grandparent', id => records[id])).toBe(false)
  }
  records.parent.status = 'applied'; records.grandparent.sid = 'other'
  expect(causalAncestor(event, 'grandparent', id => records[id])).toBe(false)
  delete records.grandparent
  expect(causalAncestor(event, 'grandparent', id => records[id])).toBe(false)
})

it('keeps keyboard draft objects out of the native proxy map and commits final values with completion', async () => {
  const { page, ctx, retained, storage } = setup()
  const writes = vi.spyOn(storage, 'set')
  page.editWeight()
  for (let i = 0; i < 200; i++) page.onRotation({ delta: 1 })
  page.editWeight(); page.numberKey8(); page.numberKey0(); page.saveNumberKeypad()
  page.editReps(); page.onRotation({ delta: 1 })
  expect(writes).not.toHaveBeenCalled()
  expect(page.keypadOn).toBe(false); expect(page.weightNum).toBe('80')
  expect([...retained.keys()].filter(o => o.target && 'dirtyW' in o)).toHaveLength(0)
  expect(await page.onComplete()).toBe(true)
  const s = ctx.loadState(), events = s.pendingEdits
  expect(s.workout.rows[0][0]).toMatchObject({ w: '80', r: '13', done: true })
  expect(events.filter(e => e.t === 'set')).toHaveLength(1)
  expect(events.find(e => e.t === 'set').setId).toBeUndefined()
  expect(events.find(e => e.t === 'set').weight).toBeUndefined()
  expect(events.find(e => e.t === 'set').reps).toBeUndefined()
  expect(events.filter(e => ['weight','reps'].includes(e.t))).toHaveLength(0)
  expect(writes.mock.calls.filter(([v]) => v.key === 'session_state')).toHaveLength(1)
})
it('keeps the number draft after failed completion and retries without duplicating a set event', async () => {
  const { page, ctx, storage } = setup()
  page.editWeight(); page.onRotation({ delta: 1 })
  const original = storage.set
  storage.set = item => item.key === 'session_state' ? item.fail?.({ code: 'disk_full' }) : original(item)
  expect(await page.onComplete()).toBe(false)
  expect(ctx.loadState().workout.rows[0][0].done).toBe(false)
  expect(page.numberDraftOf().w).toBe('12.5')
  storage.set = original
  expect(await page.onComplete()).toBe(true)
  expect(ctx.loadState().workout.rows[0][0]).toMatchObject({ w: '12.5', done: true })
  expect(ctx.loadState().pendingEdits.filter(e => e.t === 'set')).toHaveLength(1)
})
it('reconciles untouched fields but preserves an intentional draft across phone snapshots', () => {
  const { page, ctx } = setup()
  page.editWeight(); page.onRotation({ delta: 1 })
  const remote = ctx.loadState(); remote.workout.rows[0][0].w = '50'; remote.workout.rows[0][0].r = '15'
  page.adoptSession(remote); page.refresh()
  expect(page.weightNum).toBe('12.5'); expect(page.repsNum).toBe('15')
  page.onHide(); page.onShow(); expect(page.weightNum).toBe('12.5')
})

it('allows a new negotiated focus to be overtaken by an independent row edit, preserving lifecycle barriers', () => {
  const focus = { sid: 's', t: 'focus', eventId: 'focus', dependencyEvents: true, narrowDependencies: true, dependsOn: [] }
  const weight = { sid: 's', t: 'weight', eventId: 'weight', entryInstanceId: 'e', setId: 'r', dependencyEvents: true, narrowDependencies: true, dependsOn: [] }
  expect(dependenciesFor(weight, [focus])).toEqual([])
  const entries = [{ msg: focus, nextAttemptAt: 5000 }, { msg: weight }]
  expect(selectReadyEvent(entries, new Set(['focus','weight']), {}, 1000, true)?.msg.eventId).toBe('weight')
  expect(dependenciesFor(weight, [{ ...focus, narrowDependencies: false }])).toEqual(['focus'])
  for (const t of ['session_close','watch_start','pause','add_set','remove_set']) {
    expect(dependenciesFor(weight, [{ ...focus, t }])).toEqual(['focus'])
  }
  expect(dependenciesFor({ ...weight, sid: 'new' }, [focus])).toEqual(['focus'])
})
