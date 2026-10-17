// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Workout from './Workout.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI, restoreRest, restoreWork } from '../store/useUI.js'
import { supersetUnits } from '../lib/history.js'
import { WORKOUT_LONG_PRESS_MS } from '../lib/use-workout-reorder.js'

vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), chime: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})), beacon: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = value => JSON.parse(JSON.stringify(value))
const entry = (key, extra = {}) => ({ id: '1001', occurrenceId: key, target: { mode: 'reps', sets: 1, reps: 5 },
  note: key, sets: [{ w: (key?.length || 1) * 10, r: 5, rir: 2, done: false }], ...extra })
const originalUpdate = useStore.getState().update
let root, host
let width = 360
const active = () => useStore.getState().S.active
const order = () => active().entries.map(e => e.occurrenceId)
const rows = () => [...host.querySelectorAll('[data-workout-unit]')]
const rect = (top, height) => ({ x: 0, y: top, left: 0, right: width, width, top, bottom: top + height, height })

function render() {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
}
function mount(entries = [entry('a'), entry('bb'), entry('ccc')], view = 'list', cur = 1, extra = {}) {
  const S = clone(DEF)
  S.hints = { ...S.hints, swipeSets: true }
  S.active = { id: 'reorder-test', d: '2026-10-17', start: Date.now() - 123456, name: 'Reorder',
    routineId: 'r1', entries, cur, workoutView: view, ...extra }
  S.routines = [{ id: 'r1', name: 'Unchanged plan', ex: clone(entries).map(({ occurrenceId, ...e }) => e) }]
  useStore.setState({ S, user: null })
  render()
}
function pointer(target, type, { y = 140, x = 100, id = 7, kind = 'touch', primary = true } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries({ pointerId: id, pointerType: kind, isPrimary: primary, button: 0, clientX: x, clientY: y })) {
    Object.defineProperty(event, key, { value, configurable: true })
  }
  act(() => target.dispatchEvent(event))
  return event
}
function lift(row) {
  const y = row.getBoundingClientRect().top + 20
  pointer(row.querySelector('.exhd') || row.querySelector('.wl-summary') || row, 'pointerdown', { y })
  act(() => vi.advanceTimersByTime(WORKOUT_LONG_PRESS_MS))
  return y
}
function drop(source, target, after = true) {
  lift(source)
  const r = target.getBoundingClientRect()
  const y = r.top + r.height / 2 + (after ? 1 : -1)
  pointer(document, 'pointermove', { y })
  pointer(document, 'pointerup', { y })
}
function noDrag() {
  expect(host.querySelector('.is-dragging')).toBeNull()
  expect(host.querySelector('.workout-drop-indicator')).toBeNull()
}
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); width = 360
  useStore.setState({ update: originalUpdate })
  useUI.getState().stopRest(); useUI.getState().stopWork()
  useUI.setState({ sheets: [], timer: null, work: null, swipeHint: null, setFlash: null })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => window.setTimeout(() => cb(Date.now()), 16))
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => window.clearTimeout(id))
  // Unequal actual tile heights, with painted transforms reflected in measurement.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.classList.contains('workout-reorder')) return rect(100, 1100)
    if (this.hasAttribute('data-workout-unit')) {
      const siblings = rows()
      const index = siblings.indexOf(this)
      const heights = [100, 210, 140, 80, 160]
      const top = 110 + siblings.slice(0, index).reduce((n, _, i) => n + heights[i] + 14, 0)
      const delta = Number(this.style.transform.split(',')[1]?.replace('px', '').trim() || 0)
      return rect(top + delta, heights[index] || 100)
    }
    return rect(0, 0)
  })
})
afterEach(() => {
  if (root) act(() => root.unmount())
  host?.remove(); root = null; host = null
  useUI.getState().stopRest(); useUI.getState().stopWork()
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers()
})

describe('live workout long-press ordering', () => {
  it.each(['list', 'compact'])('%s moves first to last and last to first, preserving data/current/plan and restoring order', view => {
    mount(undefined, view)
    const before = clone(active()), plan = clone(useStore.getState().S.routines)
    const save = vi.spyOn(useStore.getState(), 'update')
    drop(rows()[0], rows()[2])
    expect(order()).toEqual(['bb', 'ccc', 'a'])
    expect(active().entries[active().cur].occurrenceId).toBe('bb')
    expect(active().start).toBe(before.start)
    for (const e of before.entries) expect(active().entries.find(x => x.occurrenceId === e.occurrenceId)).toEqual(e)
    expect(useStore.getState().S.routines).toEqual(plan)
    expect(useUI.getState().sheets).toHaveLength(0)
    expect(save.mock.calls).toHaveLength(1)
    expect(save.mock.calls[0][1]).toBe(false)
    expect(JSON.parse(localStorage.getItem('gym_state_v1')).active.entries.map(e => e.occurrenceId)).toEqual(order())
    noDrag()
    drop(rows()[2], rows()[0], false)
    expect(order()).toEqual(['a', 'bb', 'ccc'])
    const saved = JSON.parse(localStorage.getItem('gym_state_v1'))
    act(() => root.unmount()); host.remove(); root = null
    useStore.setState({ S: saved }); render()
    expect(order()).toEqual(['a', 'bb', 'ccc'])
    expect(rows().map(row => row.dataset.workoutUnit)).toEqual(order())
    expect(active().entries).toEqual(before.entries)
  })

  it('moves a whole superset past another, preserving member order, current round and group metadata', () => {
    const entries = [entry('a'), entry('b', { sg: 'one' }), entry('c', { sg: 'one' }), entry('d', { sg: 'two' }), entry('e', { sg: 'two' })]
    mount(entries, 'list', 2, { groupMeta: { one: { name: 'A', rest: 75 }, two: { name: 'B' } } })
    const before = clone(active())
    drop(rows()[1], rows()[2])
    expect(order()).toEqual(['a', 'd', 'e', 'b', 'c'])
    expect(supersetUnits(active().entries)).toEqual([[0], [1, 2], [3, 4]])
    expect(active().entries[active().cur].occurrenceId).toBe('c')
    expect(active().entries.slice(3)).toEqual(before.entries.slice(1, 3))
    expect(active().groupMeta).toEqual(before.groupMeta)
  })

  it.each(['cards', 'focus'])('%s long press opens a temporary overview and completes the same gesture', view => {
    mount(undefined, view, 0)
    expect(rows()).toHaveLength(1)
    lift(rows()[0])
    expect(rows()).toHaveLength(3)
    expect(host.querySelector('.is-dragging')).toBeTruthy()
    const r = rows()[2].getBoundingClientRect()
    pointer(document, 'pointermove', { y: r.bottom - 1 })
    pointer(document, 'pointerup', { y: r.bottom - 1 })
    expect(order()).toEqual(['bb', 'ccc', 'a'])
    expect(active().workoutView).toBe(view)
    act(() => [...host.querySelectorAll('.workout-reorder-toolbar button')][0].click())
    expect(rows()).toHaveLength(1)
    expect(rows()[0].dataset.workoutUnit).toBe('a')
    noDrag()
  })

  it('remaps a running rest without resetting time and restores its new owner', () => {
    mount()
    act(() => useUI.getState().startRest(90, 0, 0))
    const before = clone(useUI.getState().timer)
    drop(rows()[0], rows()[2])
    expect(useUI.getState().timer).toEqual({ ...before, forIdx: 2 })
    const saved = localStorage.getItem('gym_rest')
    act(() => useUI.getState().stopRest())
    localStorage.setItem('gym_rest', saved)
    act(() => { expect(restoreRest()).toBe(true) })
    expect(useUI.getState().timer.forIdx).toBe(2)
    expect(useUI.getState().timer.endsAt).toBe(before.endsAt)
  })

  it('keeps an explicitly reopened completed card open when its occurrence moves', () => {
    mount([entry('a', { sets: [{ w: 20, r: 5, done: true }] }), entry('bb'), entry('ccc')], 'list', 1, { collapseCompleted: true })
    expect(rows()[0].querySelector('.wl-summary')).toBeTruthy()
    act(() => rows()[0].querySelector('.wl-summary').click())
    drop(rows()[0], rows()[2])
    expect(rows()[2].dataset.workoutUnit).toBe('a')
    expect(rows()[2].querySelector('.wl-summary')).toBeNull()
    expect(rows()[2].querySelector('[aria-expanded="true"]')).toBeTruthy()
    const fold = rows()[2].querySelector('[aria-expanded="true"]')
    pointer(fold, 'pointerdown'); pointer(fold, 'pointerup')
    act(() => fold.click())
    expect(rows()[2].querySelector('.wl-summary')).toBeTruthy()
  })

  it('upgrades duplicate/missing ids before dragging', () => {
    mount([entry('repeated'), entry('repeated'), entry(undefined)])
    expect(new Set(order()).size).toBe(3)
    expect(order()[0]).toBe('repeated')
    expect(order().every(Boolean)).toBe(true)
    expect(JSON.parse(localStorage.getItem('gym_state_v1')).active.entries.map(e => e.occurrenceId)).toEqual(order())
    const before = order()
    drop(rows()[1], rows()[2])
    expect(order()).toEqual([before[0], before[2], before[1]])
  })

  it('does not migrate or reorder an editor of a saved workout', () => {
    mount([entry(undefined), entry(undefined)], 'list', 0, { editingWorkoutId: 'history' })
    expect(order()).toEqual([undefined, undefined])
    lift(rows()[0]); noDrag()
    pointer(document, 'pointerup', { y: 600 })
    expect(order()).toEqual([undefined, undefined])
  })

  it('autoscrolls a nested host after lift, follows the pointer and cancels its frames', () => {
    mount()
    host.style.overflowY = 'auto'
    Object.defineProperty(host, 'scrollHeight', { value: 2200, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true })
    host.scrollTop = 100
    lift(rows()[0])
    pointer(document, 'pointermove', { y: 590 })
    act(() => vi.advanceTimersByTime(64))
    expect(host.scrollTop).toBeGreaterThan(100)
    pointer(document, 'pointercancel', { y: 590 })
    const stopped = host.scrollTop
    act(() => vi.advanceTimersByTime(200))
    expect(host.scrollTop).toBe(stopped)
    noDrag()
  })

  it.each([false, true])('keeps a timed set bound to its occurrence while sorting (restored: %s)', restore => {
    mount([entry('timed', { target: { mode: 'time', sec: 45, sets: 1 }, sets: [{ w: 0, sec: 45, done: false }] }), entry('bb'), entry('ccc')], 'list', 0)
    act(() => host.querySelector('[aria-label="Start set"]').click())
    if (restore) {
      const saved = localStorage.getItem('gym_work')
      act(() => root.unmount()); host.remove(); root = null
      useUI.getState().stopWork(); localStorage.setItem('gym_work', saved)
      act(() => { expect(restoreWork()).toBe(true) }); render()
    }
    const before = clone(useUI.getState().work), start = active().start
    drop(rows()[0], rows()[2])
    expect(useUI.getState().work).toEqual({ ...before, owner: { ...before.owner, idx: 2 } })
    expect(JSON.parse(localStorage.getItem('gym_work')).owner.idx).toBe(2)
    expect(active().start).toBe(start)
    act(() => useUI.getState().finishWorkEarly())
    expect(active().entries[2].sets[0].done).toBe(true)
    expect(active().entries[0].sets[0].done).toBe(false)
    expect(active().entries[1].sets[0].done).toBe(false)
  })

  it('leaves controls, short taps and scrolling independent of drag', () => {
    mount()
    for (const target of rows()[0].querySelectorAll('button,input,.swrow')) {
      pointer(target, 'pointerdown'); act(() => vi.advanceTimersByTime(380))
      noDrag(); pointer(document, 'pointerup')
    }
    const r = rows()[0], y = r.getBoundingClientRect().top + 20
    pointer(r, 'pointerdown', { y }); pointer(document, 'pointermove', { y: y + 9 })
    act(() => vi.advanceTimersByTime(380)); noDrag()
    pointer(document, 'pointerup', { y: y + 9 })
    act(() => r.querySelector('[role="checkbox"]').click())
    expect(active().entries[0].sets[0].done).toBe(true)
  })

  it.each(['pointercancel', 'lostpointercapture', 'Escape', 'blur', 'second-pointer', 'state-change'])('cancels %s without writing or leaving drag UI', reason => {
    mount(); const before = order()
    lift(rows()[0]); expect(host.querySelector('.is-dragging')).toBeTruthy()
    if (reason === 'Escape') act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    else if (reason === 'blur') act(() => window.dispatchEvent(new Event('blur')))
    else if (reason === 'second-pointer') pointer(document, 'pointerdown', { id: 8, primary: false })
    else if (reason === 'state-change') act(() => useStore.getState().update(s => { s.active.entries[0].note = 'Changed' }, false))
    else pointer(document, reason)
    pointer(document, 'pointerup', { y: 600 })
    noDrag(); expect(order()).toEqual(before)
  })

  it.each([320, 360, 430])('sorts unequal-height cards at %s px and leaves no duplicate or placeholder', viewport => {
    width = viewport; mount()
    drop(rows()[1], rows()[0], false)
    expect(order()).toEqual(['bb', 'a', 'ccc'])
    expect(rows()).toHaveLength(3)
    expect(new Set(rows().map(r => r.dataset.workoutUnit)).size).toBe(3)
    noDrag()
  })
})
