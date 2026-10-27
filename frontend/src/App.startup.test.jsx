// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.jsx'
import { DEF, useStore } from './store/useStore.js'

vi.mock('./lib/sound.js', () => ({ setPlayOnSilent: vi.fn(), setVibrate: vi.fn(), setAlarmBuzzer: vi.fn() }))
vi.mock('./lib/api.js', async importOriginal => ({
  ...await importOriginal(), api: vi.fn(() => Promise.resolve({})), beacon: vi.fn(),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host, root, original, guest
beforeEach(() => {
  original = useStore.getState()
  guest = localStorage.getItem('gym_guest')
  localStorage.setItem('gym_guest', '1')
  window.location.hash = '#/home'
  window.scrollTo = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // Exercise the real shell after hydration, not the unauthenticated loading screen.
  useStore.setState({
    S: { ...structuredClone(DEF), lang: 'en', seasonal: { halloween: 'off' } },
    user: null, ready: true, needsMobileOnboarding: false, boot: vi.fn(),
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useStore.setState(original, true)
  if (guest === null) localStorage.removeItem('gym_guest')
  else localStorage.setItem('gym_guest', guest)
  vi.restoreAllMocks()
})

describe('app startup after hydration', () => {
  it('renders the home screen of an existing local profile', async () => {
    await act(async () => { root.render(<App />) })
    expect(host.querySelector('#app')?.textContent).toContain('openGym')
    expect(host.textContent).not.toContain('This screen could not be drawn')
  })

  it('renders after first-launch onboarding finishes', async () => {
    useStore.setState({ needsMobileOnboarding: true })
    await act(async () => { root.render(<App />) })
    expect(host.textContent).toContain('How do you want to use openGym?')
    await act(async () => { useStore.setState({ needsMobileOnboarding: false }) })
    expect(host.querySelector('#app')?.textContent).toContain('openGym')
    expect(host.textContent).not.toContain('This screen could not be drawn')
  })
})
