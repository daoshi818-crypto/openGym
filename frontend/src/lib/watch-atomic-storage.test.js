import { it, expect, vi, afterEach } from 'vitest'
import { watchPersistence } from './watch-test-harness.js'
afterEach(() => vi.useRealTimers())
it('atomic candidates are not cache reads; failed writes do not publish or silently retry them', async () => {
  vi.useFakeTimers()
  const h = watchPersistence(new Map([['x', { value: 1 }]])), writes = []
  h.storage.set = item => writes.push(item)
  const pending = h.ctx.writeStoredAtomic('x', old => ({ value: old.value + 1 }))
  expect(h.ctx.readStored('x')).toEqual({ value: 1 })
  writes[0].fail()
  expect((await pending).ok).toBe(false)
  expect(h.ctx.readStored('x')).toEqual({ value: 1 })
  h.ctx.retryStorage(); expect(writes).toHaveLength(1)
})
it('atomic writes share the existing key gate and rebase concurrent HR rather than rolling it back', async () => {
  vi.useFakeTimers()
  const h = watchPersistence(new Map([['x', { done: false, hr: 80 }]])), writes = []
  h.storage.set = item => writes.push(item)
  const a = h.ctx.writeStoredAtomic('x', old => ({ ...old, done: true }))
  h.ctx.writeStored('x', { done: false, hr: 99 })
  const b = h.ctx.writeStoredAtomic('x', old => ({ ...old, reps: 10 }))
  expect(writes).toHaveLength(1)
  writes[0].success(); expect((await a).ok).toBe(true)
  expect(writes[1].value).toEqual({ done: true, hr: 99 })
  writes[1].success(); expect(writes[2].value).toEqual({ done: true, hr: 99, reps: 10 })
  writes[2].success(); expect((await b).ok).toBe(true)
  expect(h.ctx.readStored('x')).toEqual({ done: true, hr: 99, reps: 10 })
})
it('an atomic storage watchdog fails explicitly and a late callback cannot publish a stale candidate', async () => {
  vi.useFakeTimers()
  const h = watchPersistence(new Map([['x', { n: 1 }]])), writes = []
  h.storage.set = item => writes.push(item)
  const a = h.ctx.writeStoredAtomic('x', () => ({ n: 2 }))
  vi.advanceTimersByTime(5000); expect((await a).ok).toBe(false)
  const b = h.ctx.writeStoredAtomic('x', () => ({ n: 3 }))
  writes[1].success(); expect((await b).ok).toBe(true)
  writes[0].success(); expect(h.ctx.readStored('x')).toEqual({ n: 3 })
})

it.each(['sid', 'clear'])('replaces an old atomic session candidate at an explicit %s boundary', async boundary => {
  vi.useFakeTimers()
  const before = { sid: 'old', startedAt: 1000, active: true, hr: { sum: 0, count: 0, max: 0 },
    rows: [{ w: 20, done: false }], pendingEdits: [], focusAt: 0, restUntil: 0 }
  const h = watchPersistence(new Map([['session_state', before]])), writes = []
  h.storage.set = item => writes.push(item)
  const action = h.ctx.writeStoredAtomic('session_state', old => ({ ...old,
    hr: { sum: 180, count: 1, max: 180, sampleAt: 1100, last: 180 },
    rows: [{ w: 75, done: true }], pendingEdits: [{ eventId: 'old-action' }], focusAt: 1200, restUntil: 5000 }))
  const next = { ...before, ...(boundary === 'sid' ? { sid: 'new', startedAt: 2000 } : { sid: '', startedAt: 0, active: false }) }
  h.ctx.writeStored('session_state', next)
  writes[0].success(); expect((await action).ok).toBe(true)
  expect(h.ctx.readStored('session_state')).toEqual(next)
  // Check the very next SDK payload, before its callback: no bad-disk repair window.
  expect(writes[1].value).toEqual(next)
  writes[1].success()
})

it.each([1, 2])('merges same-session HR as one aggregate while preserving row/event rebasing (overlay count %s)', async count => {
  vi.useFakeTimers()
  const before = { sid: 's', startedAt: 1000, hr: { sum: 0, count: 0, max: 0, sampledDurationMs: 0 },
    rows: [{ w: 20, r: 10 }], pendingEdits: [] }
  const h = watchPersistence(new Map([['session_state', before]])), writes = []
  h.storage.set = item => writes.push(item)
  const candidateHr = { sum: 180, count: 1, max: 180, sampledDurationMs: 9000, sampleAt: 10000, last: 180 }
  const overlayHr = { sum: count * 80, count, max: 80, sampledDurationMs: 0, sampleAt: 10001, last: 80 }
  const action = h.ctx.writeStoredAtomic('session_state', old => ({ ...old, hr: candidateHr,
    rows: [{ w: 75, r: 10 }], pendingEdits: [{ eventId: 'committed-row' }] }))
  h.ctx.writeStored('session_state', { ...before, hr: overlayHr, rows: [{ w: 20, r: 12 }] })
  writes[0].success(); expect((await action).ok).toBe(true)
  expect(writes[1].value).toMatchObject({ hr: count === 1 ? candidateHr : overlayHr,
    rows: [{ w: 75, r: 12 }], pendingEdits: [{ eventId: 'committed-row' }] })
  expect(h.ctx.readStored('session_state').hr).toEqual(count === 1 ? candidateHr : overlayHr)
  writes[1].success()
})
