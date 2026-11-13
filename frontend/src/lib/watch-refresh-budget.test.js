// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { watchSource, stripImports, watchInteractionDeps, watchPersistence, loadWatchModule } from './watch-test-harness.js'
import * as effort from '../../../watch-app/src/lib/effort-scale.js'
import * as protocol from '../../../watch-app/src/lib/protocol.js'
import { lastTimeView } from '../../../watch-app/src/lib/watch-last-time.js'

function setup() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T09:00:00Z'))
  const { ctx } = watchPersistence()
  Object.assign(ctx, protocol, watchInteractionDeps, effort, { Date, console, lastTimeView })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('session', ctx, ['loadState', 'save', 'startSession', 'nextUndone', 'calories'])
  ctx.startSession({ sid: 'budget', name: '推日', exercises: [
    { name: '上斜哑铃交替卧推（慢速离心三秒并在最低点停顿）', sets: 4, reps: '8', weight: '62.5' },
    { name: '划船', sets: 2, reps: '10', weight: '30' },
  ] })
  const readHr = vi.fn(ctx.readSessionHr), kcal = vi.fn(ctx.calories)
  const pending = vi.fn(() => 0), failed = { failed: false }
  const router = { push: vi.fn(), replace: vi.fn() }
  Object.assign(ctx, {
    readSessionHr: readHr, calories: kcal, pendingCount: pending,
    startServer() {}, sendEvent() {}, isConnected: () => true,
    persistenceStatus: () => failed, synchronizationStatus: () => ({}),
    startSessionHr() {}, stopSessionHr() {}, restOver: vi.fn(), tick() {},
    setTimeout, clearTimeout, setInterval, clearInterval, router, brightness: {},
  })
  runInNewContext(stripImports(watchSource('Workout/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'this.page ='), ctx)
  const p = Object.assign(ctx.page, ctx.page.data)
  p.onInit({})
  return { p, ctx, readHr, kcal, pending, failed, router }
}
afterEach(() => vi.useRealTimers())

describe('watch refresh and long-name behavior', () => {
  it('keeps idle HR/calorie work on separate budgets without delaying sync failures', () => {
    const { p, readHr, kcal, pending, failed } = setup()
    readHr.mockClear(); kcal.mockClear(); pending.mockClear()
    const writes = {}
    for (const key of ['hrLabel', 'kcalLabel', 'syncWarning', 'syncLabel']) {
      let value = p[key]
      Object.defineProperty(p, key, { get: () => value, set: v => { writes[key] = (writes[key] || 0) + 1; value = v } })
    }
    vi.advanceTimersByTime(1000)
    expect(readHr).not.toHaveBeenCalled(); expect(kcal).not.toHaveBeenCalled()
    expect(writes).toEqual({})
    failed.failed = true
    vi.advanceTimersByTime(1000)
    expect(p.syncLabel).toBe('存储失败，请保留应用')
    expect(readHr).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    expect(readHr).toHaveBeenCalledTimes(2); expect(kcal).toHaveBeenCalledTimes(1)
    expect(pending).toHaveBeenCalledTimes(5)
    expect(writes.syncLabel).toBe(1); expect(writes.syncWarning).toBe(1)
  })
  it('forces action feedback and cancels all periodic UI work when hidden or destroyed', () => {
    const { p, readHr, kcal } = setup()
    readHr.mockClear(); kcal.mockClear()
    p.state.pausedAt = Date.now(); p.refresh()
    expect(readHr).toHaveBeenCalledTimes(1); expect(kcal).toHaveBeenCalledTimes(1)
    p.onHide(); p.tickClock(); vi.advanceTimersByTime(10000)
    expect(readHr).toHaveBeenCalledTimes(1); expect(p.timer).toBeNull()
    p.onShow(); expect(p.timer).not.toBeNull()
    p.onDestroy(); const count = readHr.mock.calls.length
    p.tickClock(); vi.advanceTimersByTime(10000)
    expect(readHr).toHaveBeenCalledTimes(count); expect(p.timer).toBeNull()
  })
  it('reconciles rest expiry before slow metric work and enforces the six-hour limit', () => {
    const { p, ctx } = setup()
    p.state.restUntil = Date.now() + 1500; ctx.save(p.state); p.refresh()
    expect(p.clockPeriod).toBe(500)
    vi.advanceTimersByTime(1500)
    expect(p.state.restUntil).toBe(0); expect(p.isRest).toBe(false)
    expect(p.clockPeriod).toBe(1000); expect(ctx.restOver).toHaveBeenCalledTimes(1)
    p.onRemoteEnded = vi.fn()
    p.state.segmentStartedAt = Date.now() - 21600000
    p.tickClock()
    expect(p.onRemoteEnded).toHaveBeenCalledTimes(1)
  })
  it('counts undone rows even when an already completed group is selected', () => {
    const { p, router } = setup()
    p.state.workout.rows[0][0].done = true
    p.state.workout.rows[0][3].done = true
    p.state.setIdx = 3; p.refresh()
    expect(p.remainingLabel).toBe('余 2 组')
    vi.advanceTimersByTime(1000) // The existing cursor-change guard consumes trailing taps.
    p.openExercises()
    expect(router.push).toHaveBeenCalledWith({ uri: '/ExerciseList', params: { detailEx: '0' } })
  })
  it('opens a fully readable name without changing the training cursor', () => {
    const { ctx } = setup()
    runInNewContext(stripImports(watchSource('ExerciseList/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'this.list ='), ctx)
    const p = Object.assign(ctx.list, ctx.list.data)
    p.onInit({ detailEx: '1' })
    expect(p.expanded).toBe(1)
    const scrollTo = vi.fn()
    p.$element = id => ({ requestFocus() {}, scrollTo })
    p.onReady()
    expect(scrollTo).toHaveBeenCalledWith({ index: 1, behavior: 'instant' })
    expect(ctx.loadState().exIdx).toBe(0)
    p.onInit({ detailEx: 'NaN' }); expect(p.expanded).toBe(-1)
    expect(watchSource('ExerciseList/index.ux')).toMatch(/\.full-name\s*\{[^}]*lines: 0/)
  })
  it('opens the displayed next exercise when revisiting a completed exercise during rest', () => {
    const { p, router } = setup()
    p.state.workout.rows[0].forEach(r => { r.done = true; r.at = Date.now() })
    p.state.restUntil = Date.now() + 90000; p.refresh()
    expect(p.nextTargetLabel).toBe('下一组 · 划船')
    vi.advanceTimersByTime(1000)
    p.openNextExercise()
    expect(router.push).toHaveBeenCalledWith({ uri: '/ExerciseList', params: { detailEx: '1' } })
    expect(p.state.exIdx).toBe(0)
  })
})
