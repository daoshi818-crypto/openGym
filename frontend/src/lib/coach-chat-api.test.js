import { beforeEach, describe, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ store: { S: { routines: [] }, coachLocal: { mode: 'server' }, sync: { server: 'https://example.test' }, user: { id: 'u1' } }, api: vi.fn() }))
vi.mock('./api.js', () => ({ api: env.api }))
vi.mock('./mobile.js', () => ({ MOBILE: true }))
vi.mock('./demo.js', () => ({ DEMO: false }))
vi.mock('../store/useStore.js', () => ({ useStore: { getState: () => env.store } }))
vi.mock('../store/useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))
vi.mock('./i18n.js', () => ({ t: x => x, tn: x => x, getLang: () => 'zh' }))
vi.mock('./coach-context.js', () => ({ todayForCoach: () => ({ date: '2026-11-05' }) }))
let client
beforeEach(async () => {
  vi.resetModules(); env.api.mockReset(); env.store.user = { id: 'u1' }; env.store.coachLocal = { mode: 'server' }
  client = await import('./coach-api.js')
})
describe('chat client capability, identity and explicit retries', () => {
  it('uses chat with version and stable proposal reference, never ask', async () => {
    env.api.mockResolvedValueOnce({ chatActionsVersion: 1 }).mockResolvedValueOnce({ job: { id: 'j1' } })
    await client.chatCoach('少一组', { proposalRef: { id: 'p1', revision: 2 }, scope: { kind: 'routine', routineId: 'r1' } })
    expect(env.api.mock.calls[0][0]).toBe('/api/coach/status?chatActionsVersion=1')
    expect(env.api.mock.calls[1][0]).toBe('/api/coach/chat')
    const body = JSON.parse(env.api.mock.calls[1][1].body)
    expect(body.chatActionsVersion).toBe(1); expect(body.proposalRef.revision).toBe(2); expect(body.clientRequestId).toBeTruthy()
    expect(client.awaitedJob()).toBe('j1')
  })
  it('falls back visibly only for an old backend that declared no chat capability', async () => {
    env.api.mockResolvedValueOnce({}).mockResolvedValueOnce({ job: { id: 'old' } })
    expect((await client.chatCoach('问题')).readOnly).toBe(true)
    expect(env.api.mock.calls[1][0]).toBe('/api/coach/ask')
  })
  it.each([{ chatActionsVersion: 2 }, { chatActionsVersion: 1, upgradeRequired: true }])('blocks declared incompatible capability %s', async status => {
    env.api.mockResolvedValueOnce(status)
    await expect(client.chatCoach('调整')).rejects.toThrow()
    expect(env.api).toHaveBeenCalledTimes(1)
  })
  it('does not call ask after a failed capability check or failed chat POST', async () => {
    env.api.mockRejectedValueOnce(new Error('offline'))
    await expect(client.chatCoach('问题')).rejects.toThrow('offline'); expect(env.api).toHaveBeenCalledTimes(1)
    env.api.mockReset().mockResolvedValueOnce({ chatActionsVersion: 1 }).mockRejectedValueOnce(new Error('500'))
    await expect(client.chatCoach('问题')).rejects.toThrow('500'); expect(env.api).toHaveBeenCalledTimes(2)
    expect(env.api.mock.calls.every(c => !c[0].endsWith('/ask'))).toBe(true)
  })
  it('reuses an ambiguous POST id on explicit retry, not on a new message', async () => {
    env.api.mockImplementation(async path => path.includes('/status') ? { chatActionsVersion: 1 } : Promise.reject(new Error('timeout')))
    await expect(client.chatCoach('调整')).rejects.toThrow(); await expect(client.chatCoach('调整')).rejects.toThrow(); await expect(client.chatCoach('其他')).rejects.toThrow()
    const ids = env.api.mock.calls.filter(c => c[0].endsWith('/chat')).map(c => JSON.parse(c[1].body).clientRequestId)
    expect(ids[0]).toBe(ids[1]); expect(ids[2]).not.toBe(ids[1])
  })
  it('rejects a response from a different account before sending a mutation request', async () => {
    env.api.mockImplementationOnce(async () => { env.store.user = { id: 'other' }; return { chatActionsVersion: 1 } })
    await expect(client.chatCoach('调整')).rejects.toThrow('account changed'); expect(env.api).toHaveBeenCalledTimes(1)
  })
  it('decorates fresh pending proof with runtime and origin identities', async () => {
    env.api.mockResolvedValue({ pending: { id: 'p1' }, chatActionsVersion: 1 })
    const s = await client.coachStatus()
    expect(s.pending.runtimeIdentity).toBe(s.runtimeIdentity); expect(s.runtimeIdentity).toBe(client.coachRuntimeIdentity()); expect(s.pending.originIdentity).toBeTruthy()
  })
})
