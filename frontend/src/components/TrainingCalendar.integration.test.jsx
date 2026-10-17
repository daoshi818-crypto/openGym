// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import TrainingCalendar from './TrainingCalendar.jsx'

let host, root
const stamp = new Date('2026-10-08T08:00:00').getTime()
const record = (id, muscle) => ({ id, d: '2026-10-08', name: id, start: stamp, end: stamp + 3600000, vol: 1,
  entries: [{ id: 'custom-' + id, muscleWeights: { [muscle]: 1 }, sets: [{ w: 20, r: 10, done: true }] }], prs: [] })
function CalendarFromStore() { const S = useStore(s => s.S); return <TrainingCalendar S={S} /> }
const clickDay = day => act(() => host.querySelector('button[aria-label^="' + day + '"]').click())
const summary = () => [...host.querySelectorAll('.training-calendar-summary strong')].map(el => el.textContent)
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T12:00:00'))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  useStore.setState(s => ({ S: { ...s.S, routines: [], workouts: [record('Morning', 'chest'), record('Evening', 'biceps')] } }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); useUI.setState({ sheets: [] }); vi.useRealTimers() })

it('keeps the saved training topic while refreshing real WorkoutRows via store.update', () => {
  act(() => root.render(<CalendarFromStore />))
  clickDay('2026-10-08')
  expect(summary()).toEqual(['1', '2', '2'])
  expect(host.querySelectorAll('.training-calendar-details .item')).toHaveLength(2)
  act(() => useStore.getState().update(s => {
    s.workouts[0].entries[0].muscleWeights = { triceps: 1 }
    s.workouts[0].entries[0].sets[0].w = 40
  }, false))
  expect(host.querySelector('.training-calendar-chips').textContent).toContain('Morning')
  expect(host.querySelector('.training-calendar-chips').textContent).not.toContain('Triceps')
  expect(host.querySelector('.training-calendar-details').textContent).toContain('600 kg')
  act(() => useStore.getState().update(s => { s.workouts = s.workouts.filter(w => w.id !== 'Morning') }, false))
  expect(summary()).toEqual(['1', '1', '1'])
  expect(host.querySelectorAll('.training-calendar-details .item')).toHaveLength(1)
  act(() => useStore.getState().update(s => { s.workouts[0].d = '2026-11-01' }, false))
  expect(summary()).toEqual(['0', '0', '0'])
  expect(host.textContent).toContain('No workouts on this day.')
})

it('renders a date-only legacy record using the real shared row', () => {
  useStore.setState(s => ({ S: { ...s.S, workouts: [{ id: 'legacy', d: '2026-10-08', name: 'Imported legacy', vol: 150 }] } }))
  act(() => root.render(<CalendarFromStore />))
  clickDay('2026-10-08')
  expect(host.querySelector('.training-calendar-details').textContent).toContain('Imported legacy')
  expect(host.querySelector('.training-calendar-details').textContent).toContain('150 kg')
  expect(summary()).toEqual(['1', '1', '1'])
  act(() => host.querySelector('.training-calendar-details .item').click())
  const sheet = useUI.getState().sheets.at(-1)
  expect(sheet).toBeTruthy()
  const detailHost = document.createElement('div')
  const detailRoot = createRoot(detailHost)
  try {
    act(() => detailRoot.render(sheet.render(() => {})))
    expect(detailHost.textContent).toContain('Imported legacy')
  } finally { act(() => detailRoot.unmount()) }
})
