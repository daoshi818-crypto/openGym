import { it, expect } from 'vitest'
import { validDay, reviewDay, localDay } from '../../../api/coach/core/dates.js'
import { reviewWindow } from '../../../api/coach/core/payload.js'
it('reads epoch and ISO review timestamps in the selected timezone, rejecting invalid dates', () => {
  const epoch = Date.parse('2026-10-23T01:30:00Z')
  expect(reviewDay(epoch, 'America/Los_Angeles')).toBe('2026-10-22')
  expect(reviewDay('2026-10-23T01:30:00Z', 'America/Los_Angeles')).toBe('2026-10-22')
  expect(reviewDay('2026-10-23')).toBe('2026-10-23')
  expect(validDay('2026-02-30')).toBeNull(); expect(reviewDay('invalid')).toBeNull()
})
it('sorts and bounds review history and excludes future dates', () => {
  const workouts = ['2026-10-24','2026-10-22','2026-10-23','2025-01-01'].map(d => ({ d, entries: [] }))
  expect(reviewWindow({ workouts }, null, { today: '2026-10-23' }).map(w => w.d)).toEqual(['2026-10-22','2026-10-23'])
})
