// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Execute the shipped watch JS and page scripts with only the device APIs replaced.
const source = path => readFileSync(new URL('../../../watch-app/src/' + path, import.meta.url), 'utf8')
const imports = /^import[\s\S]*?from ['"][^'"]+['"]\r?$/gm
function transport(connection, extra = {}) {
  const context = { interconnect: { instance: () => connection },
    storage: { getSync: () => [], set() {} }, loadState: () => ({}),
    WATCH_VERSION: 'test-watch', console, setTimeout, ...extra }
  runInNewContext(source('lib/rpc.js').replace(imports, '').replace(/export function /g, 'function ')
    + '\nthis.api = { startServer, sendControl }', context)
  return context.api
}
function connection() {
  const sent = []
  return { sent, send({ data, success }) { sent.push(data); success() },
    getReadyState({ success }) { success({ status: 1 }) } }
}
function page(path, deps) {
  const script = source(path).match(/<script>([\s\S]*?)<\/script>/)[1]
  const context = { console, WATCH_VERSION: 'test-watch', ...deps }
  runInNewContext(script.replace(imports, '').replace('export default', 'this.page ='), context)
  return { ...context.page, ...context.page.data }
}
function session() {
  const values = new Map()
  const context = { storage: {
    getSync: ({ key }) => values.has(key) ? JSON.parse(JSON.stringify(values.get(key))) : null,
    set: ({ key, value }) => values.set(key, JSON.parse(JSON.stringify(value))),
  }, console }
  runInNewContext(source('lib/session.js').replace(imports, '').replace(/export function /g, 'function ')
    + '\nthis.api = { loadState, startSession, save, replacePlan, applySync, nextUndone }', context)
  return context.api
}
const plan = { t: 'plan', sid: 'today', planId: 'p1', workout: 'Leg day',
  exercises: [{ name: 'Squat', sets: 3, reps: '8', weight: '60' }] }

describe('watch business message boundary', () => {
  it.each([msg => ({ data: JSON.stringify(msg) }), msg => ({ data: msg })])(
    'delivers a plan to the Index page and confirms the visible offer', envelope => {
      const c = connection()
      const rpc = transport(c)
      const startSession = vi.fn()
      const home = page('Index/index.ux', { startServer: rpc.startServer, loadState: () => ({}),
        router: { push: vi.fn() }, startSession })
      home.onInit()
      c.onMessage(envelope(plan))
      expect(home.workoutName).toBe('Leg day')
      expect(home.exerciseCount).toBe(1)
      expect(home.canStart).toBe(true)
      expect(c.sent.find(m => m.t === 'plan_ack')).toMatchObject({
        sid: 'today', planId: 'p1', status: 'applied', page: 'Index', exercises: 1,
      })
      home.onStart()
      expect(startSession).toHaveBeenCalledWith({ name: 'Leg day', sid: 'today', exercises: plan.exercises }, null)
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
    const home = page('Index/index.ux', { startServer, loadState: () => ({}),
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
    expect(c.sent.at(-1)).toMatchObject({ status: 'rejected', reason: 'session_mismatch', activeSid: 'today' })
    c.onMessage({ data: { ...plan, t: 'sync', rev: 42, rows: [[{ w: '75', r: '6', done: false }]] } })
    expect(workout.weightVal).toBe('75 kg')
    expect(workout.repsVal).toBe('6 次')
    expect(c.sent.at(-1)).toMatchObject({ t: 'sync_ack', status: 'applied', page: 'Workout', rev: 42 })
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
