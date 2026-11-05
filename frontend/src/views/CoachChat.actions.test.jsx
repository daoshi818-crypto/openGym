// @vitest-environment happy-dom
// Render the real conversation/card and use the real validator + template application.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ status: null, confirms: [], sheets: [], toast: vi.fn(), refresh: vi.fn(),
  chat: vi.fn(), proof: vi.fn(), resolve: vi.fn(), refine: vi.fn() }))
vi.mock('../store/useStore.js', async () => {
  const { create } = await import('zustand')
  return { useStore: create(() => ({})) }
})
vi.mock('../store/useUI.js', () => {
  const snap = { toast: m.toast, openSheet: render => m.sheets.push(render), coachDebriefIntent: null }
  const useUI = select => select(snap)
  useUI.getState = () => snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../lib/coach-api.js', () => ({
  useCoachStatus: () => m.status, chatCoach: (...args) => m.chat(...args),
  coachStatus: () => m.proof(), coachRuntimeIdentity: () => 'server|render-test',
  resolvePending: (...args) => m.resolve(...args), refinePlan: (...args) => m.refine(...args),
  requestReview: vi.fn(), requestDebrief: vi.fn(), requestPlan: vi.fn(), cohortStats: vi.fn(), setCohortShare: vi.fn(),
  jobErrorText: (_, text) => text, awaitedJob: () => null, settleAwaited: vi.fn(), JOB_ERRORS: {},
}))
vi.mock('../lib/coach.js', async importOriginal => ({ ...(await importOriginal()), hasConsent: () => true }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: options => m.confirms.push(options), workoutDetailSheet: vi.fn() }))
vi.mock('../components/Icon.jsx', () => ({ default: () => null }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false }))
vi.mock('../lib/demo.js', () => ({ DEMO: false }))
import { useStore } from '../store/useStore.js'
import { canonicalPlan, planHash } from '../lib/coach.js'
import { coachContext } from '../../../api/coach/core/context.js'
import { validateChat } from '../../../api/coach/core/chat.js'
import CoachChat from './CoachChat.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host, root
const state = () => ({ unit: 'kg', customEx: [], bodyweight: [], week: {}, dayPlan: {},
  routines: [{ id: 'back', name: 'Back day', ex: [{ id: '0001', mode: 'reps', sets: 4, reps: 8 }] }],
  workouts: [], active: { watchSid: 'active', entries: [{ id: '0001', sets: Array.from({ length: 4 }, () => ({ w: 40, r: 8 })) }] },
  coach: { profile: {}, chat: [], outbox: [] } })
function proposal(s, revision = 1, after = 3) {
  const result = validateChat({ coach_contract: 1, chat_actions_contract: 1, replyType: 'proposal',
    answer: 'Here is the adjustment', summary: 'Adjust sets', targetRoutineId: 'back',
    changes: [{ id: 'c', type: 'sets', target: { routineId: 'back', exId: '0001' }, after, why: 'User request' }], notes: [] }, canonicalPlan(s))
  expect(result.ok).toBe(true)
  return { ...result.proposal, kind: 'review', source: 'chat', id: 'p-render', revision, runtimeIdentity: 'server|render-test',
    scope: { kind: 'routine', routineId: 'back' }, expiresAt: Date.now() + 60000, planHash: planHash(s), context: coachContext(s, planHash(s)) }
}
const buttons = () => [...host.querySelectorAll('button')]
const button = text => buttons().find(el => el.textContent === text)
const render = () => act(async () => { root.render(<CoachChat />) })
const click = el => act(async () => { expect(el).toBeTruthy(); el.click() })
async function send(text) {
  const input = host.querySelector('textarea')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(host.querySelector('button.send'))
}
beforeEach(() => {
  vi.clearAllMocks(); m.confirms.length = 0; m.sheets.length = 0
  m.status = { job: null, pending: null, loading: false, isStale: false, refresh: m.refresh }
  m.chat.mockResolvedValue({}); m.resolve.mockResolvedValue({})
  m.proof.mockImplementation(async () => ({ pending: structuredClone(m.status.pending), job: null, runtimeIdentity: 'server|render-test' }))
  useStore.setState({ S: state(), ready: true, user: { id: 'user' }, config: { coach: { enabled: true } }, coachLocal: null,
    update: mutate => useStore.setState(({ S }) => { const next = structuredClone(S); mutate(next); return { S: next } }) })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('rendered Coach ordinary-chat actions', () => {
  it('ordinary text uses chat API with the real pending revision/scope, never writes a template', async () => {
    m.status.pending = proposal(useStore.getState().S, 2)
    await render(); await send('Could you reduce the number of sets?')
    expect(m.chat).toHaveBeenCalledWith('Could you reduce the number of sets?', { proposalRef: { id: 'p-render', revision: 2 }, scope: { kind: 'routine', routineId: 'back' } })
    expect(m.refine).not.toHaveBeenCalled()
    expect(useStore.getState().S.routines[0].ex[0].sets).toBe(4)
  })
  it('text apply command opens confirmation only; confirm shares real apply path and isolates active training', async () => {
    m.status.pending = proposal(useStore.getState().S)
    await render(); await send('按这个改')
    expect(m.confirms).toHaveLength(1); expect(m.chat).not.toHaveBeenCalled(); expect(m.proof).not.toHaveBeenCalled()
    expect(useStore.getState().S.routines[0].ex[0].sets).toBe(4) // cancel/no callback: unchanged
    await act(async () => { m.confirms[0].onConfirm(); await Promise.resolve() })
    expect(m.proof).toHaveBeenCalledOnce()
    const s = useStore.getState().S
    expect(s.routines[0].ex[0].sets).toBe(3); expect(s.active.entries[0].sets).toHaveLength(4)
    expect(s.coach.log).toHaveLength(1); expect(s.coach.outbox).toHaveLength(0)
    expect(m.resolve).toHaveBeenCalledWith(expect.objectContaining({ proposalId: 'p-render', revision: 1 }))
  })
  it('fresh status failure cannot report success or change anything', async () => {
    m.status.pending = proposal(useStore.getState().S); m.proof.mockRejectedValue(new Error('offline-status'))
    await render(); await click(button('Apply 1 change'))
    expect(useStore.getState().S.routines[0].ex[0].sets).toBe(4)
    expect(useStore.getState().S.coach.log).toBeUndefined(); expect(m.resolve).not.toHaveBeenCalled()
    expect(m.toast).toHaveBeenCalledWith('offline-status'); expect(m.toast).not.toHaveBeenCalledWith('1 change applied')
  })
  it('a new revision resets checkbox selection and applies only the displayed revision', async () => {
    m.status.pending = proposal(useStore.getState().S)
    await render(); await click(host.querySelector('[role=checkbox]'))
    expect(button('Apply nothing').disabled).toBe(true)
    m.status.pending = proposal(useStore.getState().S, 2, 2); await render()
    expect(host.querySelector('[role=checkbox]').getAttribute('aria-checked')).toBe('true')
    await click(button('Apply 1 change'))
    expect(useStore.getState().S.routines[0].ex[0].sets).toBe(2)
    expect(m.resolve).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }))
  })
  it('a delayed confirmation for an older revision cannot apply it', async () => {
    m.status.pending = proposal(useStore.getState().S)
    await render(); await send('按这个改')
    m.status.pending = proposal(useStore.getState().S, 2, 2); await render()
    await act(async () => { m.confirms[0].onConfirm(); await Promise.resolve() })
    expect(useStore.getState().S.routines[0].ex[0].sets).toBe(4)
    expect(m.resolve).not.toHaveBeenCalled()
  })
  it('resolve failure retains a durable outbox; another click cannot apply twice', async () => {
    m.resolve.mockRejectedValue(new Error('offline-resolve')); m.status.pending = proposal(useStore.getState().S)
    await render(); await click(button('Apply 1 change'))
    const s = useStore.getState().S
    expect(s.routines[0].ex[0].sets).toBe(3); expect(s.coach.outbox).toHaveLength(1)
    expect(m.toast).toHaveBeenCalledWith('Your decision is saved on this device. Confirmation will retry when the Coach reconnects.')
    // The old card is stale after local application. No second write is possible.
    expect(button('Apply 1 change').disabled).toBe(true)
    await click(button('Apply 1 change'))
    expect(useStore.getState().S.coach.log).toHaveLength(1); expect(useStore.getState().S.coach.snapshots).toHaveLength(1)
  })
  it('historical debrief adjustment binds the selected log, not the latest workout', async () => {
    const s = useStore.getState().S
    s.workouts = [{ id: 'new-workout', d: '2026-11-05', entries: [] }]
    s.coach.log = [{ id: 'selected-old-debrief', kind: 'debrief', at: Date.now() - 86400000, workout: { name: 'Old back day' }, notes: [] }]
    s.coach.chat = [{ id: 'msg', role: 'coach', kind: 'debrief', ref: 'selected-old-debrief' }]
    await render(); await click(host.querySelector('button.recap'))
    expect(m.sheets).toHaveLength(1)
    await act(async () => { root.render(m.sheets[0]()) })
    await click(button('Suggest changes from this debrief'))
    expect(m.chat).toHaveBeenCalledWith('Suggest template adjustments based on this debrief.', { contextRef: { kind: 'debrief', id: 'selected-old-debrief' } })
  })
})
