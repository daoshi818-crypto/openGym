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
