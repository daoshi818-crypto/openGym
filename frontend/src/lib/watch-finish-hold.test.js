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
  loadWatchModule('session', c, ['loadState', 'startSession', 'save', 'nextUndone', 'calories', 'addRestTime'])
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
