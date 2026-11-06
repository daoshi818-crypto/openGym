// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Stats from './Stats.jsx'

const mocks = vi.hoisted(() => ({ S: null, nav: vi.fn() }))
vi.mock('../store/useStore.js', () => ({ useStore: selector => selector({ S: mocks.S }) }))
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/stats', search: (window.location.hash || '').split('?')[1] || '', state: null }),
  useNavigate: () => mocks.nav }))
vi.mock('../sheets.jsx', () => ({
  bwSheet: vi.fn(), goalSheet: vi.fn(), calendarSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  workoutDetailSheet: vi.fn(), exerciseHistorySheet: vi.fn(), weighInsSheet: vi.fn(),
  WorkoutRow: () => null, bwDeltaColor: () => 'inherit',
}))
vi.mock('../components/Heatmap.jsx', () => ({ default: () => null }))
vi.mock('../components/LineChart.jsx', () => ({ default: () => null }))
vi.mock('../components/BodyMap.jsx', () => ({ default: () => null, BodyMapLegend: () => null }))

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.location.hash = '#/stats'
  mocks.nav.mockClear()
  mocks.S = {
    unit: 'kg', body: 'male', effort: 'none', targetW: null, bodyweight: [], exWeights: {},
    routines: [{ id: 'back', name: 'Back', ex: [{ id: '0001', mode: 'reps', sets: 3, reps: 8 }] }],
    customEx: [], week: { 1: ['back'] }, weekStart: 1, workouts: [],
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.location.hash = ''
})

const buttons = label => [...host.querySelectorAll('button')].filter(el => el.textContent === label)
const click = el => act(() => el.click())
const isVisible = el => !el.closest('[hidden]')

describe('Stats report placement', () => {
  it.each([false, true])('keeps one report action inside Trends, not above the tabs (has history: %s)', hasHistory => {
    if (hasHistory) mocks.S.workouts = [{
      id: 'logged', d: '2026-11-05', start: Date.parse('2026-11-05T10:00:00Z'),
      end: Date.parse('2026-11-05T10:30:00Z'), name: 'Back',
      entries: [{ id: '0001', target: { mode: 'reps', sets: 3, reps: 8 }, sets: [{ w: 40, r: 8, done: true }] }],
    }]
    const original = structuredClone(mocks.S)
    act(() => root.render(<Stats />))
    expect(host.querySelector('.hdr').nextElementSibling.classList.contains('seg')).toBe(true)
    expect([...host.querySelectorAll('.card-head-title')].filter(el => el.textContent === 'Weekly sets per muscle')).toHaveLength(1)
    const reports = buttons('Performance report')
    expect(reports).toHaveLength(1)
    expect(buttons('Training calendar')[0].getAttribute('aria-pressed')).toBe('true')
    expect(reports.filter(isVisible)).toHaveLength(0)
    expect(isVisible(host.querySelector('[data-training-calendar]'))).toBe(true)

    click(buttons('Trends')[0])
    expect(buttons('Performance report')).toHaveLength(1)
    expect(isVisible(reports[0])).toBe(true)
    expect(isVisible(host.querySelector('[data-training-calendar]'))).toBe(false)
    mocks.nav.mockClear()
    click(reports[0])
    expect(mocks.nav).toHaveBeenCalledExactlyOnceWith('/reports')

    click(buttons('Training calendar')[0])
    expect(reports.filter(isVisible)).toHaveLength(0)
    expect(mocks.S).toEqual(original)
  })

  it('does not introduce a standalone report action when there are no plans or workouts', () => {
    mocks.S.routines = []
    mocks.S.week = {}
    act(() => root.render(<Stats />))
    expect(buttons('Performance report')).toHaveLength(0)
    expect(isVisible(host.querySelector('[data-training-calendar]'))).toBe(true)
    click(buttons('Trends')[0])
    expect(buttons('Performance report')).toHaveLength(0)
  })
})
