// @vitest-environment happy-dom
// A15: with the keyboard up, the Coach thread must keep its own scroll area instead of the
// page being lifted. These pin the layout contract the component applies, the scoping of the
// auto-follow to the thread, and that nothing accumulates across repeated keyboard toggles.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CoachChat from './CoachChat.jsx'
import { CONSENT_VERSION } from '../lib/coach.js'
import { NATIVE_KEYBOARD_EVENT } from '../lib/native-keyboard.js'

const mocks = vi.hoisted(() => {
  const state = { S: null, pending: null, job: null, maxMessageLen: 2200, nav: vi.fn(), toast: vi.fn(), openSheet: vi.fn(), refresh: vi.fn() }
  state.storeSnapshot = () => ({ S: state.S, user: { id: 'u1' }, ready: true,
    config: { coach: { enabled: true } }, coachLocal: null, update: mut => mut(state.S) })
  state.uiSnapshot = () => ({ toast: state.toast, openSheet: state.openSheet })
  return state
})

vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector(mocks.storeSnapshot())
  useStore.getState = mocks.storeSnapshot
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const useUI = selector => selector ? selector(mocks.uiSnapshot()) : mocks.uiSnapshot()
  useUI.getState = mocks.uiSnapshot
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav }))
vi.mock('../lib/coach-api.js', () => ({
  useCoachStatus: () => ({ pending: mocks.pending, job: mocks.job, cap: null, loading: false, lastError: null, last: null, refresh: mocks.refresh, maxMessageLen: mocks.maxMessageLen }),
  resolvePending: vi.fn(() => Promise.resolve({})),
  refinePlan: vi.fn(() => Promise.resolve({})),
  requestReview: vi.fn(() => Promise.resolve({})),
  requestDebrief: vi.fn(() => Promise.resolve({})),
  cohortStats: vi.fn(() => Promise.resolve({ ok: false, enabled: true, sharing: false })),
  setCohortShare: vi.fn(() => Promise.resolve({ ok: true })),
  JOB_ERRORS: { internal: 'x' },
  awaitedJob: () => null,
  settleAwaited: vi.fn(),
}))
vi.mock('../sheets.jsx', () => ({ startFlow: vi.fn(), confirmSheet: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})), IS_APPLE: false, IS_ANDROID: false, BIO: 'biometrics' }))
vi.mock('../coach.css', () => ({}))

const chat = () => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [], bodyweight: [], exWeights: {}, dayPlan: {}, routines: [], week: {},
  coach: { consent: { agreedAt: '2026-07-01T00:00:00Z', version: CONSENT_VERSION },
    profile: { goal: 'muscle', experience: 'new', daysPerWeek: 3, sessionMin: 60, preferredDays: [1], equipment: [] },
    log: [], snapshots: [], timings: [],
    chat: Array.from({ length: 40 }, (_, i) => ({ id: 'c' + i, role: i % 2 ? 'coach' : 'user', kind: 'text', text: 'line ' + i, at: i })) },
})

let dom, root, container, scrollY
function installDom() {
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
  dom = parsed.window
  globalThis.window = dom
  globalThis.document = dom.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.navigator })
  for (const key of ['HTMLElement', 'Node', 'Element', 'Event', 'CustomEvent', 'Blob']) globalThis[key] = dom[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  scrollY = 0
  Object.defineProperty(dom, 'innerHeight', { configurable: true, writable: true, value: 900 })
  dom.scrollTo = vi.fn((x, y) => { scrollY = y || 0 })
  container = document.getElementById('root')
  root = createRoot(container)
}

function keyboard(px, { visualHeight = 900, offsetTop = 0 } = {}) {
  document.documentElement.style.setProperty('--native-kb', px + 'px')
  if (px > 0) document.documentElement.setAttribute('data-native-kb', '')
  else document.documentElement.removeAttribute('data-native-kb')
  window.visualViewport = { height: visualHeight, offsetTop, addEventListener() {}, removeEventListener() {} }
  window.dispatchEvent(new dom.CustomEvent(NATIVE_KEYBOARD_EVENT, { detail: { height: px } }))
}

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

async function mount(S = chat()) {
  mocks.S = S
  installDom()
  await act(async () => { root.render(React.createElement(CoachChat)) })
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(async () => {
  if (root) { await act(async () => { root.unmount() }); root = null }
  container = null; dom = null
})

describe('the Coach thread while the keyboard is up', () => {
  it('gives the thread one known height and lifts the composer out of the keyboard’s way', async () => {
    await mount()
    const el = container.querySelector('.chat')
    expect(el.classList.contains('kb')).toBe(false)

    keyboard(300)
    await flush()
    expect(el.classList.contains('kb')).toBe(true)
    expect(el.style.getPropertyValue('--chat-h')).toBe('600px')   // 900 - 300, from the page top
    expect(document.body.classList.contains('chat-kb')).toBe(true)

    keyboard(0)
    await flush()
    expect(el.classList.contains('kb')).toBe(false)
    expect(document.body.classList.contains('chat-kb')).toBe(false)
  })

  it('reads the visual viewport too (iOS, older Android: no native variable)', async () => {
    await mount()
    const el = container.querySelector('.chat')
    keyboard(0, { visualHeight: 500 })
    await flush()
    expect(el.classList.contains('kb')).toBe(true)
    expect(el.style.getPropertyValue('--chat-h')).toBe('500px')
  })

  it('follows new messages inside the thread, and leaves a reader in history where they were', async () => {
    const S = chat()
    await mount(S)
    const msgs = container.querySelector('.msgs')
    Object.defineProperty(msgs, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(msgs, 'clientHeight', { configurable: true, value: 400 })
    keyboard(300)
    await flush()

    msgs.scrollTop = 0
    await act(async () => { msgs.dispatchEvent(new dom.Event('scroll', { bubbles: false })) })
    S.coach.chat.push({ id: 'later', role: 'coach', kind: 'text', text: 'reply', at: 99 })
    await act(async () => { root.render(React.createElement(CoachChat)) })
    expect(msgs.scrollTop).toBe(0)            // reading history: the anchor holds

    msgs.scrollTop = 600                      // 1000 - 400: at the end
    await act(async () => { msgs.dispatchEvent(new dom.Event('scroll', { bubbles: false })) })
    S.coach.chat.push({ id: 'later2', role: 'coach', kind: 'text', text: 'reply 2', at: 100 })
    await act(async () => { root.render(React.createElement(CoachChat)) })
    expect(msgs.scrollTop).toBe(1000)         // at the end: follow, and only the thread moves
    expect(scrollY).toBe(0)
  })

  it('never accumulates a page offset across twenty keyboard toggles', async () => {
    await mount()
    const el = container.querySelector('.chat')
    const scrolled = dom.scrollTo.mock.calls.length
    for (let i = 0; i < 20; i++) {
      keyboard(300)
      await flush()
      keyboard(0)
      await flush()
    }
    expect(el.classList.contains('kb')).toBe(false)
    expect(document.body.classList.contains('chat-kb')).toBe(false)
    expect(scrollY).toBe(0)
    // Only the one-off pin when entering the mode; the page is never scrolled while in it.
    expect(dom.scrollTo.mock.calls.length - scrolled).toBe(20)   // the one-off pin, once per entry
  })

  it('keeps the draft and the same composer across a keyboard cycle', async () => {
    await mount()
    const before = container.querySelector('.composer textarea')
    keyboard(300)
    await flush()
    expect(container.querySelector('.composer textarea')).toBe(before)
    keyboard(0)
    await flush()
    expect(container.querySelector('.composer textarea')).toBe(before)
  })
})
