// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Stats from './Stats.jsx'
import StructuralBalance from './StructuralBalance.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { setLang } from '../lib/i18n.js'
vi.mock('../sheets.jsx', () => ({
  bwSheet: vi.fn(), goalSheet: vi.fn(), calendarSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  workoutDetailSheet: vi.fn(), exerciseHistorySheet: vi.fn(), weighInsSheet: vi.fn(),
  exercisePicker: vi.fn(), WorkoutRow: () => null, bwDeltaColor: () => 'inherit',
}))
vi.mock('../components/Heatmap.jsx', () => ({ default: () => null }))
vi.mock('../components/LineChart.jsx', () => ({ default: () => null }))
vi.mock('../components/BodyMap.jsx', () => ({ default: () => null, BodyMapLegend: () => null }))
let root, host, router
const button = label => [...host.querySelectorAll('button')].find(b => b.textContent === label)
const click = async el => { expect(el).toBeTruthy(); await act(async () => el.click()) }
const openBalance = () => click([...host.querySelectorAll('h2')].find(h => h.textContent === 'Structural balance').closest('.card').querySelector('button'))
const expectTrends = () => {
  expect(button('Trends').getAttribute('aria-pressed')).toBe('true')
  expect(host.querySelector('[data-training-calendar]').closest('[hidden]')).toBeTruthy()
  expect(button('Performance report').closest('[hidden]')).toBeNull()
}
async function render(entry = '/stats') {
  router = createMemoryRouter([{ path: '/stats', element: <Stats /> }, { path: '/structural-balance', element: <StructuralBalance /> }], { initialEntries: [entry] })
  await act(async () => root.render(<RouterProvider router={router} />))
}
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear(); await setLang('en')
  const S = structuredClone(DEF)
  S.workouts = [{ id: 'test', d: '2026-11-06', start: Date.now(), entries: [{ id: '0030', sets: [{ w: 100, r: 1, done: true }] }] }]
  useStore.setState({ S, user: null }); useUI.setState({ sheets: [] })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); router?.dispose() })
describe('Stats tab navigation with a real router', () => {
  it.each(['chevron', 'system back'])('returns from Structural balance to Trends with %s', async method => {
    await render(); const original = structuredClone(useStore.getState().S)
    await click(button('Trends'))
    expect(router.state.location.search).toBe('?view=trends')
    await openBalance(); expect(router.state.location.pathname).toBe('/structural-balance')
    if (method === 'chevron') await click(host.querySelector('button[aria-label="Stats"]'))
    else await act(async () => router.navigate(-1))
    expect(router.state.location.pathname).toBe('/stats'); expectTrends()
    expect(useStore.getState().S).toEqual(original)
  })
  it('restores Trends on reload/deep link and follows external query changes', async () => {
    await render('/stats?view=trends'); expectTrends()
    await act(async () => router.navigate('/stats?view=calendar'))
    expect(button('Training calendar').getAttribute('aria-pressed')).toBe('true')
    await act(async () => router.navigate('/stats?view=trends')); expectTrends()
  })
  it('opens weekly volume in Trends and clears focus on calendar selection', async () => {
    await render('/stats?focus=weekly-volume'); expectTrends()
    await click(button('Training calendar'))
    expect(router.state.location.search).not.toContain('focus=')
    expect(button('Training calendar').getAttribute('aria-pressed')).toBe('true')
  })
  it('falls back to Trends when Structural balance was opened directly', async () => {
    await render('/structural-balance'); await click(host.querySelector('button[aria-label="Stats"]'))
    expect(router.state.location.pathname).toBe('/stats'); expectTrends()
  })
  it('replaces tab switches rather than adding back-stack entries', async () => {
    await render(); await click(button('Trends')); await click(button('Training calendar')); await click(button('Trends'))
    await openBalance(); await click(host.querySelector('button[aria-label="Stats"]')); expectTrends()
    await act(async () => router.navigate(-1)); expectTrends()
  })
})
