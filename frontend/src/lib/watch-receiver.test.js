// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEdit, applyRest, restOf, applyFocus } from '../../../watch-app/src/lib/protocol.js'

// Execute the shipped watch JS and page scripts with only the device APIs replaced.
const source = path => readFileSync(new URL('../../../watch-app/src/' + path, import.meta.url), 'utf8')
const imports = /^import[\s\S]*?from ['"][^'"]+['"]\r?$/gm
function transport(connection, extra = {}) {
  const memory = new Map()
  const context = { interconnect: { instance: () => connection },
    storage: { getSync: ({ key }) => memory.get(key), set: ({ key, value }) => memory.set(key, structuredClone(value)) }, loadState: () => ({}), save() {},
    WATCH_VERSION: 'test-watch', console, setTimeout, setInterval: () => 1, clearInterval() {}, ...extra }
  runInNewContext(source('lib/rpc.js').replace(imports, '').replace(/export function /g, 'function ')
    + '\nthis.api = { startServer, sendControl, sendEvent }', context)
  return context.api
}
function connection() {
  const sent = []
  return { sent, send({ data, success }) { sent.push(data); success() },
    getReadyState({ success }) { success({ status: 1 }) } }
}
function page(path, deps) {
  const script = source(path).match(/<script>([\s\S]*?)<\/script>/)[1]
  const context = { console, WATCH_VERSION: 'test-watch', applyEdit, applyRest, restOf, applyFocus,
    storage: { getSync: () => null, set() {} }, replacePlan() {}, ...deps }
  runInNewContext(script.replace(imports, '').replace('export default', 'this.page ='), context)
  return { ...context.page, ...context.page.data }
}
function session() {
  const values = new Map()
  const context = { storage: {
    getSync: ({ key }) => values.has(key) ? JSON.parse(JSON.stringify(values.get(key))) : null,
    set: ({ key, value }) => values.set(key, JSON.parse(JSON.stringify(value))),
  }, console, applyEdit, applyRest }
  runInNewContext(source('lib/session.js').replace(imports, '').replace(/export function /g, 'function ')
    + '\nthis.api = { loadState, startSession, save, replacePlan, applySync, nextUndone, setRowValue, toggleSet, addSet, removeSet, addRestTime, calories, endSession, closeSession, storage }', context)
  return context.api
}
const plan = { t: 'plan', sid: 'today', planId: 'p1', workout: 'Leg day',
  exercises: [{ name: 'Squat', sets: 3, reps: '8', weight: '60' }] }
function training(sessions, rpc, extra = {}) {
  return page('Workout/index.ux', { ...sessions, ...rpc, router: { push: vi.fn() },
    startHr() {}, stopHr() {}, restOver() {}, tick() {},
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

  it('never completes or implicitly undoes an already completed set', () => {
    const { workout, sendEvent } = resting()
    workout.onSkipRest()
    workout.state.workout.rows[0] = [workout.state.workout.rows[0][0]]
    workout.state.workout.exercises[0].sets = 1
    workout.onCurrentSetAction()
    workout.onCurrentSetAction()
    workout.onComplete()
    expect(workout.rowDone).toBe(true)
    expect(sendEvent.mock.calls.filter(([m]) => m.t === 'set')).toHaveLength(1)
    expect(sendEvent.mock.calls.filter(([m]) => m.t === 'unset')).toHaveLength(0)
    expect(source('Workout/index.ux')).toContain('disabled="{{ rowDone || paused }}"')
    workout.onMenuUndo()
    expect(workout.rowDone).toBe(false)
    expect(sendEvent.mock.calls.filter(([m]) => m.t === 'unset')).toHaveLength(1)
  })

  it('updates a crown burst immediately and saves/sends only after rotation settles', () => {
    const { workout, writes, sendEvent: sendControl } = resting()
    const initial = workout.state.restUntil
    for (let i = 0; i < 80; i++) workout.onRotation({ delta: 1, state: 2 })
    expect(workout.state.restUntil).toBe(initial + 400000)
    expect(workout.restLabel).toBe('7:40')
    expect(writes).not.toHaveBeenCalled()
    expect(sendControl).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(writes).toHaveBeenCalledOnce()
    expect(sendControl).toHaveBeenCalledOnce()
    expect(sendControl.mock.calls[0][0]).toMatchObject({ t: 'rest', leftSec: 460 })
  })

  it('does not complete the next set when a second click arrives during rest', () => {
    const { workout, sendEvent } = resting()
    workout.onSkipRest()
    workout.onCurrentSetAction()
    expect(workout.state.setIdx).toBe(1)
    workout.onCurrentSetAction()
    expect(workout.state.workout.rows[0].filter(row => row.done)).toHaveLength(1)
    expect(sendEvent.mock.calls.filter(([m]) => m.t === 'set')).toHaveLength(1)
  })

  it('keeps an in-progress crown edit across a phone snapshot and rest echo', () => {
    const { workout, sessions, sendEvent: sendControl } = resting()
    workout.onRotation({ delta: 1, state: 2 })
    workout.onSyncUpdate({ ...plan, restUntil: Date.now() + 60000 })
    workout.onRemoteRest({ sid: plan.sid, leftSec: 60, seq: 1 })
    expect(workout.restLabel).toBe('1:05')
    vi.advanceTimersByTime(300)
    expect(sessions.loadState().restUntil).toBe(workout.state.restUntil)
    expect(sendControl.mock.calls[0][0].leftSec).toBe(65)
  })

  it('sends zero when crown adjustment ends the rest and does not resurrect it', () => {
    const { workout, sendEvent: sendControl, brightness } = resting()
    for (let i = 0; i < 12; i++) workout.onRotation({ delta: -1, state: 2 })
    expect(workout.state.restUntil).toBe(0)
    vi.advanceTimersByTime(300)
    expect(sendControl).toHaveBeenCalledOnce()
    expect(sendControl.mock.calls[0][0]).toMatchObject({ t: 'rest', leftSec: 0 })
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: false }))
  })

  it('clamps long crown rotations to the phone maximum of fifteen minutes', () => {
    const { workout, sendEvent: sendControl } = resting()
    for (let i = 0; i < 500; i++) workout.onRotation({ delta: 1, state: 2 })
    expect(workout.restLabel).toBe('15:00')
    vi.advanceTimersByTime(300)
    expect(sendControl.mock.calls[0][0].leftSec).toBe(900)
  })

  it('waits until the display API is ready before acquiring the screen lock', () => {
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

  it('cancels a queued crown change when skipping and starting a different rest', () => {
    const { workout, sendEvent: sendControl } = resting()
    workout.onRotation({ delta: 1, state: 2 })
    workout.onSkipRest()
    workout.onRemoteRest({ sid: plan.sid, leftSec: 20, seq: Date.now() + 1 })
    vi.advanceTimersByTime(1000)
    expect(sendControl.mock.calls.map(([m]) => m.leftSec)).toEqual([0])
    expect(workout.restLabel).toBe('0:19')
  })

  it('reconciles elapsed sleep by deadline and releases the screen on natural expiration', () => {
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

  it('flushes crown edits on hide and restores the rest screen lock on show', () => {
    const { workout, sendEvent: sendControl, brightness } = resting()
    workout.onRotation({ delta: 1, state: 2 })
    workout.onHide()
    expect(sendControl).toHaveBeenCalledOnce()
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: false }))
    workout.onShow()
    expect(workout.restLabel).toBe('1:05')
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: true }))
    vi.advanceTimersByTime(300)
    expect(sendControl).toHaveBeenCalledOnce()
  })

  it('acquires/relinquishes the screen lock for authoritative rest snapshots', () => {
    const { workout, brightness } = resting()
    workout.onSkipRest()
    workout.onSyncUpdate({ ...plan, rest: { leftSec: 10, totalSec: 10, seq: Date.now() + 1 } })
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: true }))
    vi.advanceTimersByTime(10000)
    expect(workout.state.restUntil).toBe(0)
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: false }))
  })

  it('drops delayed crown work when a session ends', () => {
    const { workout, sendControl, sessions, brightness } = resting()
    workout.onRotation({ delta: 1, state: 2 })
    workout.onEnd()
    vi.advanceTimersByTime(1000)
    expect(sendControl).not.toHaveBeenCalled()
    expect(sessions.loadState().active).toBe(false)
    expect(brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({ keepScreenOn: false }))
  })
})

describe('watch business message boundary', () => {
  it('selects an explicit action-list row using the documented bound item parameter', () => {
    const sessions = session(), back = vi.fn()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const list = page('ExerciseList/index.ux', { ...sessions, sendControl() {}, router: { back } })
    list.onInit(); list.toggleEx(0)
    expect(list.expanded).toBe(0)
    list.pickRow({ exIdx: 0, setIdx: 2 })
    expect(sessions.loadState().setIdx).toBe(2)
    expect(back).toHaveBeenCalledOnce()
  })
  it('finalizes on a delayed phone end, sends energy reliably and refuses stale plans for the closed session', () => {
    const sessions = session(), c = connection(), rpc = transport(c, sessions)
    const state = sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    state.startedAt = Date.now() - 600000
    sessions.save(state)
    const replace = vi.fn(), workout = training(sessions, rpc, { router: { replace } })
    workout.onInit()
    workout.hrDirty = true
    c.onMessage({ data: { t: 'ended', sid: plan.sid, endedAt: Date.now() - 300000, reason: 'finished' } })
    expect(sessions.loadState().active).toBe(false)
    expect(replace).toHaveBeenCalledWith({ uri: '/Index' })
    const summary = c.sent.find(m => m.t === 'summary')
    expect(summary.minutes).toBeCloseTo(5, 1)
    expect(summary.calories).toBeGreaterThan(0)
    c.onMessage({ data: plan })
    expect(c.sent.at(-1)).toMatchObject({ t: 'plan_ack', status: 'closed' })
    expect(sessions.loadState().active).toBe(false)
    c.onClose(); c.onOpen()
    expect(c.sent.filter(m => m.t === 'summary')).toHaveLength(2)
  })

  it('leaves another session active when an old end arrives', () => {
    const sessions = session(), c = connection(), rpc = transport(c, sessions)
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    rpc.startServer({ onEnded: vi.fn() })
    c.onMessage({ data: { t: 'ended', sid: 'old', endedAt: Date.now() } })
    expect(sessions.loadState().active).toBe(true)
    expect(c.sent.some(m => m.t === 'summary')).toBe(false)
  })

  it('intercepts system back and gives the crown focus, set navigation and rest adjustment', () => {
    const sessions = session(), rpc = transport(connection())
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const requestFocus = vi.fn(), workout = training(sessions, rpc, { $element: () => ({ requestFocus }) })
    workout.$element = () => ({ requestFocus })
    workout.onInit(); workout.onReady()
    expect(requestFocus).toHaveBeenCalledWith(true)
    expect(JSON.parse(source('manifest.json')).router.pages.Workout.followHand).toBe('disable')
    expect(workout.onBackPress()).toBe(true)
    expect(workout.menuOn).toBe(false)
    workout.onRotation({ delta: 1, state: 1 })
    expect(workout.state.setIdx).toBe(1)
    workout.state.restUntil = Date.now() + 30000
    workout.refresh()
    const before = workout.state.restUntil
    workout.onRotation({ delta: 1, state: 2 })
    expect(workout.state.restUntil).toBeGreaterThanOrEqual(before + 4000)
    const after = workout.state.restUntil
    workout.onRotation({ delta: 1, state: 3 })
    expect(workout.state.restUntil).toBe(after)
  })

  it('lets the crown fine tune keypad values without typing', () => {
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

  it('ignores taps and canceled gestures and keeps changedTouches compatibility', () => {
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

  it('opens on the first set and preserves the cursor across repeated plan deliveries', () => {
    const sessions = session(), c = connection(), rpc = transport(c)
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const workout = training(sessions, rpc)
    workout.onInit()
    expect(workout.groupLabel).toBe('第 1 / 3 组')
    c.onMessage({ data: plan })
    c.onMessage({ data: plan })
    expect(workout.groupLabel).toBe('第 1 / 3 组')
    workout.onComplete()
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

  it('keeps the shown value when Keypad is confirmed without typing', () => {
    const sessions = session()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const keypad = page('Keypad/index.ux', { ...sessions, sendControl() {}, router: { back() {} } })
    keypad.onInit({ exIdx: 0, setIdx: 0, field: 'w' })
    keypad.commit()
    expect(sessions.loadState().workout.rows[0][0].w).toBe('60')
  })

  it('keeps a saved Keypad edit across a phone snapshot arriving before the page returns', () => {
    const sessions = session(), c = connection(), rpc = transport(c)
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

  it('retries unacknowledged edits after reconnecting instead of leaving them permanently sent', () => {
    const c = connection(), rpc = transport(c)
    rpc.startServer({})
    rpc.sendEvent({ t: 'weight', sid: plan.sid, ex: 0, set: 1, weight: '80', at: 100 })
    c.onClose(); c.onOpen()
    expect(c.sent.filter(m => m.t === 'weight')).toHaveLength(2)
    c.onMessage({ data: { t: 'ack', upto: 100 } })
    c.onClose(); c.onOpen()
    expect(c.sent.filter(m => m.t === 'weight')).toHaveLength(2)
  })

  it('converges to the phone set count when a refreshed plan precedes a repeated group change', () => {
    const sessions = session(), c = connection(), rpc = transport(c)
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

  it('applies phone completion once and advances the matching current set', () => {
    const sessions = session(), c = connection(), rpc = transport(c)
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises })
    const workout = training(sessions, rpc)
    workout.onInit()
    c.onMessage({ data: { t: 'set', sid: plan.sid, ex: 0, set: 1 } })
    expect(sessions.loadState().workout.rows[0][0].done).toBe(true)
    expect(workout.groupLabel).toBe('第 1 / 3 组')
    c.onMessage({ data: { t: 'set', sid: plan.sid, ex: 0, set: 1 } })
    expect(workout.groupLabel).toBe('第 1 / 3 组')
  })

  it.each(envelopes)(
    'delivers %s to the Index page and confirms the visible offer', (_name, envelope) => {
      const c = connection()
      const rpc = transport(c)
      const startSession = vi.fn()
      const home = page('Index/index.ux', { startServer: rpc.startServer, loadState: () => ({}),
        router: { push: vi.fn() }, startSession })
      home.onInit()
      c.onMessage(envelope(plan))
      expect(home.workoutName).toBe('Leg day')
      expect(home.exerciseCount).toBe(1)
      expect(home.canResume).toBe(true)
      expect(c.sent.find(m => m.t === 'plan_ack')).toMatchObject({
        sid: 'today', planId: 'p1', status: 'applied', page: 'Index', exercises: 1,
      })
      home.onStart()
      expect(startSession).toHaveBeenCalledWith({ name: 'Leg day', sid: 'today', exercises: plan.exercises }, undefined)
      expect(c.sent.find(m => m.t === 'hello')).toMatchObject({ watchVersion: 'test-watch', receipts: true })
    })

  it('reports invalid envelopes and handler failures instead of claiming delivery', () => {
    const c = connection()
    transport(c).startServer({ onPlan() { throw new Error('render failed') } })
    c.onMessage({ data: '{bad json' })
    expect(c.sent.find(m => m.t === 'watch_rx')).toMatchObject({ status: 'invalid_message' })
    c.onMessage({ data: JSON.stringify(plan) })
    expect(c.sent.find(m => m.t === 'plan_ack')).toMatchObject({
      status: 'error', error: 'render failed', planId: 'p1',
    })
  })

  it('reports bounded inner structure and a stable failure reason without workout contents', () => {
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

  it('keeps business data fields and file events intact and never unwraps an invalid type', () => {
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

  it('does not claim applied when no page handler can process the plan', () => {
    const c = connection()
    transport(c).startServer({})
    c.onMessage({ data: plan })
    expect(c.sent.find(m => m.t === 'plan_ack')).toMatchObject({ status: 'no_handler' })
  })

  it('reattaches callbacks when returning to a page whose module shares the SDK instance', () => {
    const c = connection()
    const indexRpc = transport(c), workoutRpc = transport(c)
    const home = vi.fn(() => ({ status: 'applied' }))
    const workout = vi.fn(() => ({ status: 'applied' }))
    indexRpc.startServer({ onPlan: home })
    workoutRpc.startServer({ onPlan: workout })
    indexRpc.startServer({ onPlan: home })
    c.onMessage({ data: plan })
    expect(home).toHaveBeenCalledOnce()
    expect(workout).not.toHaveBeenCalled()
  })

  it('refreshes Index handlers when the page becomes visible again', () => {
    const startServer = vi.fn()
    const home = page('Index/index.ux', { startServer, storage: { getSync: () => [] }, loadState: () => ({}),
      router: {}, startSession() {} })
    home.onInit()
    startServer.mockClear()
    home.onShow()
    expect(startServer).toHaveBeenCalledOnce()
  })

  it('distinguishes an existing resumable session and an empty plan from an applied plan', () => {
    const c = connection(), rpc = transport(c)
    const home = page('Index/index.ux', { startServer: rpc.startServer,
      loadState: () => ({ active: true, sid: 'today', workout: { name: 'Saved', exercises: plan.exercises } }) })
    home.onInit()
    c.onMessage({ data: plan })
    expect(c.sent.at(-1)).toMatchObject({ t: 'plan_ack', status: 'retained', page: 'Index' })
    c.onMessage({ data: { ...plan, sid: 'new', exercises: [] } })
    expect(c.sent.at(-1)).toMatchObject({ status: 'rejected', reason: 'empty_exercises' })
  })

  it('applies plan and authoritative rows on Workout and reports a different-session rejection', () => {
    const sessions = session()
    sessions.startSession({ name: plan.workout, sid: plan.sid, exercises: plan.exercises }, null)
    const c = connection(), rpc = transport(c, { loadState: sessions.loadState })
    const workout = page('Workout/index.ux', { ...sessions, startServer: rpc.startServer,
      router: { push: vi.fn() }, startHr() {}, stopHr() {}, restOver() {},
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

  it('reports the same watch version that is declared in the installable manifest', () => {
    const manifest = JSON.parse(source('manifest.json'))
    const context = {}
    runInNewContext(source('lib/version.js').replace('export const WATCH_VERSION', 'this.WATCH_VERSION'), context)
    expect(context.WATCH_VERSION).toBe(manifest.versionName)
  })
})
