// @vitest-environment node
// W07: one deliberate tap on a set in the watch's exercise list must open that set — including
// the tap right after a swipe, a scroll or a cancelled gesture. The swipe that opens the end
// panel must still not act on whatever sits under the finger when it lifts.
import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'

const source = path => readFileSync(new URL('../../../watch-app/src/' + path, import.meta.url), 'utf8')
const imports = /^import[\s\S]*?from ['"][^'"]+['"]\r?$/gm

function listPage({ onPick = () => {}, navigate = () => {} } = {}) {
  // A minimal session so the page can read and save a cursor.
  const state = {
    active: true, sid: 'today', weightUnit: 'kg', focusAt: 0, exIdx: 0, setIdx: 0,
    workout: {
      name: 'Leg day',
      exercises: [{ name: 'Squat', sets: 3, entryInstanceId: 'entry-A' }, { name: 'Bench', sets: 2, entryInstanceId: 'entry-B' }],
      rows: [
        [{ setId: 'a1', w: 60, r: '8', done: true }, { setId: 'a2', w: 60, r: '8', done: false }, { setId: 'a3', w: 60, r: '8', done: false }],
        [{ setId: 'b1', w: 40, r: '10', done: false }, { setId: 'b2', w: 40, r: '10', done: false }],
      ],
    },
  }
  const router = { back: vi.fn(navigate), replace: vi.fn(navigate), push: vi.fn(navigate) }
  const sendEvent = vi.fn(onPick)
  const script = source('ExerciseList/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]
  const context = {
    console, router, sendEvent, loadState: () => state, save: state => { context.saved = state }, endSession() {}, closeSession() {},
    Date, bindRuntime() {},
  }
  runInNewContext(script.replace(imports, '').replace('export default', 'this.page ='), context)
  const page = { ...context.page, ...context.page.data }
  page.onInit()
  return { page, router, sendEvent, state, context }
}

const tap = (page, el) => { page.touchStart({ touches: [{ clientX: 100, clientY: 200 }] }); page.touchEnd({ changedTouches: [{ clientX: 100, clientY: 200 }] }); page.pickRow(el) }
const swipe = (page, dx, dy = 0) => {
  page.touchStart({ touches: [{ clientX: 100, clientY: 200 }] })
  page.touchMove({ touches: [{ clientX: 100 + dx / 2, clientY: 200 + dy / 2 }] })
  page.touchEnd({ changedTouches: [{ clientX: 100 + dx, clientY: 200 + dy }] })
}

describe('choosing a set in the watch action list (W07)', () => {
  it('enters the tapped set on the first tap, thirty times in a row', () => {
    const { page, router, sendEvent, state } = listPage()
    page.toggleEx(0)
    let entered = 0
    for (let i = 0; i < 30; i++) {
      const target = { exIdx: 1, setIdx: i % 2, setId: 'b' + ((i % 2) + 1) }
      tap(page, target)
      if (state.setIdx === target.setIdx && state.exIdx === 1) entered++
      // The page leaves; coming back re-enters it cleanly.
      page.onShow()
    }
    expect(entered).toBe(30)
    expect(router.back).toHaveBeenCalledTimes(30)
    expect(sendEvent).toHaveBeenCalledTimes(30)
  })

  it('does not need the previous swipe’s trailing tap window to expire', () => {
    const { page, router, state } = listPage()
    page.toggleEx(0)
    swipe(page, 120)                       // right swipe: opens the end panel
    expect(page.endOn).toBe(true)
    page.onBackPress()                     // trailing system back is consumed
    expect(page.endOn).toBe(true)
    page.backToExercises()                 // still inside the protection window
    expect(page.endOn).toBe(true)

    // A new, deliberate touch closes the panel at once — no waiting out the old window.
    page.touchStart({ touches: [{ clientX: 100, clientY: 200 }] })
    page.touchEnd({ changedTouches: [{ clientX: 100, clientY: 200 }] })
    page.backToExercises()
    expect(page.endOn).toBe(false)

    // And the tap right after that enters the set on the first try.
    tap(page, { exIdx: 0, setIdx: 2, setId: 'a3' })
    expect(state.setIdx).toBe(2)
    expect(router.back).toHaveBeenCalledOnce()
  })

  it('protects the end-panel buttons from the swipe that opened them', () => {
    const { page, router } = listPage()
    swipe(page, 130)
    expect(page.endOn).toBe(true)
    page.saveWorkout()                     // the click the swipe drags onto "保存结束"
    expect(router.replace).not.toHaveBeenCalled()
    expect(page.interactionBlocked()).toBe(true)
    // ...and a clean touch the user makes on purpose arms the buttons again.
    page.touchStart({ touches: [{ clientX: 100, clientY: 200 }] })
    page.touchEnd({ changedTouches: [{ clientX: 100, clientY: 200 }] })
    expect(page.interactionBlocked()).toBe(false)
  })

  it('leaves vertical scrolling to the list: no pick, no end panel', () => {
    const { page, router, sendEvent } = listPage()
    page.toggleEx(0)
    page.touchStart({ touches: [{ clientX: 100, clientY: 200 }] })
    page.touchMove({ touches: [{ clientX: 108, clientY: 260 }] })
    page.touchEnd({ changedTouches: [{ clientX: 110, clientY: 320 }] })
    expect(page.endOn).toBe(false)
    expect(page.interactionBlocked()).toBe(false)   // a scroll does not block the next tap
    expect(router.back).not.toHaveBeenCalled()
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('treats a cancelled scroll as finished, without disarming the next tap', () => {
    const { page, router, state } = listPage()
    page.toggleEx(0)
    page.touchStart({ touches: [{ clientX: 100, clientY: 200 }] })
    page.touchMove({ touches: [{ clientX: 102, clientY: 320 }] })
    page.touchCancel()
    expect(page.endOn).toBe(false)
    tap(page, { exIdx: 0, setIdx: 1, setId: 'a2' })
    expect(state.setIdx).toBe(1)
    expect(router.back).toHaveBeenCalledOnce()
  })

  it('falls back to the training page when back did not leave the list', () => {
    const { page, router } = listPage({ navigate: () => {} })
    page.toggleEx(0)
    tap(page, { exIdx: 1, setIdx: 1, setId: 'b2' })
    expect(router.back).toHaveBeenCalledOnce()
    page.onShow()                            // still here: the stack had nothing to pop
    expect(router.replace).toHaveBeenCalledWith({ uri: '/Workout' })
  })

  it('follows the stable set id and reports a target that no longer exists', () => {
    const { page, router, state } = listPage()
    // The list row was built before the phone removed that set: setId wins over the index.
    page.pickRow({ exIdx: 0, setIdx: 0, setId: 'a3' })
    expect(state.setIdx).toBe(2)
    page.onShow()
    page.pickRow({ exIdx: 5, setIdx: 0 })
    expect(page.hint).toBe('该动作已被删除')
    expect(router.back).toHaveBeenCalledOnce()
  })
})
