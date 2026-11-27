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
function setup({ rest = false, protocolVersion = 3, connection } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-19T07:00:00Z'))
  const h = watchPersistence(), c = h.ctx, router = { replace: vi.fn(), push: vi.fn() }
  Object.assign(c, watchInteractionDeps, effort, protocol, { Date, console, lastTimeView, router,
    setTimeout, clearTimeout, setInterval, clearInterval, startServer() {}, startSessionHr() {}, stopSessionHr() {},
    tick() {}, restOver() {}, sendEvent: vi.fn(), sendControl() {}, pendingCount: () => 0, isConnected: () => false,
    persistenceStatus: () => ({}), synchronizationStatus: () => ({}), brightness: {},
  })
  loadWatchModule('event-id', c, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', c, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
  loadWatchModule('session', c, ['loadState', 'startSession', 'save', 'toggleSet', 'nextUndone', 'setEffort', 'calories', 'addRestTime'])
  const s = c.startSession({ sid: 'finish', name: '推部训练', protocolVersion, exercises: [
    { entryInstanceId: 'bench', name: '哑铃推肩', sets: 3, reps: 10, weight: 12, restSec: 90 },
  ] })
  if (protocolVersion === 4) { s.sessionOrigin = 'phone'; s.phoneSession = { sid: s.sid }; c.save(s) }
  if (rest) { s.restUntil = Date.now() + 90000; s.restId = 'rest'; s.restVersion = Date.now(); s.restTargetSec = 90; c.save(s) }
  if (connection) {
    c.interconnect = { instance: () => connection }
    loadWatchModule('rpc', c, ['startServer', 'sendControl', 'sendEvent', 'pendingCount', 'replayPendingEvents'])
  }
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
async function openEndConfirmation(p) {
  p.askEnd()
  await vi.advanceTimersByTimeAsync(300)
}

it('binds separate buttons for opening, confirming and cancelling the end dialog', () => {
  const nodes = n => [n, ...(n.children || []).flatMap(nodes)]
  const workout = nodes(sourceTemplate(watchSource('Workout/index.ux')))
  expect(workout.filter(n => n.action === 'askEnd')).toHaveLength(2)
  const dialog = nodes(workout.find(n => n.class === 'modal-content'))
  expect(dialog.filter(n => n.action === 'confirmEnd')).toHaveLength(1)
  expect(dialog.filter(n => n.action === 'cancelClose')).toHaveLength(1)
})

it('opens the dialog on the first tap and waits for a separate confirmation to save', async () => {
  const { p, c, router, storage } = setup()
  const writes = vi.spyOn(storage, 'set')
  p.askEnd()
  expect(p.closeMode).toBe('end')
  p.confirmEnd()
  await vi.advanceTimersByTimeAsync(1500)
  expect(writes).not.toHaveBeenCalled()
  expect(router.replace).not.toHaveBeenCalled()
  expect(c.loadState().active).toBe(true)
  const saving = p.confirmEnd()
  p.confirmEnd()
  await saving
  expect(c.loadState().active).toBe(false)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})

it('cancels end confirmation and leaves the workout open', async () => {
  const { p, c, router } = setup()
  await openEndConfirmation(p)
  p.cancelClose()
  await p.confirmEnd()
  expect(p.closeMode).toBe('')
  expect(c.loadState().active).toBe(true)
  expect(router.replace).not.toHaveBeenCalled()
})

it('returns to the completed workout choices on cancel and can continue training', async () => {
  const { p, c, router } = setup()
  p.effortEntryOn = true
  p.effortEntryText = '记录 RPE'
  p.checkCompletion(3, 3)
  expect(p.closeMode).toBe('complete')
  await vi.advanceTimersByTimeAsync(400)
  await openEndConfirmation(p)
  expect(p.closeMode).toBe('end')
  p.cancelClose()
  expect(p.closeMode).toBe('complete')
  expect(p.effortEntryOn).toBe(true)
  expect(p.effortEntryText).toBe('记录 RPE')
  await vi.advanceTimersByTimeAsync(400)
  p.cancelClose()
  expect(p.closeMode).toBe('')
  expect(c.loadState().completionAcknowledged).toBe(true)
  expect(router.replace).not.toHaveBeenCalled()
})

it('persists the final crown value before freezing the close intent', async () => {
  const { p, c, router, storage } = setup({ protocolVersion: 4 })
  const writes = vi.spyOn(storage, 'set')
  p.pageIndex = 1
  p.editReps()
  p.onRotation({ delta: 1 })
  p.onRotation({ delta: 1 })
  p.openFinish()
  await openEndConfirmation(p)
  expect(c.loadState().workout.rows[0][0].r).toBe(10)
  await p.confirmEnd()
  const frozen = writes.mock.calls.find(([item]) => item.key === 'session_state' && item.value.closeIntent)
  expect(frozen?.[0].value.workout.rows[0][0].r).toBe('12')
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})

it('saves the final crown value and closes while its transport callback is pending', async () => {
  const sent = []
  let finishSendingValue
  const connection = {
    send({ data, success }) {
      sent.push(data)
      if (data.t === 'reps') finishSendingValue = vi.fn(success)
      else success()
    },
    getReadyState({ success }) { success({ status: 1 }) },
  }
  const { p, c, router, storage } = setup({ protocolVersion: 4, connection })
  connection.onOpen()
  connection.onMessage({ data: { t: 'STATE_QUERY', protocolVersion: 4, requestId: 'before-close' } })
  await vi.advanceTimersByTimeAsync(20)
  expect(sent.find(message => message.requestId === 'before-close')).toMatchObject({ active: true })

  const writes = vi.spyOn(storage, 'set')
  p.pageIndex = 1
  p.editReps()
  p.onRotation({ delta: 1 })
  p.openFinish()
  await openEndConfirmation(p)
  await p.confirmEnd()

  expect(sent.filter(message => message.t === 'reps')).toEqual([expect.objectContaining({ reps: '11' })])
  expect(finishSendingValue).toBeDefined()
  expect(finishSendingValue).not.toHaveBeenCalled()
  const frozen = writes.mock.calls.find(([item]) => item.key === 'session_state' && item.value.closeIntent)
  expect(frozen?.[0].value.workout.rows[0][0].r).toBe('11')
  expect(c.loadState().active).toBe(false)
  expect(c.readStored('phone_terminal_v4')).toMatchObject({ sid: 'finish', disposition: 'saved' })
  expect(c.readStored('summary_last').sid).toBe('finish')
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
  finishSendingValue()
})

it('confirmed finish waits behind an already committing group', async () => {
  const { p, c, router, storage } = setup(), write = storage.set
  let release
  storage.set = item => { if (item.key === 'session_state' && !release) release = () => write(item); else write(item) }
  const group = p.onComplete()
  expect(p.localCommitPending).toBe(true)
  await openEndConfirmation(p)
  const saving = p.confirmEnd()
  expect(p.closeSaving).toBe(true)
  release(); await group; await saving
  expect(c.loadState().active).toBe(false)
  expect(c.journalEntry('finish').closeEvent.completedSets).toHaveLength(1)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})
it('submits the V4 close with a set callback outstanding and saves locally if the close fails', async () => {
  const sent = []
  let finishSendingSet
  const connection = {
    send({ data, success, fail }) {
      sent.push(data)
      if (data.t === 'set' && data.phoneLed) finishSendingSet = vi.fn(success)
      else if (data.t === 'session_close') fail(Error('native send unavailable'))
      else success()
    },
    getReadyState({ success }) { success({ status: 1 }) },
  }
  const { p, c, router } = setup({ protocolVersion: 4, connection })
  connection.onOpen()
  connection.onMessage({ data: { t: 'STATE_QUERY', protocolVersion: 4, requestId: 'before-close' } })
  await vi.advanceTimersByTimeAsync(20)
  await p.onComplete()
  expect(finishSendingSet).toBeDefined()

  await vi.advanceTimersByTimeAsync(1001)
  await openEndConfirmation(p)
  expect(p.closeMode).toBe('end')
  await p.confirmEnd()
  expect(finishSendingSet).not.toHaveBeenCalled()
  expect(sent.filter(message => message.t === 'session_close')).toEqual([
    expect.objectContaining({ phoneLed: true, protocolVersion: 4, sid: 'finish', disposition: 'saved' }),
  ])
  expect(c.loadState().active).toBe(false)
  expect(c.readStored('summary_last')).toMatchObject({ sid: 'finish', sets: 1 })
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })

  connection.onClose()
  connection.onOpen()
  connection.onMessage({ data: { t: 'STATE_QUERY', protocolVersion: 4, requestId: 'after-close' } })
  await vi.advanceTimersByTimeAsync(100)
  expect(sent.find(message => message.requestId === 'after-close')).toMatchObject({
    t: 'STATE_SNAPSHOT', sid: 'finish', active: false, terminal: c.readStored('phone_terminal_v4'),
  })
  finishSendingSet()
  expect(sent.filter(message => message.t === 'session_close')).toHaveLength(1)
})
it('saves effort locally and closes the draft when a V4 send fails', async () => {
  const sent = []
  const connection = {
    send({ data, success, fail }) {
      sent.push(data)
      if (data.t === 'effort') fail(Error('native send unavailable'))
      else success()
    },
    getReadyState({ success }) { success({ status: 1 }) },
  }
  const { p, c } = setup({ protocolVersion: 4, connection })
  const state = c.loadState()
  state.effortScale = 'rpe'
  c.save(state)
  p.stateOf(state)
  connection.onOpen()
  connection.onMessage({ data: { t: 'STATE_QUERY', protocolVersion: 4, requestId: 'before-effort' } })
  await vi.advanceTimersByTimeAsync(20)

  p.openEffort(false)
  expect(p.effortOn).toBe(true)
  p.effortDraft = 8
  await p.confirmEffort()
  expect(sent.filter(message => message.t === 'effort')).toEqual([
    expect.objectContaining({ protocolVersion: 4, sid: 'finish', scale: 'rpe', value: 8 }),
  ])
  expect(c.loadState().workout.rows[0][0].rpe).toBe(8)
  expect(p.effortOn).toBe(false)
})
it('a transport failure cannot strand a workout page after the local close was already saved', async () => {
  const { p, c, router } = setup()
  c.sendEvent.mockImplementation(() => { throw Error('native send unavailable') })
  c.replayPendingEvents = vi.fn(() => { throw Error('native send unavailable') })
  await p.saveEnd()
  expect(c.loadState().active).toBe(false)
  expect(c.journalEntry('finish').closeEvent.disposition).toBe('saved')
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
  await p.confirmEnd()
  expect(c.loadState().active).toBe(false)
  expect(c.journalEntry('finish').closeEvent).toEqual(frozen.close.closeEvent)
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
  expect(c.journalEntry('finish').closeEvent).toEqual(closeEvent)
})
it.each(['tombstone', 'journal', 'summary'])('does not treat unrelated %s evidence as a recovered successful save', async missing => {
  const { p, c, router, storage } = setup(), write = storage.set
  storage.set = item => item.key === 'summary_last' ? item.fail() : write(item)
  await p.saveEnd(); storage.set = write
  await c.recoverLocalClose()
  if (missing === 'tombstone') c.writeStored('closed_sessions', [])
  if (missing === 'summary') c.writeStored('summary_last', { sid: 'another' })
  if (missing === 'journal') {
    const journal = c.readStored('watch_close_journal_v1'); journal.entries.finish.closeEvent.eventId = 'another'
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
  expect(c.journalEntry('finish').closeEvent).toEqual(frozen.close.closeEvent)
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
it('can abandon a workout after cancelling the end confirmation', async () => {
  const { p, c, router } = setup()
  await openEndConfirmation(p)
  p.cancelClose()
  p.askAbandon()
  expect(p.closeMode).toBe('abandon')
  await p.confirmEnd()
  expect(c.loadState().active).toBe(true)
  await p.abandonEnd()
  expect(c.loadState().active).toBe(false)
  expect(c.journalEntry('finish').closeEvent.disposition).toBe('abandoned')
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Index' })
})
it('can finish after adjusting rest: no Promise is retained by the native reactive Page', async () => {
  const { p, c, router, data } = setup({ rest: true })
  expect(await p.nudgeRest(15)).toBe(true)
  expect(Object.values(data).some(v => Object.prototype.toString.call(v) === '[object Promise]')).toBe(false)
  await openEndConfirmation(p)
  await p.confirmEnd()
  expect(c.loadState().active).toBe(false)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Summary' })
})
it('ignores a stale confirmation tap after the Workout page is hidden', async () => {
  const { p, c, router } = setup()
  await openEndConfirmation(p)
  p.onHide()
  await p.confirmEnd()
  expect(c.loadState().active).toBe(true)
  expect(router.replace).not.toHaveBeenCalled()
})
it('a failed local save releases the lock, retains an error and lets the user abandon', async () => {
  const { p, c, router, storage } = setup(), write = storage.set
  storage.set = item => item.key === 'session_state' ? item.fail() : write(item)
  await openEndConfirmation(p)
  await p.confirmEnd()
  expect(c.loadState().active).toBe(true); expect(p.closeSaving).toBe(false)
  expect(p.closeError).toContain('未结束')
  p.tickClock(true); expect(p.closeError).toContain('未结束')
  storage.set = write
  p.askAbandon(); await p.abandonEnd()
  expect(c.loadState().active).toBe(false)
  expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Index' })
})
