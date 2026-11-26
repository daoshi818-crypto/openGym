// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { watchPersistence, loadWatchModule, watchSource, stripImports, watchInteractionDeps } from './watch-test-harness.js'
import * as effort from '../../../watch-app/src/lib/effort-scale.js'
import * as protocol from '../../../watch-app/src/lib/protocol.js'
import { lastTimeView } from '../../../watch-app/src/lib/watch-last-time.js'
import { sourceTemplate } from '../../../watch-app/scripts/source-template.mjs'

// Native Page contract: bound methods, raw staticData, strong object proxies.
// In particular an in-flight Promise must not be put in a reactive Page field.
function setup({ rest = false } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-19T07:00:00Z'))
  const h = watchPersistence(), c = h.ctx, router = { replace: vi.fn(), push: vi.fn() }
  Object.assign(c, watchInteractionDeps, effort, protocol, { Date, console, lastTimeView, router,
    setTimeout, clearTimeout, setInterval, clearInterval, startServer() {}, startSessionHr() {}, stopSessionHr() {},
    tick() {}, restOver() {}, sendEvent: vi.fn(), sendControl() {}, pendingCount: () => 0, isConnected: () => false,
    persistenceStatus: () => ({}), synchronizationStatus: () => ({}), brightness: {},
  })
  loadWatchModule('event-id', c, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', c, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
  loadWatchModule('session', c, ['loadState', 'startSession', 'save', 'toggleSet', 'nextUndone', 'calories', 'addRestTime'])
  const s = c.startSession({ sid: 'hold', name: '推部训练', protocolVersion: 3, exercises: [
    { entryInstanceId: 'bench', name: '哑铃推肩', sets: 3, reps: 10, weight: 12, restSec: 90 },
  ] })
  if (rest) { s.restUntil = Date.now() + 90000; s.restId = 'rest'; s.restVersion = Date.now(); s.restTargetSec = 90; c.save(s) }
  runInNewContext(stripImports(watchSource('Workout/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'this.definition ='), c)
  const definition = c.definition, data = structuredClone(definition.data), raw = structuredClone(definition.staticData), methods = {}, retained = new Map()
  const wrap = v => {
    if (!v || typeof v !== 'object') return v
    if (!retained.has(v)) retained.set(v, new Proxy(v, { get: (t,k) => wrap(t[k]), set: (t,k,x) => { t[k] = x; return true } }))
    return retained.get(v)
  }
  const p = new Proxy({}, {
    get: (_,k) => k === '$element' ? () => ({ requestFocus() {} }) : Object.hasOwn(raw,k) ? raw[k] : methods[k] || wrap(data[k]),
    set: (_,k,v) => { data[k] = v; return true },
  })
  for (const [k,fn] of Object.entries(definition)) if (typeof fn === 'function') methods[k] = fn.bind(p)
  p.onInit({}); p.pageIndex = 0
  return { ...h, c, p, router, data, raw }
}
afterEach(() => vi.useRealTimers())
const down = p => p.touchStart({ touches: [{ clientX: 180, clientY: 240 }] })
it('keeps one full-button touch surface above both changing progress fills', () => {
  const nodes = n => [n,...(n.children || []).flatMap(nodes)]
  const holds = nodes(sourceTemplate(watchSource('Workout/index.ux'))).filter(n=>n.class==='hold-finish')
  expect(holds).toHaveLength(2)
  for(const hold of holds) {
    expect(hold.children.at(-1)).toMatchObject({class:'hold-touch',events:{touchstart:'startFinishHold',touchend:'endFinishHold',touchcancel:'cancelFinishHold'}})
    expect(hold.children.at(-1).children).toEqual([])
  }
})

it('a full hold saves once offline and navigates only after the durable local close', async () => {
  const { p, c, router } = setup()
  down(p); p.startFinishHold()
  await vi.advanceTimersByTimeAsync(700)
  expect(c.loadState().active).toBe(true); expect(router.replace).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(350)
  expect(c.loadState().active).toBe(false)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
  expect(p.finishProgress).toBe('0%'); expect(p.holdingFinish).toBe(false)
})
it('duplicate touch starts during one uninterrupted hold cannot restart its deadline', async () => {
  const { p, c, router } = setup()
  down(p); p.startFinishHold()
  await vi.advanceTimersByTimeAsync(400); p.startFinishHold()
  await vi.advanceTimersByTimeAsync(400); p.startFinishHold()
  await vi.advanceTimersByTimeAsync(300)
  expect(c.loadState().active).toBe(false)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})
it('the progress callback also completes a valid hold if its one-shot deadline callback is lost', async () => {
  const { p, c, router } = setup()
  c.setTimeout = (fn, ms) => ms === 1000 ? 0 : setTimeout(fn, ms)
  down(p); p.startFinishHold(); await vi.advanceTimersByTimeAsync(1200)
  expect(c.loadState().active).toBe(false)
  expect(p.holdingFinish).toBe(false); expect(p.finishProgress).toBe('0%')
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})
it('a hold waits behind an already committing group instead of silently dropping the save request', async () => {
  const { p, c, router, storage } = setup(), write = storage.set
  let release
  storage.set = item => { if (item.key === 'session_state' && !release) release = () => write(item); else write(item) }
  const group = p.onComplete()
  expect(p.localCommitPending).toBe(true)
  down(p); p.startFinishHold(); await vi.advanceTimersByTimeAsync(1100)
  expect(p.closeSaving).toBe(true)
  release(); await group; await vi.advanceTimersByTimeAsync(100)
  expect(c.loadState().active).toBe(false)
  expect(c.journalEntry('hold').closeEvent.completedSets).toHaveLength(1)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})
it('a transport failure cannot strand a workout page after the local close was already saved', async () => {
  const { p, c, router } = setup()
  c.sendEvent.mockImplementation(() => { throw Error('native send unavailable') })
  c.replayPendingEvents = vi.fn(() => { throw Error('native send unavailable') })
  await p.saveEnd()
  expect(c.loadState().active).toBe(false)
  expect(c.journalEntry('hold').closeEvent.disposition).toBe('saved')
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
  expect(p.closeError).toBe('')
  expect(c.replayPendingEvents).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(100)
  expect(c.replayPendingEvents).toHaveBeenCalledOnce()
})
it.each(['watch_close_journal_v1', 'closed_sessions', 'summary_last', 'clear'])('keeps the frozen close immutable and retryable after %s fails', async key => {
  const { p, c, router, storage } = setup({ rest: true }), write = storage.set
  storage.set = item => item.key === key || key === 'clear' && item.key === 'session_state' && !item.value.active ? item.fail() : write(item)
  p.closeMode = 'complete'; p.allFinished = true; p.completionIgnoreUntil = 0
  await p.saveEnd()
  expect(p.closeSaving).toBe(false); expect(router.replace).not.toHaveBeenCalled()
  const frozen = c.readStored('session_state').closeIntent
  expect(frozen.close.disposition).toBe('saved')
  expect(p.closeFrozen).toBe(true)
  expect(p.stateOf().closeIntent).toEqual(frozen)
  p.askAbandon(); p.cancelClose(); await p.onPause(); await p.nudgeRest(15)
  await vi.advanceTimersByTimeAsync(95000); p.tickClock(true)
  expect(c.readStored('session_state').closeIntent).toEqual(frozen)
  expect(p.closeMode).toBe('complete')
  storage.set = write
  down(p); p.startFinishHold(); await vi.advanceTimersByTimeAsync(1100)
  expect(c.loadState().active).toBe(false)
  expect(c.journalEntry('hold').closeEvent).toEqual(frozen.close.closeEvent)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})
it('a frozen partial workout offers the existing end retry without claiming all groups are completed', async () => {
  const { p, c, storage } = setup(), write = storage.set
  storage.set = item => item.key === 'summary_last' ? item.fail() : write(item)
  await p.saveEnd()
  expect(c.loadState().closeIntent).toBeTruthy()
  expect(p.closeMode).toBe('end'); expect(p.allFinished).toBe(false)
})
it('a retry enters results if App recovery already completed the frozen close behind the page', async () => {
  const { p, c, router, storage } = setup(), write = storage.set
  storage.set = item => item.key === 'summary_last' ? item.fail() : write(item)
  await p.saveEnd()
  expect(p.closeFrozen).toBe(true)
  const closeEvent = c.readStored('session_state').closeIntent.close.closeEvent
  storage.set = write
  expect((await c.recoverLocalClose()).ok).toBe(true)
  expect(c.loadState().active).toBe(false)
  await p.saveEnd()
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
  expect(p.closeError).toBe('')
  expect(c.journalEntry('hold').closeEvent).toEqual(closeEvent)
})
it.each(['tombstone', 'journal', 'summary'])('does not treat unrelated %s evidence as a recovered successful save', async missing => {
  const { p, c, router, storage } = setup(), write = storage.set
  storage.set = item => item.key === 'summary_last' ? item.fail() : write(item)
  await p.saveEnd(); storage.set = write
  await c.recoverLocalClose()
  if (missing === 'tombstone') c.writeStored('closed_sessions', [])
  if (missing === 'summary') c.writeStored('summary_last', { sid: 'another' })
  if (missing === 'journal') {
    const journal = c.readStored('watch_close_journal_v1'); journal.entries.hold.closeEvent.eventId = 'another'
    c.writeStored('watch_close_journal_v1', journal)
  }
  await p.saveEnd()
  expect(router.replace).not.toHaveBeenCalled()
})
it('a lost storage callback releases the save lock and permits retry with the same close identity', async () => {
  const { p, c, router, storage } = setup(), write = storage.set
  let late
  storage.set = item => { if (item.key === 'watch_close_journal_v1') late = item; else write(item) }
  const save = p.saveEnd()
  await vi.advanceTimersByTimeAsync(5100); await save
  expect(p.closeSaving).toBe(false)
  const frozen = c.readStored('session_state').closeIntent
  storage.set = write
  await p.saveEnd()
  late.success(); await vi.advanceTimersByTimeAsync(100)
  expect(c.journalEntry('hold').closeEvent).toEqual(frozen.close.closeEvent)
  expect(c.loadState().active).toBe(false)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})
it('connection wording stays on the home screen while training only reports pending work or failures', () => {
  const { p, c } = setup()
  c.isPhoneConnected = () => false
  p.tickSyncStatus(true)
  expect(p.syncLabel).toBe(''); expect(p.syncWarning).toBe(false)
  c.pendingCount = () => 3; c.synchronizationStatus = () => ({ pending: 3, phonePending: 0 }); p.tickSyncStatus(true)
  expect(p.syncLabel).toBe('待上传 3 条')
  c.synchronizationStatus = () => ({ pending: 0, phonePending: 0, historicalPending: 3 }); p.tickSyncStatus(true)
  expect(p.syncLabel).toBe(''); expect(p.syncWarning).toBe(false)
  expect(watchSource('Workout/index.ux')).not.toMatch(/手机已连接|手机未连接/)
  expect(watchSource('Index/index.ux')).toMatch(/手机已连接/)
  expect(watchSource('Index/index.ux')).toMatch(/手机未连接/)
})
it.each(['touchCancel','touchEnd'])('a root %s releases a partial hold even if the child callback was lost', async cancel => {
  const { p, c, router } = setup()
  down(p); p.startFinishHold(); await vi.advanceTimersByTimeAsync(700)
  p[cancel]({ changedTouches: [{ clientX: 180, clientY: 240 }] })
  expect(p.finishProgress).toBe('0%'); expect(p.holdingFinish).toBe(false)
  await vi.advanceTimersByTimeAsync(600)
  expect(c.loadState().active).toBe(true); expect(router.replace).not.toHaveBeenCalled()
})
it('switching to abandon cancels a partial save hold and allows the abandon confirmation', async () => {
  const { p, c, router } = setup()
  down(p); p.startFinishHold(); await vi.advanceTimersByTimeAsync(700)
  p.askAbandon(); expect(p.closeMode).toBe('abandon'); expect(p.finishProgress).toBe('0%')
  await vi.advanceTimersByTimeAsync(500)
  expect(c.loadState().active).toBe(true)
  await p.abandonEnd()
  expect(c.loadState().active).toBe(false)
  expect(c.journalEntry('hold').closeEvent.disposition).toBe('abandoned')
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Index' })
})
it('can finish after adjusting rest: no Promise is retained by the native reactive Page', async () => {
  const { p, c, router, data } = setup({ rest: true })
  expect(await p.nudgeRest(15)).toBe(true)
  expect(Object.values(data).some(v => Object.prototype.toString.call(v) === '[object Promise]')).toBe(false)
  down(p); p.startFinishHold(); await vi.advanceTimersByTimeAsync(1100)
  expect(c.loadState().active).toBe(false)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})
it('root cancellation and hide clean the deadline and progress timers without ending training', async () => {
  const { p, c, router } = setup()
  down(p); p.startFinishHold(); await vi.advanceTimersByTimeAsync(700)
  p.onHide(); await vi.advanceTimersByTimeAsync(1500)
  expect(p.finishProgress).toBe('0%'); expect(p.closeSaving).toBeFalsy()
  expect(c.loadState().active).toBe(true); expect(router.replace).not.toHaveBeenCalled()
})
it('release after the deadline completes even if native timer callbacks were delayed', async () => {
  const { p, c, router } = setup()
  down(p); p.startFinishHold()
  vi.setSystemTime(Date.now() + 1200)
  await p.endFinishHold()
  await vi.advanceTimersByTimeAsync(1000)
  expect(c.loadState().active).toBe(false)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})
it('a failed local save releases the lock, retains an error and lets the user abandon', async () => {
  const { p, c, router, storage } = setup(), write = storage.set
  storage.set = item => item.key === 'session_state' ? item.fail() : write(item)
  await p.saveEnd()
  expect(c.loadState().active).toBe(true); expect(p.closeSaving).toBe(false)
  expect(p.closeError).toContain('未结束')
  p.tickClock(true); expect(p.closeError).toContain('未结束')
  storage.set = write
  p.askAbandon(); await p.abandonEnd()
  expect(c.loadState().active).toBe(false)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Index' })
})
