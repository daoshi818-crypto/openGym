import { it, expect } from 'vitest'
import { ensureWatchIdentity, resolveWatchTarget } from './watch-identity.js'
import { applyWatchEvent } from './watch-events.js'
import { watchProfileOf, watchCatalogOf } from './watch-workout.js'
import { copyRowAt } from './history.js'
const state = () => ({ unit: 'kg', workouts: [], active: { start: 1, entries: [0,1].map(() => ({ id: '0001', sets: [{ w: 20, r: 10 }] })) } })
it('routes offline updates by instance and set IDs after reordering the same exercise twice', () => {
  const s = state(); ensureWatchIdentity(s.active)
  const [a,b] = s.active.entries, ev = { sid: '1', t: 'weight', ex: 0, set: 1, entryInstanceId: a.entryInstanceId, setId: a.sets[0].setId, weight: 40, seq: 1 }
  s.active.entries.reverse()
  expect(applyWatchEvent(s, ev)).toBe(true)
  expect(a.sets[0].w).toBe(40); expect(b.sets[0].w).toBe(20)
  s.active.entries = [b]
  expect(applyWatchEvent(s, { ...ev, eventId: 'deleted' })).toBe(false)
  expect(b.sets[0].w).toBe(20)
})
it('allocates fresh copied set IDs and rejects old index-only edits after structural change', () => {
  const s = state(); ensureWatchIdentity(s.active)
  const a = s.active.entries[0], old = a.sets[0].setId
  a.sets = copyRowAt(a.sets, 0); ensureWatchIdentity(s.active)
  expect(a.sets[0].setId).toBe(old); expect(a.sets[1].setId).not.toBe(old)
  expect(applyWatchEvent(s, { sid: '1', t: 'weight', ex: 0, set: 1, weight: 99 })).toBe(false)
})
it('converts event-time weight units and normalizes body weight for online and offline plans', () => {
  const s = state(); ensureWatchIdentity(s.active)
  const a = s.active.entries[0]
  expect(applyWatchEvent(s, { sid: '1', t: 'weight', ex: 0, set: 1, entryInstanceId: a.entryInstanceId, setId: a.sets[0].setId, weight: 100, weightUnit: 'lb', seq: 1 })).toBe(true)
  expect(a.sets[0].w).toBeCloseTo(45.359, 3)
  expect(watchProfileOf({ unit: 'lb', bodyweight: [{ w: 200 }] })).toMatchObject({ bodyWeightKg: 90.7, weightUnit: 'lb' })
  expect(watchProfileOf({ unit: 'lb', bodyweight: [] })).toMatchObject({ bodyWeightKg: 70, bodyWeightSource: 'default' })
})
