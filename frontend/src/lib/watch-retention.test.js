import { expect, it } from 'vitest'
import { pruneWatchClosed } from './watch-retention.js'
import { startFromWatch } from './watch-events.js'
it('bounds acknowledged history and protects pending offline save decisions', () => {
  const now = Date.now(), S = { watchClosed: {}, watchPendingSaves: { pending: { sid: 'protected' } } }
  for (let i=0;i<600;i++) S.watchClosed['s'+i] = { sid: 's'+i, closedAt: now-i, acknowledgedAt: now, entries: [1] }
  S.watchClosed.protected = { sid: 'protected', closedAt: 1, entries: [2] }
  S.watchClosed.expired = { sid: 'expired', closedAt: now-31*86400000 }
  pruneWatchClosed(S, now)
  expect(Object.keys(S.watchClosed)).toHaveLength(501)
  expect(S.watchClosed.protected.entries).toEqual([2])
  expect(S.watchClosed.s0.entries).toBeUndefined()
  expect(S.watchClosed.expired).toBeUndefined()
})
it('does not resurrect an expired or undated offline start after its tombstone is pruned', () => {
  const S = { workouts: [] }, plan = { entries: [{ id: '0001', sets: [{}] }] }
  expect(startFromWatch(S, { sid: 'old', plan, startedAt: Date.now()-31*86400000 })).toBe('expired')
  expect(startFromWatch(S, { sid: 'unknown', plan })).toBe('invalid_plan')
  expect(S.active).toBeUndefined()
})
