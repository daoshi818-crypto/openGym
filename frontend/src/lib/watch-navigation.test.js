// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { watchSource, stripImports } from './watch-test-harness.js'

function setup() {
  const shared = {}, router = { back: vi.fn(), push: vi.fn(), replace: vi.fn() }
  const state = { active: true, sid: 's', exIdx: 0, setIdx: 0,
    workout: { exercises: [{ name: 'Row' }], rows: [[{ done: false }]] } }
  function page(name) {
    const ctx = { Date, router, runtime: () => shared, loadState: () => state, clearInterval, bindRuntime() {} }
    runInNewContext(stripImports(watchSource(name + '/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1])
      .replace('export default', 'this.page ='), ctx)
    return { ...ctx.page, ...ctx.page.data, state }
  }
  const workout = page('Workout'), list = page('ExerciseList')
  for (const method of ['bindRpc', 'reconcileRestClock', 'flushPendingRowEdits', 'startHrCapture',
    'refresh', 'focusCrown', 'flushRestNudge', 'setRestScreenLock']) workout[method] = vi.fn()
  list.onInit()
  return { shared, router, workout, list, state }
}
afterEach(() => vi.useRealTimers())
describe('watch navigation lifetime', () => {
  it('pushes the exercise list once even when duplicate click events arrive', () => {
    const { workout, router } = setup()
    workout.openExercises(); workout.openExercises(); workout.openExercises(true)
    expect(router.push).toHaveBeenCalledTimes(1)
  })
  it('clears an interrupted gesture and navigation lock when returning to training', () => {
    const { workout, router } = setup()
    workout.touchAxis = 'y'; workout.trailingTapBlockedUntil = Date.now() + 5000
    workout.navPending = true
    workout.onHide(); workout.onShow()
    expect(workout.interactionBlocked()).toBe(false)
    workout.openExercises()
    expect(router.push).toHaveBeenCalledTimes(1)
  })
  it('returns only once when Return and system Back arrive together', () => {
    const { list, router } = setup()
    list.onExit(); list.onBackPress(); list.onExit()
    expect(router.back).toHaveBeenCalledTimes(1)
  })
  it('opens finish on the existing training page without stacking another Workout', () => {
    const { list, workout, router, shared } = setup()
    list.saveWorkout(); list.saveWorkout()
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(router.replace).not.toHaveBeenCalled()
    workout.onShow()
    expect(workout.finishOn).toBe(true)
    expect(shared.finishRequest).toBeFalsy()
    workout.finishOn = false; workout.onShow()
    expect(workout.finishOn).toBe(false)
  })
  it('does not apply a finish request to a different session', () => {
    const { list, workout, state, shared } = setup()
    list.saveWorkout(); state.sid = 'different'; workout.onShow()
    expect(workout.finishOn).toBe(false)
    expect(shared.finishRequest).toBeFalsy()
  })
})
