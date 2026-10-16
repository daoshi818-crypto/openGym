// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import TrainingCalendar from './TrainingCalendar.jsx'

vi.mock('../sheets.jsx', () => ({
  workoutDetailSheet: vi.fn(),
  WorkoutRow: ({ w, onClick }) => <button onClick={onClick}>{w.name}</button>,
}))

const at = (day, hour) => new Date(`${day}T${hour}:00:00`).getTime()
const workout = (id, day, hour, name, muscle) => ({
  id, d: day, start: at(day, hour), end: at(day, hour) + 3600000,
  name, entries: [{ id, exercise: { primaries: [muscle] }, sets: [{ w: 20, r: 10, done: true }] }],
})
const workouts = [
  workout('chest', '2026-10-08', '08', 'Morning chest', 'chest'),
  workout('back', '2026-10-08', '18', 'Evening back', 'upper-back'),
]
let host, root

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T12:00:00'))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })
const render = (S, onWorkout = vi.fn()) => { act(() => root.render(<TrainingCalendar S={S} onWorkout={onWorkout} />)); return onWorkout }
const dayButton = day => host.querySelector(`button[aria-label^="${day}"]`)
const press = label => act(() => host.querySelector(`button[aria-label="${label}"]`).click())

it('shows two sessions on one training day and opens each separately', () => {
  const onWorkout = render({ workouts, unit: 'kg', weekStart: 1 })
  expect([...host.querySelectorAll('.training-calendar-summary strong')].map(node => node.textContent)).toEqual(['1', '2', '2'])
  expect(dayButton('2026-10-08').getAttribute('aria-label')).toContain('Chest')
  act(() => dayButton('2026-10-08').click())
  expect(host.textContent).toContain('Morning chest')
  expect(host.textContent).toContain('Evening back')
  act(() => [...host.querySelectorAll('.training-calendar-details button')].find(node => node.textContent === 'Evening back').click())
  expect(onWorkout).toHaveBeenCalledWith(workouts[1])
})

it('navigates months, returns to today, and shows an empty day clearly', () => {
  render({ workouts, unit: 'kg', weekStart: 1 })
  press('Previous month')
  expect(host.querySelector('.training-calendar-title').textContent).toContain('September')
  press('Next month')
  expect(host.querySelector('.training-calendar-title').textContent).toContain('October')
  act(() => dayButton('2026-10-09').click())
  expect(host.textContent).toContain('No workouts on this day.')
  act(() => [...host.querySelectorAll('.training-calendar-title button')].find(node => node.textContent === 'Today').click())
  expect(dayButton('2026-10-16').getAttribute('aria-pressed')).toBe('true')
})

it('updates when history changes and keeps an unmapped session visible', () => {
  const S = { workouts: [], unit: 'kg', weekStart: 1 }
  render(S)
  expect(host.querySelector('.training-calendar-summary strong').textContent).toBe('0')
  const legacy = { id: 'legacy', d: '2026-10-12', name: 'Old session', entries: [] }
  render({ ...S, workouts: [legacy] })
  expect(host.querySelector('.training-calendar-summary strong').textContent).toBe('1')
  expect(dayButton('2026-10-12').classList.contains('trained')).toBe(true)
  render(S)
  expect(dayButton('2026-10-12').classList.contains('trained')).toBe(false)
})


it('refreshes selected-day details after editing dates, deleting one session and deleting the last', () => {
  const S = { workouts, unit: 'kg', weekStart: 1 }
  render(S)
  act(() => dayButton('2026-10-08').click())
  render({ ...S, workouts: [workouts[1]] })
  expect(host.querySelector('.training-calendar-details').textContent).not.toContain('Morning chest')
  expect(host.querySelector('.training-calendar-details').textContent).toContain('Evening back')
  expect([...host.querySelectorAll('.training-calendar-summary strong')].map(n => n.textContent)).toEqual(['1', '1', '1'])
  const moved = { ...workouts[1], d: '2026-11-01' }
  render({ ...S, workouts: [moved] })
  expect(host.querySelector('.training-calendar-details')).toBeNull()
  expect(host.textContent).toContain('No workouts on this day.')
  press('Next month')
  act(() => dayButton('2026-11-01').click())
  expect(host.textContent).toContain('Evening back')
  render({ ...S, workouts: [] })
  expect(dayButton('2026-11-01').classList.contains('trained')).toBe(false)
  expect(host.querySelector('.training-calendar-details')).toBeNull()
})

it('navigates December and January without losing or double-counting boundary workouts', () => {
  render({ workouts: [workout('dec', '2026-12-31', '08', 'Year end', 'chest'), workout('jan', '2027-01-01', '08', 'New year', 'biceps')], unit: 'kg', weekStart: 1 })
  press('Next month'); press('Next month')
  expect(dayButton('2026-12-31').disabled).toBe(false)
  expect(dayButton('2027-01-01').disabled).toBe(true)
  expect(host.querySelector('.training-calendar-summary strong').textContent).toBe('1')
  press('Next month')
  expect(host.querySelector('h2').textContent).toContain('2027')
  expect(dayButton('2027-01-01').disabled).toBe(false)
  act(() => dayButton('2027-01-01').click())
  expect(host.textContent).toContain('New year')
  expect(host.textContent).not.toContain('Year end')
  press('Previous month')
  expect(host.querySelector('h2').textContent).toContain('December')
})

it('translates muscle names in both compact cells and accessible labels', async () => {
  const { setLang } = await import('../lib/i18n.js')
  await setLang('zh')
  try {
    render({ workouts, unit: 'kg', weekStart: 1 })
    const cell = dayButton('2026-10-08')
    expect(cell.textContent).toContain('胸')
    expect(cell.getAttribute('aria-label')).toContain('胸')
    expect(cell.textContent).not.toContain('Chest')
  } finally { await setLang('en') }
})
