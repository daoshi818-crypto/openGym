import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { watchSource, stripImports } from './watch-test-harness.js'

function setup() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
  const source = watchSource('Workout/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]
  const context = { Date, save: vi.fn() }
  runInNewContext(stripImports(source).replace('export default', 'this.page ='), context)
  const page = { ...context.page, ...context.page.data }
  page.state = { sid: 'session', exIdx: 0, setIdx: 0,
    workout: { exercises: [{}, {}], rows: [[{ done: false }], [{ done: false }]] } }
  page.emitEvent = vi.fn()
  page.refresh = () => page.updateAutoFocusLock(page.state)
  page.refresh()
  return page
}
afterEach(() => vi.useRealTimers())

describe('watch: deliberate actions after automatic exercise changes', () => {
  it('blocks a slower second Done and Skip for one second, without prolonging it on refresh', () => {
    const page = setup()
    page.onComplete = vi.fn()
    page.cancelRestNudge = vi.fn()
    page.state.exIdx = 1
    page.refresh()
    vi.advanceTimersByTime(800)
    page.refresh()
    page.onCurrentSetAction()
    page.onSkipRest()
    expect(page.onComplete).not.toHaveBeenCalled()
    expect(page.cancelRestNudge).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    page.onCurrentSetAction()
    expect(page.onComplete).toHaveBeenCalledOnce()
  })

  it('allows a manual exercise choice immediately', () => {
    const page = setup()
    page.state.exIdx = 1; page.refresh()
    page.stepExercise(-1)
    page.onComplete = vi.fn()
    page.onCurrentSetAction()
    expect(page.state.exIdx).toBe(0)
    expect(page.onComplete).toHaveBeenCalledOnce()
  })

  it('does not lock a new session or an ordinary refresh on the same exercise', () => {
    const page = setup()
    page.onComplete = vi.fn()
    page.refresh(); page.onCurrentSetAction()
    page.state.sid = 'new-session'; page.state.exIdx = 1
    page.refresh(); page.onCurrentSetAction()
    expect(page.onComplete).toHaveBeenCalledTimes(2)
  })
})
