// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEdit, applyRest, restOf, applyFocus } from '../../../watch-app/src/lib/protocol.js'
import { loadWatchModule, watchPersistence, watchInteractionDeps } from './watch-test-harness.js'
import { effortScaleOf, effortValueOf, effortKindOf, stepEffortValue, effortMeaning, effortSummaryText, formatEffort } from '../../../watch-app/src/lib/effort-scale.js'

// Execute the shipped watch JS and page scripts with only the device APIs replaced.
const source = path => readFileSync(new URL('../../../watch-app/src/' + path, import.meta.url), 'utf8')
const imports = /^import[\s\S]*?from ['"][^'"]+['"]\r?$/gm
function transport(connection, extra = {}, shared = {}) {
  const { disk, ctx } = watchPersistence(new Map(), shared)
  Object.assign(ctx, {
    interconnect: { instance: () => connection },
    loadState: extra.loadState || (() => ({})), save: extra.save || (() => {}),
    closeSession: extra.closeSession || (() => {}),
    buildSessionSummary: extra.buildSessionSummary || (() => ({ sets: [] })),
    summaryEventOf: extra.summaryEventOf || (() => ({})),
    retryStorage() {}, WATCH_VERSION: 'test-watch', console, Date,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, ...extra,
  })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', ctx, ['pendingSummaries', 'pendingEntry', 'journalEntry', 'prepareClose', 'releaseCandidate', 'markPhase', 'markDelivered'])
  // rpc.js is loaded last so its own handlers win; it needs the session/dep surface above.
  loadWatchModule('rpc', ctx, ['startServer', 'sendControl', 'sendEvent', 'pendingCount', 'persistenceStatus', 'replayPendingEvents'])
  const { startServer, sendControl, sendEvent, pendingCount, persistenceStatus, replayPendingEvents } = ctx
  return { startServer, sendControl, sendEvent, pendingCount, persistenceStatus, replayPendingEvents, disk, sent: connection.sent }
}
function connection() {
  const sent = []
  return { sent, send({ data, success }) { sent.push(data); success() },
    getReadyState({ success }) { success({ status: 1 }) } }
}
function page(path, deps) {
  const script = source(path).match(/<script>([\s\S]*?)<\/script>/)[1]
  const context = { ...watchInteractionDeps, replayPendingEvents() {}, console, WATCH_VERSION: 'test-watch', applyEdit, applyRest, restOf, applyFocus, persistenceStatus: () => ({}), storageStatus: () => ({}), synchronizationStatus: () => ({}),
    effortScaleOf, effortValueOf, effortKindOf, stepEffortValue, effortMeaning, effortSummaryText, formatEffort,
    storage: { getSync: () => null, set() {} }, replacePlan() {}, ...deps }
  runInNewContext(script.replace(imports, '').replace('export default', 'this.page ='), context)
  return { ...context.page, ...context.page.data }
}
function session() {
  const { disk, ctx } = watchPersistence()
  Object.assign(ctx, { console, Date, applyEdit, applyRest })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', ctx, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
  loadWatchModule('session', ctx, ['loadState', 'startSession', 'save', 'replacePlan', 'applySync', 'nextUndone', 'nextUndoneFrom',
    'setRowValue', 'toggleSet', 'addSet', 'removeSet', 'addRestTime', 'calories', 'endSession', 'closeSession', 'buildSessionSummary', 'summaryEventOf'])
  return { ...ctx, disk, values: disk }
}
const plan = { t: 'plan', sid: 'today', planId: 'p1', workout: 'Leg day',
  exercises: [{ name: 'Squat', sets: 3, reps: '8', weight: '60' }] }
function training(sessions, rpc, extra = {}) {
  return page('Workout/index.ux', { ...sessions, ...rpc, router: { push: vi.fn() },
    startSessionHr() {}, stopSessionHr() {}, startHr() {}, stopHr() {}, restOver() {}, tick() {},
    setTimeout: () => 2, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, pendingCount: () => 0, isConnected: () => true, ...extra })
}
// Compatibility cases, not a claim that any particular one is the device's format.
const envelopes = [
  ['object', msg => msg],
  ['JSON', msg => JSON.stringify(msg)],
  ['data JSON', msg => ({ data: JSON.stringify(msg) })],
  ['data object', msg => ({ data: msg })],
  ['nested data JSON', msg => ({ data: { data: JSON.stringify(msg) } })],
  ['msg JSON', msg => ({ data: { msg: JSON.stringify(msg) } })],
  ['JSON msg object', msg => ({ data: JSON.stringify({ msg }) })],
  ['JSON data JSON', msg => ({ data: JSON.stringify({ data: JSON.stringify(msg) }) })],
  ['double JSON', msg => ({ data: JSON.stringify(JSON.stringify(msg)) })],
  ['BOM JSON', msg => ({ data: '\uFEFF' + JSON.stringify(msg) })],
]

describe('watch completed sets and rest clock', () => {
  afterEach(() => vi.useRealTimers())

  function resting() {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
    const sessions = session(), sendControl = vi.fn(), sendEvent = vi.fn()
    const state = sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    state.restUntil = Date.now() + 60000
    sessions.save(state)
    const brightness = { setKeepScreenOn: vi.fn() }, restOver = vi.fn()
    const workout = training(sessions, { startServer() {}, sendControl, sendEvent }, {
      Date, setTimeout, clearTimeout, setInterval, clearInterval, brightness, restOver,
      router: { push: vi.fn(), replace: vi.fn() },
    })
    workout.onInit()
    workout.onReady()
    const writes = vi.spyOn(sessions.storage, 'set')
    return { sessions, workout, sendControl, sendEvent, brightness, restOver, writes }
  }

  it('persists a second crown input arriving during a slow write before pause can succeed', async () => {
    const {workout,sessions,sendEvent}=resting(), original=sessions.storage.set, delayed=[]
    const initial=workout.state.restUntil
    sessions.storage.set=item=> item.key==='session_state' ? delayed.push(item) : original(item)
    await workout.onRotation({delta:1,state:2})
    const flush=workout.flushRestNudge()
    expect(delayed).toHaveLength(1); expect(sendEvent).not.toHaveBeenCalled()
    await workout.onRotation({delta:1,state:2})
    const pause=workout.onPause()
    original(delayed[0]); for(let i=0;i<20;i++) await Promise.resolve()
    expect(delayed).toHaveLength(2); expect(workout.state.pausedAt).toBeFalsy()
    original(delayed[1]); for(let i=0;i<20;i++) await Promise.resolve()
    expect(delayed).toHaveLength(3)
    original(delayed[2]); await flush; await pause
    expect(sessions.loadState().pausedAt).toBeTruthy()
    expect(sendEvent.mock.calls.filter(([m])=>m.t==='rest').slice(0,2).map(([m])=>m.endsAt)).toEqual([initial+5000,initial+10000])
  })

  it('allows deliberate undo after completion protection expires', async () => {
    const { workout, sessions, sendEvent } = resting()
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001)
    workout.state.workout.rows[0] = [workout.state.workout.rows[0][0]]
    workout.state.workout.exercises[0].sets = 1
    sessions.save(workout.state)
    await workout.onCurrentSetAction()
    vi.advanceTimersByTime(1001)
    workout.cancelClose()
    await workout.onCurrentSetAction()
    expect(workout.rowDone).toBe(false)
    expect(sendEvent.mock.calls.filter(([m]) => m.t === 'set')).toHaveLength(1)
    expect(sendEvent.mock.calls.filter(([m]) => m.t === 'unset')).toHaveLength(1)
    const beforePaused = sendEvent.mock.calls.length
    workout.paused = true
    await workout.onCurrentSetAction()
    expect(sendEvent.mock.calls).toHaveLength(beforePaused)
    expect(workout.rowDone).toBe(false)
    workout.paused = false
    vi.advanceTimersByTime(1001); await workout.onCurrentSetAction()
    expect(workout.rowDone).toBe(true)
    expect(sendEvent.mock.calls.filter(([m]) => m.t === 'set')).toHaveLength(2)
  })

  it('updates a crown burst immediately and saves/sends only after rotation settles', async () => {
    const { workout, sessions, writes, sendEvent: sendControl } = resting()
    const initial = workout.state.restUntil
    for (let i = 0; i < 80; i++) await workout.onRotation({ delta: 1, state: 2 })
    expect(workout.state.restUntil).toBe(initial + 400000)
    expect(workout.restLabel).toBe('7:40')
    expect(writes).not.toHaveBeenCalled()
    expect(sendControl).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(writes.mock.calls.filter(([w]) => w.key === 'session_state')).toHaveLength(1)
    expect(sendControl).toHaveBeenCalledOnce()
    expect(sendControl.mock.calls[0][0]).toMatchObject({ t: 'rest', leftSec: 460 })
  })

  it('keeps rest rendering at a display-sized cadence and batches a crown focus save', async () => {
    const { workout, writes } = resting()
    expect(workout.clockPeriod).toBe(500)
    writes.mockClear()
    await workout.stepSet(1)
    expect(writes).toHaveBeenCalledOnce()
  })

  it('prompts on the final set without closing, ignores trailing taps and continues once', async () => {
    const { workout, sessions, sendEvent } = resting()
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001)
    workout.state.workout.rows[0] = [workout.state.workout.rows[0][0]]
    workout.state.workout.exercises[0].sets = 1
    sessions.save(workout.state)
    await workout.onComplete()
    expect(workout.closeMode).toBe('complete')
    expect(sessions.loadState().active).toBe(true)
    await workout.saveEnd(); workout.cancelClose(); await workout.onCurrentSetAction()
    expect(workout.closeMode).toBe('complete')
    expect(workout.rowDone).toBe(true)
    expect(sendEvent.mock.calls.some(([m]) => m.t === 'session_close')).toBe(false)
    vi.advanceTimersByTime(1001)
    workout.cancelClose()
    workout.refresh(); workout.onShow()
    expect(workout.closeMode).toBe('')
    const restored = training(sessions, { startServer() {}, sendEvent })
    restored.onInit()
    expect(restored.closeMode).toBe('')
    await workout.onMenuAddSet()
    expect(workout.allFinished).toBe(false)
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001); await workout.onComplete()
    expect(workout.closeMode).toBe('complete')
    vi.advanceTimersByTime(1001)
    await workout.saveEnd()
    expect(sessions.loadState().active).toBe(false)
    expect(sendEvent.mock.calls.findLast(([m]) => m.t === 'session_close')[0]).toMatchObject({ t: 'session_close', disposition: 'saved' })
  })

  it('prompts once for restored or synced completion and re-arms after undo', async () => {
    const { workout, sessions } = resting()
    workout.state.workout.rows[0].forEach(r => { r.done = true })
    sessions.save(workout.state)
    workout.visible = false; workout.refresh()
    expect(workout.closeMode).toBe('')
    workout.onShow()
    expect(workout.closeMode).toBe('complete')
    vi.advanceTimersByTime(1001); workout.cancelClose()
    const snapshot = { ...plan, rows: workout.state.workout.rows }
    workout.onSyncUpdate(snapshot); workout.tickClock()
    expect(workout.closeMode).toBe('')
    workout.onRemoteUnset({ sid: plan.sid, ex: 0, set: 1 })
    workout.onRemoteSet({ sid: plan.sid, ex: 0, set: 1 })
    expect(workout.closeMode).toBe('complete')
    workout.state.workout.rows = [[]]; workout.refresh()
    expect(workout.allFinished).toBe(false)
    expect(workout.closeMode).toBe('')
  })

  it('shows the completion choice for a real phone snapshot and isolates crown/swipes', async () => {
    const sessions = session(), c = connection(), rpc = transport(c, sessions)
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const router = { push: vi.fn(), replace: vi.fn() }, workout = training(sessions, rpc, { router })
    workout.onInit()
    c.onMessage({ data: { ...plan, t: 'sync', rows: [[0, 1, 2].map(() => ({ done: true, w: '60', r: '8' }))] } })
    expect(workout.closeMode).toBe('complete')
    const position = [workout.state.exIdx, workout.state.setIdx]
    await workout.onRotation({ delta: 1, state: 1 })
    workout.touchStart({ touches: [{ clientX: 50, clientY: 180 }] })
    workout.touchEnd({ changedTouches: [{ clientX: 200, clientY: 180 }] })
    expect([workout.state.exIdx, workout.state.setIdx]).toEqual(position)
    expect(router.push).not.toHaveBeenCalled()
    expect(sessions.loadState().active).toBe(true)
    expect(source('Workout/index.ux')).toContain('if="{{ closeMode === \'complete\' && !effortOn }}"')
    expect(source('Workout/index.ux')).toContain('value="继续训练" onclick="cancelClose"')
  })

  it('does not complete the next set when a second click arrives during rest', async () => {
    const { workout, sendEvent } = resting()
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001)
    await workout.onCurrentSetAction()
    expect(workout.state.setIdx).toBe(1)
    await workout.onCurrentSetAction()
    expect(workout.state.workout.rows[0].filter(row => row.done)).toHaveLength(1)
    expect(sendEvent.mock.calls.filter(([m]) => m.t === 'set')).toHaveLength(1)
  })

  it('shows the actual upcoming set and restores completed context after reopening', async () => {
    const { workout, sessions } = resting()
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001)
    workout.state.workout.rows[0][1].w = '65'
    workout.state.workout.rows[0][1].r = '6'
    sessions.save(workout.state)
    await workout.onCurrentSetAction()
    expect(workout.nextDetails).toBe('第 2 / 3 组 · 65kg × 6次')
    expect(workout.restExerciseName).toBe('Squat')
    expect(workout.nextLabel).toBe('下一组')
    const reopened = training(sessions, { startServer() {}, pendingCount: () => 0 })
    reopened.onInit()
    expect(reopened.restExerciseName).toBe(workout.restExerciseName)
    expect(reopened.nextDetails).toBe(workout.nextDetails)
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001)
    await workout.onCurrentSetAction()
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001)
    await workout.onCurrentSetAction()
    expect(workout.nextLabel).toBe('本次训练已完成')
  })

  it('names the upcoming exercise only when it changes', async () => {
    const { workout, sessions } = resting()
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001)
    workout.state.workout.exercises.push({ name: 'Row', sets: 1, reps: '10' })
    workout.state.workout.rows.push([{ w: '30', r: '10', done: false, at: 0 }])
    workout.state.workout.rows[0][0].done = true
    workout.state.workout.rows[0][1].done = true
    workout.state.setIdx = 2
    sessions.save(workout.state)
    workout.refresh()
    vi.advanceTimersByTime(1001); await workout.onCurrentSetAction()
    expect(workout.restExerciseName).toBe('Squat')
    expect(workout.nextLabel).toBe('下一动作 · Row')
    expect(workout.nextDetails).toBe('第 1 / 1 组 · 30kg × 10次')
  })

  it('updates local wall time across midnight even while elapsed time is paused', async () => {
    const { workout, sessions } = resting()
    vi.setSystemTime(new Date(2026, 9, 20, 23, 59, 30))
    workout.state.startedAt = Date.now() - 60000
    workout.state.segmentStartedAt = workout.state.startedAt
    workout.state.restUntil = 0
    sessions.save(workout.state)
    workout.refresh()
    expect(workout.clockLabel).toBe('23:59')
    expect(workout.elapsedLabel).toBe('1:00')
    await workout.onPause()
    vi.advanceTimersByTime(60000)
    expect(workout.clockLabel).toBe('00:00')
    expect(workout.elapsedLabel).toBe('1:00')
  })

  it('keeps rest on one page while allowing the exercise list and crown time adjustment', async () => {
    const { workout } = resting()
    workout.openExercises = vi.fn()
    for (const [dx, dy] of [[0, -100], [0, 100], [-100, 0]]) {
      workout.touchStart({ touches: [{ clientX: 180, clientY: 180 }] })
      workout.touchEnd({ changedTouches: [{ clientX: 180 + dx, clientY: 180 + dy }] })
      expect(workout.pageIndex).toBe(0)
    }
    workout.openActions()
    expect(workout.pageIndex).toBe(0)
    workout.pageIndex = 1
    workout.refresh()
    expect(workout.pageIndex).toBe(0)
    workout.touchStart({ touches: [{ clientX: 180, clientY: 180 }] })
    workout.touchEnd({ changedTouches: [{ clientX: 280, clientY: 180 }] })
    expect(workout.openExercises).toHaveBeenCalledOnce()
    const before = workout.state.restUntil
    await workout.onRotation({ delta: 1, state: 2 })
    expect(workout.state.restUntil).toBe(before + 5000)
  })

  it('does not route crown events to hidden, operation or paused training pages', async () => {
    const { workout } = resting()
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001)
    workout.onHide()
    await workout.onRotation({ delta: 1, state: 2 })
    expect(workout.state.setIdx).toBe(0)
    workout.onShow()
    workout.openActions()
    await workout.onRotation({ delta: 1, state: 2 })
    expect(workout.state.setIdx).toBe(0)
    workout.pageIndex = 0
    await workout.onPause()
    await workout.onRotation({ delta: 1, state: 2 })
    expect(workout.state.setIdx).toBe(0)
  })

  it.each(['saved', 'abandoned'])('closes from the action list once with %s semantics', async disposition => {
    const { workout, sessions } = resting()
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001)
    await workout.onCurrentSetAction()
    workout.onHide()
    const sendEvent = vi.fn(), router = { replace: vi.fn() }
    const list = page('ExerciseList/index.ux', { ...sessions, sendEvent, router })
    list.onInit()
    const closing = list.closeWorkout(disposition)
    list.closeWorkout(disposition)
    await closing
    expect(sessions.loadState().active).toBe(false)
    expect(sendEvent.mock.calls.filter(([m]) => m.t === 'session_close')).toHaveLength(1)
    expect(sendEvent.mock.calls[0][0]).toMatchObject({ t: 'session_close', sid: plan.sid, disposition })
    if (disposition === 'saved') {
      expect(sendEvent.mock.calls[0][0].completedSets).toHaveLength(1)
      expect(sessions.storage.getSync({ key: 'summary_last' }).sets).toBe(1)
      expect(router.replace.mock.calls[0][0].uri).toBe('/Summary')
    } else {
      expect(sendEvent.mock.calls[0][0].completedSets).toBeUndefined()
      expect(sessions.storage.getSync({ key: 'summary_last' })).toBeNull()
      expect(router.replace.mock.calls[0][0].uri).toBe('/Index')
    }
  })

  it('keeps an in-progress crown edit across a phone snapshot and rest echo', async () => {
    const { workout, sessions, sendEvent: sendControl } = resting()
    await workout.onRotation({ delta: 1, state: 2 })
    workout.onSyncUpdate({ ...plan, restUntil: Date.now() + 60000 })
    workout.onRemoteRest({ sid: plan.sid, leftSec: 60, seq: 1 })
    expect(workout.restLabel).toBe('1:05')
    await vi.advanceTimersByTimeAsync(300)
    expect(sessions.loadState().restUntil).toBe(workout.state.restUntil)
    expect(sendControl.mock.calls[0][0].leftSec).toBe(65)
  })

  it('sends zero when crown adjustment ends the rest and does not resurrect it', async () => {
    const { workout, sendEvent: sendControl, brightness } = resting()
    for (let i = 0; i < 12; i++) await workout.onRotation({ delta: -1, state: 2 })
    expect(workout.state.restUntil).toBe(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(sendControl).toHaveBeenCalledOnce()
    expect(sendControl.mock.calls[0][0]).toMatchObject({ t: 'rest', leftSec: 0 })
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: false }))
  })

  it('clamps long crown rotations to the phone maximum of fifteen minutes', async () => {
    const { workout, sendEvent: sendControl } = resting()
    for (let i = 0; i < 500; i++) await workout.onRotation({ delta: 1, state: 2 })
    expect(workout.restLabel).toBe('15:00')
    await vi.advanceTimersByTimeAsync(300)
    expect(sendControl.mock.calls[0][0].leftSec).toBe(900)
  })

  it('waits until the display API is ready before acquiring the screen lock', async () => {
    const sessions = session(), brightness = { setKeepScreenOn: vi.fn() }
    const state = sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    state.restUntil = Date.now() + 10000
    sessions.save(state)
    const workout = training(sessions, { startServer() {} }, { brightness })
    workout.onInit()
    expect(brightness.setKeepScreenOn).not.toHaveBeenCalled()
    workout.onReady()
    expect(brightness.setKeepScreenOn).toHaveBeenCalledWith(expect.objectContaining({ keepScreenOn: true }))
  })

  it('cancels a queued crown change when skipping and starting a different rest', async () => {
    const { workout, sendEvent: sendControl } = resting()
    await workout.onRotation({ delta: 1, state: 2 })
    await workout.onSkipRest()
    workout.onRemoteRest({ sid: plan.sid, leftSec: 20, seq: Date.now() + 1 })
    vi.advanceTimersByTime(1000)
    expect(sendControl.mock.calls.map(([m]) => m.leftSec)).toEqual([0])
    expect(workout.restLabel).toBe('0:19')
  })

  it('reconciles elapsed sleep by deadline and releases the screen on natural expiration', async () => {
    const { workout, brightness, restOver } = resting()
    vi.setSystemTime(Date.now() + 17250)
    workout.onShow()
    expect(workout.restLabel).toBe('0:43')
    vi.setSystemTime(Date.now() + 50000)
    workout.onShow()
    expect(workout.state.restUntil).toBe(0)
    expect(workout.isRest).toBe(false)
    expect(restOver).toHaveBeenCalledOnce()
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: false }))
    workout.tickClock()
    expect(restOver).toHaveBeenCalledOnce()
  })

  it('flushes crown edits on hide and restores the rest screen lock on show', async () => {
    const { workout, sendEvent: sendControl, brightness } = resting()
    await workout.onRotation({ delta: 1, state: 2 })
    await workout.onHide()
    expect(sendControl).toHaveBeenCalledOnce()
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: false }))
    workout.onShow()
    expect(workout.restLabel).toBe('1:05')
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: true }))
    await vi.advanceTimersByTimeAsync(300)
    expect(sendControl).toHaveBeenCalledOnce()
  })

  it('acquires/relinquishes the screen lock for authoritative rest snapshots', async () => {
    const { workout, brightness } = resting()
    vi.advanceTimersByTime(1001); await workout.onSkipRest(); vi.advanceTimersByTime(1001)
    workout.onSyncUpdate({ ...plan, rest: { leftSec: 10, totalSec: 10, seq: Date.now() + 1 } })
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: true }))
    vi.advanceTimersByTime(10000)
    expect(workout.state.restUntil).toBe(0)
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: false }))
  })

  it('drops delayed crown work when a session ends', async () => {
    const { workout, sendControl, sessions, brightness } = resting()
    await workout.onRotation({ delta: 1, state: 2 })
    await workout.onEnd()
    vi.advanceTimersByTime(1000)
    expect(sendControl).not.toHaveBeenCalled()
    expect(sessions.loadState().active).toBe(false)
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: false }))
  })
})

describe('watch direct workout entry', () => {
  function home(sessions, params) {
    const router = { replace: vi.fn() }
    const index = page('Index/index.ux', { ...sessions, router, startServer() {}, sendEvent() {} })
    index.onInit(params)
    return { index, router }
  }

  it('opens an already active session on launch without a continue tap', async () => {
    const sessions = session()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const { index, router } = home(sessions)
    index.onShow()
    index.onReady()
    expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Workout' })
  })

  it('navigates once when native ready fires before show', async () => {
    const sessions = session()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const { index, router } = home(sessions)
    index.onReady()
    index.onShow()
    expect(router.replace).toHaveBeenCalledOnce()
  })

  it('persists a phone plan and opens it once when the page is ready', async () => {
    const sessions = session(), { index, router } = home(sessions)
    index.onPlan(plan)
    expect(sessions.loadState()).toMatchObject({ active: true, sid: plan.sid })
    expect(router.replace).not.toHaveBeenCalled()
    index.onReady()
    index.onSync({ ...plan, t: 'sync', rows: [[{ w: '75', r: '6', done: true }]] })
    expect(sessions.loadState().workout.rows[0][0]).toMatchObject({ w: '75', done: true })
    expect(router.replace).toHaveBeenCalledOnce()
  })

  it('opens a sync-only phone session without resetting its rows', async () => {
    const sessions = session(), { index, router } = home(sessions)
    index.onReady()
    index.onSync({ ...plan, t: 'sync', rows: [[{ w: '75', r: '6', done: true }]] })
    expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Workout' })
    expect(sessions.loadState().workout.rows[0][0].done).toBe(true)
  })

  it('preserves conflict confirmation and rejects a different active session', async () => {
    const sessions = session()
    sessions.startSession({ sid: 'local', exercises: plan.exercises })
    const { index, router } = home(sessions, { conflict: JSON.stringify(plan) })
    index.onReady()
    expect(index.onPlan(plan).status).toBe('conflict')
    expect(index.onSync({ ...plan, t: 'sync' }).status).toBe('conflict')
    expect(sessions.loadState().sid).toBe('local')
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('keeps cached plans idle and does not navigate a hidden home page', async () => {
    const sessions = session(), { index, router } = home(sessions)
    index.onReady()
    index.onCatalog({ plans: [{ id: 'p', name: 'Plan', exercises: plan.exercises }] })
    expect(sessions.loadState().active).toBe(false)
    index.onHide()
    index.onPlan(plan)
    expect(router.replace).not.toHaveBeenCalled()
  })
})

describe('watch business message boundary', () => {
  it('selects an explicit action-list row using the documented bound item parameter', async () => {
    const sessions = session(), back = vi.fn()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const list = page('ExerciseList/index.ux', { ...sessions, sendEvent() {}, router: { back } })
    list.onInit(); list.toggleEx(0)
    expect(list.expanded).toBe(0)
    await list.pickRow({ exIdx: 0, setIdx: 2 })
    expect(sessions.loadState().setIdx).toBe(2)
    expect(back).toHaveBeenCalledOnce()
  })
  it('opens the action-list end panel with the second right swipe and exposes explicit end actions', async () => {
    const sessions = session(), sendEvent = vi.fn(), replace = vi.fn(), back = vi.fn()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const list = page('ExerciseList/index.ux', { ...sessions, sendEvent, router: { back, replace } })
    list.onInit()
    list.touchStart({ touches: [{ clientX: 80, clientY: 180 }] })
    list.touchEnd({ changedTouches: [{ clientX: 170, clientY: 182 }] })
    expect(list.endOn).toBe(true)
    // The same swipe may emit a system back and a click on the newly mounted button.
    list.onBackPress()
    list.backToExercises()
    expect(list.endOn).toBe(true)
    list.trailingTapBlockedUntil = 0   // a fresh gesture clears the trailing protection
    list.backToExercises()
    expect(list.endOn).toBe(false)
    const ux = source('ExerciseList/index.ux')
    expect(ux.match(/value="保存结束"/g)).toHaveLength(2)
    expect(ux.match(/value="放弃训练"/g)).toHaveLength(2)
    expect(ux).toContain('onclick="backToExercises"><image class="back-icon" src="/common/icons/back.svg" /><text class="back-label">返回动作</text>')
    expect(ux).toContain('onclick="onExit"><image class="back-icon" src="/common/icons/back.svg" /><text class="back-label">返回训练</text>')
    expect(ux).toContain('ontouchend="touchEnd"')
    expect(ux).toContain('<div class="page" id="page" touch-focusable="true"')
    expect(ux).toContain('<list class="scroll" id="exercises" touch-focusable="true" ontouchstart')
    expect(ux).toContain("r.done ? '完' : r.no")
    list.touchStart({ touches: [{ clientX: 80, clientY: 180 }] })
    list.touchMove({ touches: [{ clientX: 135, clientY: 182 }] })
    expect(list.endOn).toBe(true)
    list.touchCancel()
    list.touchEnd({ touches: [] })
    expect(list.endOn).toBe(true)
    list.touchStart({ touches: [{ clientX: 80, clientY: 180 }] })
    list.touchEnd({ changedTouches: [{ clientX: 170, clientY: 182 }] })
    expect(JSON.parse(source('manifest.json')).router.pages.ExerciseList.followHand).toBe('disable')
    list.saveWorkout()
    list.abandonWorkout()
    expect(sendEvent).not.toHaveBeenCalled()
    list.trailingTapBlockedUntil = 0   // a fresh gesture clears the trailing protection
    list.saveWorkout()
    expect(sendEvent).not.toHaveBeenCalled()
    expect(back).toHaveBeenCalledOnce()
    expect(sessions.runtime().finishRequest).toEqual({ sid: plan.sid })
    expect(replace).not.toHaveBeenCalled()
  })

  it('keeps the end panel through a long swipe and accepts a later deliberate return', async () => {
    const sessions = session(), back = vi.fn()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    let now = Date.now()
    const list = page('ExerciseList/index.ux', { ...sessions, Date: { now: () => now }, router: { back } })
    list.onInit()
    list.touchStart({ touches: [{ clientX: 60, clientY: 180 }] })
    list.touchMove({ touches: [{ clientX: 140, clientY: 181 }] })
    now += 1000
    list.touchMove({ touches: [{ clientX: 210, clientY: 182 }] })
    list.onBackPress()
    expect(list.endOn).toBe(true)
    list.touchEnd({ touches: [] })
    list.backToExercises()
    expect(list.endOn).toBe(true)
    now += 500
    list.onBackPress()
    expect(list.endOn).toBe(false)
    expect(back).not.toHaveBeenCalled()
    list.touchStart({ touches: [{ clientX: 60, clientY: 180 }] })
    list.touchEnd({ changedTouches: [{ clientX: 140, clientY: 180 }] })
    now += 500
    list.touchStart({ touches: [{ clientX: 200, clientY: 180 }] })
    list.touchEnd({ changedTouches: [{ clientX: 100, clientY: 180 }] })
    expect(list.endOn).toBe(false)
  })

  it('crosses the action boundary with crown or button navigation and syncs the phone focus', async () => {
    const sessions = session(), sendEvent = vi.fn()
    const state = sessions.startSession({ name: 'two', sid: 'two', exercises: [
      { name: 'Squat', sets: 1, reps: '8', weight: '60' },
      { name: 'Row', sets: 2, reps: '10', weight: '30' },
    ] })
    const workout = training(sessions, { startServer() {}, sendEvent, pendingCount: () => 0, isConnected: () => true })
    workout.onInit()
    await workout.stepSet(1)
    expect(workout.state.exIdx).toBe(1)
    expect(workout.state.setIdx).toBe(0)
    expect(sendEvent.mock.calls.at(-1)[0]).toMatchObject({ t: 'focus', ex: 1, set: 1 })
    await workout.stepSet(-1)
    expect(workout.state.exIdx).toBe(0)
    expect(workout.state.setIdx).toBe(0)
    expect(sendEvent.mock.calls.at(-1)[0]).toMatchObject({ t: 'focus', ex: 0, set: 1 })
  })

  it('keeps the main training surface focused and moves metrics to operations', async () => {
    const ux = source('Workout/index.ux')
    // The compact main page keeps the two big fields label-free; the operation page is the
    // one that spells the prescription out (weight/reps labels live there).
    const mainPage = ux.slice(ux.indexOf('<div class="screen"'), ux.indexOf('<div class="screen operation-screen"'))
    expect(mainPage).not.toContain('>重量<')
    expect(mainPage).not.toContain('>次数<')
    expect(ux).toContain('>重量<')
    expect(ux).toContain('>次数<')
    expect(ux).toContain('onclick="pickSetDot(item)"')
    expect(ux).toContain('class="set-hit"')
    expect(ux).toContain('class="complete')
    expect(mainPage).not.toContain('<list ')
    expect(mainPage).toContain('<div class="training-content">')
    expect(ux).not.toContain('value="训练动作"')
    expect(ux).toContain('onclick="openExercises"')
    expect(ux).toContain('{{ setProgressLabel }}')
    const trainingPage = ux.slice(ux.indexOf('<div class="screen"'), ux.indexOf('<div class="screen operation-screen"'))
    const operationPage = ux.slice(ux.indexOf('<div class="screen operation-screen"'))
    expect(trainingPage).not.toContain('{{ kcalLabel }} 千卡')
    expect(trainingPage).toContain('class="heart"') // V4 sampled HR in the top bar, not a metrics dashboard
    expect(trainingPage).not.toContain('估算')
    expect(operationPage).toContain('{{ clockLabel }}')
    expect(operationPage).toContain('class="elapsed-value"')
    expect(operationPage).toContain('{{ elapsedLabel }}')
    expect(operationPage).toContain('{{ volumeLabel }} {{ weightUnit }}')
    expect(operationPage).toContain('{{ kcalLabel }} 千卡')
    expect(operationPage).toContain('{{ hrLabel }}')
    expect(operationPage).not.toContain('估算')
    expect(ux).toContain('class="training-panel rest-panel"')
    // Compiled rest bounds are checked against the child heights by verify-layout.cjs.
    expect(ux).not.toContain('训练操作')
    expect(source('ExerciseList/index.ux')).not.toContain('value="训练动作"')
    expect(source('Index/index.ux')).toContain('justify-content: center')
  })
  it('finalizes on a delayed phone end, sends energy reliably and refuses stale plans for the closed session', async () => {
    const sessions = session(), c = connection(), rpc = transport(c, sessions)
    const state = sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    state.startedAt = Date.now() - 600000
    sessions.save(state)
    const replace = vi.fn(), workout = training(sessions, rpc, { router: { replace } })
    workout.onInit()
    workout.hrDirty = true
    c.onMessage({ data: { t: 'ended', sid: plan.sid, endedAt: Date.now() - 300000, reason: 'finished' } })
    // The close is committed through the durable journal before the session is cleared.
    await new Promise(r => setTimeout(r, 300))
    expect(sessions.loadState().active).toBe(false)
    expect(replace).toHaveBeenCalledWith({ uri: '/Index' })
    const summary = c.sent.find(m => m.t === 'summary')
    expect(summary.minutes).toBeCloseTo(5, 1)
    expect(summary.calories).toBeGreaterThan(0)
    c.onMessage({ data: plan })
    await new Promise(r => setTimeout(r, 300))
    expect(c.sent.at(-1)).toMatchObject({ t: 'plan_ack', status: 'closed' })
    expect(sessions.loadState().active).toBe(false)
    c.onClose(); c.onOpen()
    await new Promise(r => setTimeout(r, 300))
    expect(c.sent.filter(m => m.t === 'summary')).toHaveLength(2)
  })

  it('leaves another session active when an old end arrives', async () => {
    const sessions = session(), c = connection(), rpc = transport(c, sessions)
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    rpc.startServer({ onEnded: vi.fn() })
    c.onMessage({ data: { t: 'ended', sid: 'old', endedAt: Date.now() } })
    expect(sessions.loadState().active).toBe(true)
    expect(c.sent.some(m => m.t === 'summary')).toBe(false)
  })

  it('intercepts system back and gives the crown selected-field editing and rest adjustment', async () => {
    const sessions = session(), rpc = transport(connection())
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const requestFocus = vi.fn(), workout = training(sessions, rpc, { $element: () => ({ requestFocus }) })
    workout.$element = () => ({ requestFocus })
    workout.onInit(); workout.onReady()
    expect(requestFocus).toHaveBeenCalledWith(true)
    expect(JSON.parse(source('manifest.json')).router.pages.Workout.followHand).toBe('disable')
    expect(workout.onBackPress()).toBe(true)
    expect(workout.menuOn).toBe(false)
    await workout.onRotation({ delta: 1, state: 1 })
    expect(workout.state.setIdx).toBe(0) // no selected field: crown is inert
    workout.editReps(); await workout.onRotation({ delta: 1, state: 1 })
    expect(workout.state.workout.rows[0][0].r).toBe('9')
    workout.state.restUntil = Date.now() + 30000
    workout.refresh()
    const before = workout.state.restUntil
    await workout.onRotation({ delta: 1, state: 2 })
    expect(workout.state.restUntil).toBeGreaterThanOrEqual(before + 4000)
    const after = workout.state.restUntil
    await workout.onRotation({ delta: 1, state: 3 })
    expect(workout.state.restUntil).toBe(after)
  })

  it('lets the crown fine tune keypad values without typing', async () => {
    const sessions = session()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const keypad = page('Keypad/index.ux', { ...sessions, router: { back() {} } })
    keypad.onInit({ exIdx: 0, setIdx: 0, field: 'w' })
    keypad.onRotation({ delta: 1, state: 1 })
    keypad.commit()
    expect(sessions.loadState().workout.rows[0][0].w).toBe('60.5')
  })

  it.each([[-100, 1], [100, 0]])(
    'opens the horizontal panel for a BlueOS touches-only gesture (%s)', (dx, panel) => {
      const sessions = session(), rpc = transport(connection())
      sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
      const workout = training(sessions, rpc)
      workout.onInit()
      workout.touchStart({ touches: [{ clientX: 180, clientY: 160 }] })
      workout.touchMove?.({ touches: [{ clientX: 180 + dx, clientY: 165 }] })
      workout.touchEnd({ touches: [] })
      expect(workout.pageIndex).toBe(panel)
      if (dx > 0) expect(workout.menuOn).toBe(false)
      workout.refresh()
      expect(workout.pageIndex).toBe(panel)
      expect(source('Workout/index.ux')).toContain('ontouchmove="touchMove"')
      expect(source('Workout/index.ux')).toContain('ontouchcancel="touchCancel"')
    })

  it('locks a diagonal gesture to the first deliberate swipe axis', async () => {
    const sessions = session(), rpc = transport(connection()), router = { push: vi.fn() }
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const workout = training(sessions, rpc, { router })
    workout.onInit()
    workout.touchStart({ touches: [{ clientX: 100, clientY: 180 }] })
    workout.touchMove({ touches: [{ clientX: 130, clientY: 185 }] })
    workout.touchEnd({ changedTouches: [{ clientX: 180, clientY: 300 }] })
    expect(router.push).toHaveBeenCalledWith({ uri: '/ExerciseList' })
    expect(workout.pageIndex).toBe(0)
  })

  it('ignores taps and canceled gestures and keeps changedTouches compatibility', async () => {
    const sessions = session(), rpc = transport(connection())
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const workout = training(sessions, rpc)
    workout.onInit()
    workout.touchStart({ touches: [{ clientX: 180, clientY: 160 }] })
    workout.touchEnd({ touches: [] })
    expect(workout.menuOn).toBe(false)
    expect(workout.leaveChoice).toBe(false)
    workout.touchStart({ touches: [{ clientX: 180, clientY: 160 }] })
    workout.touchMove?.({ touches: [{ clientX: 60, clientY: 160 }] })
    workout.touchCancel?.()
    workout.touchEnd({ touches: [] })
    expect(workout.menuOn).toBe(false)
    workout.touchStart({ touches: [{ clientX: 180, clientY: 160 }] })
    workout.touchEnd({ changedTouches: [{ clientX: 60, clientY: 160 }] })
    expect(workout.pageIndex).toBe(1)
  })

  it('opens on the first set and preserves the cursor across repeated plan deliveries', async () => {
    const sessions = session(), c = connection(), rpc = transport(c, sessions)
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const workout = training(sessions, rpc)
    workout.onInit()
    expect(workout.groupLabel).toBe('第 1 / 3 组')
    c.onMessage({ data: plan })
    c.onMessage({ data: plan })
    expect(workout.groupLabel).toBe('第 1 / 3 组')
    await workout.onComplete()
    expect(workout.groupLabel).toBe('第 2 / 3 组')
    c.onMessage({ data: plan })
    expect(workout.groupLabel).toBe('第 2 / 3 组')
  })

  it.each([['w', 'weight', '72.5'], ['r', 'reps', '12']])(
    'hands a Keypad %s edit back to the connected Workout transport and preserves other updates', (field, type, value) => {
      const sessions = session(), c = connection()
      sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
      const rpc = transport(c, { loadState: sessions.loadState })
      const workout = training(sessions, rpc)
      workout.onInit()
      // Page bundles may have independent rpc modules; Keypad has no initialized connection.
      const keypad = page('Keypad/index.ux', { ...sessions, ...transport(c), router: { back: vi.fn() } })
      keypad.onInit({ exIdx: 0, setIdx: 0, field })
      const changed = sessions.loadState()
      sessions.setRowValue(changed, 0, 1, 'w', '90')
      for (const key of value) keypad.onKey(key)
      keypad.commit()
      workout.onShow()
      expect(sessions.loadState().workout.rows[0][1].w).toBe('90')
      expect(c.sent.find(m => m.t === type)).toMatchObject({ sid: plan.sid, ex: 0, set: 1, [type]: value })
      expect(field === 'w' ? workout.weightVal : workout.repsVal).toBe(value + (field === 'w' ? ' kg' : ' 次'))
    })

  it('keeps the shown value when Keypad is confirmed without typing', async () => {
    const sessions = session()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const keypad = page('Keypad/index.ux', { ...sessions, sendControl() {}, router: { back() {} } })
    keypad.onInit({ exIdx: 0, setIdx: 0, field: 'w' })
    keypad.commit()
    expect(sessions.loadState().workout.rows[0][0].w).toBe('60')
  })

  it('keeps a saved Keypad edit across a phone snapshot arriving before the page returns', async () => {
    const sessions = session(), c = connection(), rpc = transport(c, sessions)
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const workout = training(sessions, rpc)
    workout.onInit()
    const keypad = page('Keypad/index.ux', { ...sessions, router: { back() {} } })
    keypad.onInit({ exIdx: 0, setIdx: 0, field: 'w' })
    keypad.onKey('8'); keypad.onKey('0'); keypad.commit()
    c.onMessage({ data: { ...plan, t: 'sync', rows: [[{ w: '60', r: '8', done: false }]] } })
    workout.onShow()
    expect(workout.weightVal).toBe('80 kg')
    expect(c.sent.find(m => m.t === 'weight')).toMatchObject({ weight: '80', set: 1 })
    // Native hello responses can arrive after onShow has moved the edit into the outbox.
    c.onMessage({ data: { ...plan, t: 'sync', rows: [[{ w: '60', r: '8', done: false }]] } })
    expect(workout.weightVal).toBe('80 kg')
    const edit = c.sent.find(m => m.t === 'weight')
    workout.onShow()
    expect(c.sent.filter(m => m.t === 'weight')).toHaveLength(1)
    c.onMessage({ data: { ...edit, editAt: edit.at } })
    expect(sessions.loadState().pendingEdits).toHaveLength(0)
    c.onMessage({ data: { t: 'weight', sid: plan.sid, ex: 0, set: 1, weight: '85' } })
    expect(workout.weightVal).toBe('85 kg')
  })

  it('retries unacknowledged edits after reconnecting instead of leaving them permanently sent', async () => {
    const c = connection(), rpc = transport(c)
    rpc.startServer({})
    rpc.sendEvent({ t: 'weight', sid: plan.sid, ex: 0, set: 1, weight: '80', at: 100 })
    c.onClose(); c.onOpen()
    await new Promise(r => setTimeout(r, 300))
    expect(c.sent.filter(m => m.t === 'weight')).toHaveLength(2)
    c.onMessage({ data: { t: 'ack', eventId: c.sent.find(m => m.t === 'weight').eventId, upto: 100 } })
    await new Promise(r => setTimeout(r, 0))
    c.onClose(); c.onOpen()
    await new Promise(r => setTimeout(r, 300))
    expect(c.sent.filter(m => m.t === 'weight')).toHaveLength(2)
  })

  it('converges to the phone set count when a refreshed plan precedes a repeated group change', async () => {
    const sessions = session(), c = connection(), rpc = transport(c, sessions)
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const workout = training(sessions, rpc)
    workout.onInit()
    c.onMessage({ data: { ...plan, exercises: [{ ...plan.exercises[0], sets: 4 }] } })
    c.onMessage({ data: { t: 'add_set', sid: plan.sid, ex: 0, sets: 4 } })
    c.onMessage({ data: { t: 'add_set', sid: plan.sid, ex: 0, sets: 4 } })
    expect(sessions.loadState().workout.rows[0]).toHaveLength(4)
    c.onMessage({ data: { t: 'remove_set', sid: plan.sid, ex: 0, sets: 3 } })
    c.onMessage({ data: { t: 'remove_set', sid: plan.sid, ex: 0, sets: 3 } })
    expect(sessions.loadState().workout.rows[0]).toHaveLength(3)
  })

  it('applies phone completion once and advances the matching current set', async () => {
    const sessions = session(), c = connection(), rpc = transport(c, sessions)
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const workout = training(sessions, rpc)
    workout.onInit()
    c.onMessage({ data: { t: 'set', sid: plan.sid, ex: 0, set: 1 } })
    expect(sessions.loadState().workout.rows[0][0].done).toBe(true)
    expect(workout.groupLabel).toBe('第 2 / 3 组')
    c.onMessage({ data: { t: 'set', sid: plan.sid, ex: 0, set: 1 } })
    expect(workout.groupLabel).toBe('第 2 / 3 组')
  })

  it('advances past a phone-completed set from another exercise', async () => {
    const sessions = session(), c = connection(), rpc = transport(c, sessions)
    const exercises = Array.from({ length: 4 }, (_, i) => ({ name: 'Exercise ' + i, sets: 4, reps: '8', weight: '60' }))
    const state = sessions.startSession({ name: 'Four exercises', sid: 'four', exercises })
    state.workout.rows[0].forEach(row => { row.done = true })
    state.exIdx = 0
    state.setIdx = 3
    sessions.save(state)
    const workout = training(sessions, rpc)
    workout.onInit()

    workout.onRemoteSet({ sid: 'four', ex: 1, set: 1, at: 200 })

    expect(workout.state.exIdx).toBe(1)
    expect(workout.state.setIdx).toBe(1)
    expect(workout.state.workout.rows[0][3].done).toBe(true)
    await workout.onCurrentSetAction()
    expect(workout.state.workout.rows[0][3].done).toBe(true)
  })

  it.each(envelopes)(
    'delivers %s to the Index page and starts phone training directly', (_name, envelope) => {
      const c = connection()
      const sessions = session(), startSession = vi.spyOn(sessions, 'startSession')
      const rpc = transport(c, { loadState: sessions.loadState })
      const router = { replace: vi.fn() }
      const home = page('Index/index.ux', { ...sessions, startServer: rpc.startServer, router })
      home.onInit()
      home.onReady()
      c.onMessage(envelope(plan))
      expect(home.workoutName).toBe('Leg day')
      expect(home.exerciseCount).toBe(1)
      expect(home.canResume).toBe(true)
      expect(c.sent.find(m => m.t === 'plan_ack')).toMatchObject({
        sid: 'today', planId: 'p1', status: 'applied', page: 'Index', exercises: 1,
      })
      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ name: 'Leg day', sid: 'today', exercises: plan.exercises }), undefined)
      expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Workout' })
      expect(c.sent.find(m => m.t === 'hello')).toMatchObject({ watchVersion: 'test-watch', receipts: true })
    })

  it('reports invalid envelopes and handler failures instead of claiming delivery', async () => {
    const c = connection()
    transport(c).startServer({ onPlan() { throw new Error('render failed') } })
    c.onMessage({ data: '{bad json' })
    expect(c.sent.find(m => m.t === 'watch_rx')).toMatchObject({ status: 'invalid_message' })
    c.onMessage({ data: JSON.stringify(plan) })
    expect(c.sent.find(m => m.t === 'plan_ack')).toMatchObject({
      status: 'error', error: 'render failed', planId: 'p1',
    })
  })

  it('reports bounded inner structure and a stable failure reason without workout contents', async () => {
    const c = connection(), onPlan = vi.fn()
    transport(c).startServer({ onPlan })
    c.onMessage({ data: JSON.stringify({ unexpected: { secret: 'private workout' } }) })
    expect(c.sent.at(-1)).toMatchObject({ t: 'watch_rx', status: 'invalid_message',
      reason: 'missing_type', decodePath: 'event.data.json',
      layers: [{ type: 'object', keys: ['data'] }, { type: 'string' },
        { type: 'object', keys: ['unexpected'] }] })
    expect(JSON.stringify(c.sent.at(-1))).not.toContain('private workout')
    c.onMessage({ data: '{private workout' })
    expect(c.sent.at(-1)).toMatchObject({ reason: 'invalid_json', decodePath: 'event.data' })
    const cycle = {}; cycle.data = cycle
    c.onMessage(cycle)
    expect(c.sent.at(-1)).toMatchObject({ reason: 'envelope_depth_limit' })
    expect(c.sent.at(-1).layers.length).toBeLessThanOrEqual(8)
    c.onMessage({ data: new Uint8Array([123, 125]) })
    expect(c.sent.at(-1)).toMatchObject({ reason: 'unsupported_binary' })
    expect(onPlan).not.toHaveBeenCalled()
  })

  it('keeps business data fields and file events intact and never unwraps an invalid type', async () => {
    const c = connection(), onPlan = vi.fn(), onFile = vi.fn()
    transport(c).startServer({ onPlan, onFile })
    const business = { ...plan, data: { note: 'keep me' } }
    c.onMessage({ data: business })
    expect(onPlan).toHaveBeenCalledWith(business)
    c.onMessage({ isFileType: true, fileName: 'demo.bin', fileUri: 'internal://demo.bin' })
    expect(onFile).toHaveBeenCalledWith(expect.objectContaining({ t: 'file', fileName: 'demo.bin' }))
    onPlan.mockClear()
    c.onMessage({ data: { t: 1, data: plan } })
    expect(c.sent.at(-1)).toMatchObject({ reason: 'invalid_type' })
    expect(onPlan).not.toHaveBeenCalled()
  })

  it('does not claim applied when no page handler can process the plan', async () => {
    const c = connection()
    transport(c).startServer({})
    c.onMessage({ data: plan })
    expect(c.sent.find(m => m.t === 'plan_ack')).toMatchObject({ status: 'no_handler' })
  })

  it('updates subscribers across page modules sharing the App runtime and SDK instance', async () => {
    const c = connection(), shared = {}
    const indexRpc = transport(c, {}, shared), workoutRpc = transport(c, {}, shared)
    const home = vi.fn(() => ({ status: 'applied' }))
    const workout = vi.fn(() => ({ status: 'applied' }))
    indexRpc.startServer({ onPlan: home })
    workoutRpc.startServer({ onPlan: workout })
    indexRpc.startServer({ onPlan: home })
    c.onMessage({ data: plan })
    expect(home).toHaveBeenCalledOnce()
    expect(workout).not.toHaveBeenCalled()
  })

  it('refreshes Index handlers when the page becomes visible again', async () => {
    const startServer = vi.fn()
    const home = page('Index/index.ux', { startServer, storage: { getSync: () => [] }, loadState: () => ({}),
      router: {}, startSession() {} })
    home.onInit()
    startServer.mockClear()
    home.onShow()
    expect(startServer).toHaveBeenCalledOnce()
  })

  it('distinguishes an existing resumable session and an empty plan from an applied plan', async () => {
    const c = connection(), rpc = transport(c)
    const home = page('Index/index.ux', { startServer: rpc.startServer,
      loadState: () => ({ active: true, sid: 'today', workout: { name: 'Saved', exercises: plan.exercises } }) })
    home.onInit()
    c.onMessage({ data: plan })
    await new Promise(r => setTimeout(r, 300))
    expect(c.sent.at(-1)).toMatchObject({ t: 'plan_ack', status: 'retained', page: 'Index' })
    c.onMessage({ data: { ...plan, sid: 'new', exercises: [] } })
    expect(c.sent.at(-1)).toMatchObject({ status: 'rejected', reason: 'empty_exercises' })
  })

  it('applies plan and authoritative rows on Workout and reports a different-session rejection', async () => {
    const sessions = session()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises }, null)
    const c = connection(), rpc = transport(c, { loadState: sessions.loadState })
    const workout = page('Workout/index.ux', { ...sessions, startServer: rpc.startServer,
      router: { push: vi.fn() }, startSessionHr() {}, stopSessionHr() {}, startHr() {}, stopHr() {}, restOver() {},
      setInterval: () => 1, clearInterval() {}, pendingCount: () => 0, isConnected: () => true })
    workout.onInit()
    c.onMessage({ data: { ...plan, exercises: [{ ...plan.exercises[0], name: 'Bench' }] } })
    expect(workout.exName).toBe('Bench')
    expect(c.sent.at(-1)).toMatchObject({ t: 'plan_ack', status: 'applied', page: 'Workout' })
    c.onMessage({ data: { ...plan, sid: 'other' } })
    expect(c.sent.at(-1)).toMatchObject({ status: 'conflict', activeSid: 'today' })
    c.onMessage({ data: JSON.stringify({ msg: JSON.stringify({ ...plan, t: 'sync', rev: 42,
      rows: [[{ w: '75', r: '6', done: false }]] }) }) })
    expect(workout.weightVal).toBe('75 kg')
    expect(workout.repsVal).toBe('6 次')
    expect(c.sent.at(-1)).toMatchObject({ t: 'sync_ack', status: 'applied', page: 'Workout', rev: 42 })
    const beforeRest = Date.now()
    c.onMessage({ data: { msg: JSON.stringify({ t: 'rest', sid: plan.sid, leftSec: 30 }) } })
    expect(sessions.loadState().restUntil).toBeGreaterThanOrEqual(beforeRest + 30000)
    expect(sessions.loadState().restUntil).toBeLessThanOrEqual(Date.now() + 30000)
    workout.onShow()
    expect(sessions.loadState().workout.rows[0][0].w).toBe('75')
  })

  it('reports the same watch version that is declared in the installable manifest', async () => {
    const manifest = JSON.parse(source('manifest.json'))
    const context = {}
    runInNewContext(source('lib/version.js').replace('export const WATCH_VERSION', 'this.WATCH_VERSION'), context)
    expect(context.WATCH_VERSION).toBe(manifest.versionName)
  })
})


describe('watch local diagnostic viewer', () => {
  function viewer(events = []) {
    const snapshot = { connected: true, readyState: 1, peerProtocol: 3, pending: 2, phonePending: 0,
      head: { type: 'set', attempts: 3 }, events }
    const deps = { transportDiagnostics: vi.fn(() => snapshot), sendEvent: vi.fn(), save: vi.fn() }
    const watch = page('Workout/index.ux', deps)
    watch.focusCrown = vi.fn()
    return { watch, deps, snapshot }
  }
  const event = (stage, extra = {}) => ({ at: Date.parse('2026-10-27T10:10:00Z'), stage, type: 'set', ...extra })

  it('shows a fixed newest-first snapshot, error code, UTC time and wrapping pages', async () => {
    const { watch, deps, snapshot } = viewer([event('send_attempt'), event('send_success'), event('send_fail', { code: '77', detail: 'offline' })])
    watch.showDiagnostics()
    expect(watch.diagnosticOn).toBe(true)
    expect(watch.diagnosticTitle).toContain('1/2')
    expect(watch.diagnosticText).toContain('10:10:00Z send_fail set')
    expect(watch.diagnosticText).toContain('code=77')
    expect(watch.diagnosticText).toContain('offline')
    expect(watch.diagnosticText).not.toContain('send_attempt')
    watch.nextDiagnostic()
    expect(watch.diagnosticTitle).toContain('2/2')
    expect(watch.diagnosticText).toContain('send_attempt')
    watch.nextDiagnostic()
    expect(watch.diagnosticTitle).toContain('1/2')
    expect(deps.transportDiagnostics).toHaveBeenCalledOnce()
    expect(snapshot.events[0].stage).toBe('send_attempt')
    expect(deps.sendEvent).not.toHaveBeenCalled()
    expect(deps.save).not.toHaveBeenCalled()
  })

  it('handles an empty snapshot and closes with the back key', async () => {
    const { watch, deps } = viewer()
    watch.showDiagnostics()
    expect(watch.diagnosticTitle).toContain('1/1')
    expect(watch.onBackPress()).toBe(true)
    expect(watch.diagnosticOn).toBe(false)
    expect(watch.focusCrown).toHaveBeenCalledOnce()
    expect(deps.sendEvent).not.toHaveBeenCalled()
    expect(deps.save).not.toHaveBeenCalled()
  })

  it('blocks crown and swipe workout actions while viewing diagnostics', async () => {
    const { watch, deps } = viewer()
    watch.showDiagnostics()
    watch.touch = { x: 100, y: 100 }
    watch.touchLast = { x: 0, y: 100 }
    watch.onRotation({ state: 1, delta: 1 })
    watch.touchEnd({ changedTouches: [{ clientX: 0, clientY: 100 }] })
    expect(watch.touch).toBeNull()
    expect(watch.diagnosticOn).toBe(true)
    expect(deps.sendEvent).not.toHaveBeenCalled()
    expect(deps.save).not.toHaveBeenCalled()
  })
})
