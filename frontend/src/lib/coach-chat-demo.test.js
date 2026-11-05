import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { planHash, applyChangeSet } from './coach.js'
import * as demo from './coach-demo.js'
const state = () => ({ unit: 'kg', routines: [{ id: 'r1', name: 'Back', ex: [{ id: '0001', mode: 'reps', sets: 4, reps: 8 }] }], week: {}, workouts: [], customEx: [], coach: { profile: null } })
beforeEach(() => { vi.useFakeTimers(); demo.demoResolve() })
afterEach(() => { demo.demoResolve(); vi.useRealTimers() })
it('demo scoped chat generates a validated sample, preserves template until apply and deduplicates', async () => {
  const s = state(), hash = planHash(s), body = { text: 'sample', clientRequestId: 'demo-' + Date.now(), scope: { kind: 'routine', routineId: 'r1' } }
  const first = demo.demoChat(s, body), retry = demo.demoChat(s, body)
  expect(first.job.id).toBe(retry.job.id)
  await vi.advanceTimersByTimeAsync(2300)
  const status = demo.demoStatus(), p = { ...status.pending, runtimeIdentity: 'demo' }
  expect(p.source).toBe('chat'); expect(p.kind).toBe('review'); expect(planHash(s)).toBe(hash)
  const result = applyChangeSet(s, p, p.changes.map(c => c.id), { ...status, pending: p, runtimeIdentity: 'demo', currentRuntimeIdentity: 'demo' })
  expect(result.applied).toBe(1); expect(s.routines[0].ex[0].sets).toBe(5)
  expect(() => demo.demoResolve({ proposalId: p.id, accepted: ['chat-c1'], revision: 2 })).toThrow('pending_mismatch')
  demo.demoResolve({ proposalId: p.id, accepted: ['chat-c1'], revision: 1 })
  expect(demo.demoStatus().pending).toBeNull()
})
it('demo without explicit scope only clarifies, never interprets text as authorization', async () => {
  const s = state(); demo.demoChat(s, { text: 'change everything', clientRequestId: 'clarify' })
  await vi.advanceTimersByTimeAsync(2300)
  expect(demo.demoStatus().pending.kind).toBe('ask'); expect(s.routines[0].ex[0].sets).toBe(4)
})
