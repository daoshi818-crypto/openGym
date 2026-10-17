import { describe, expect, it } from 'vitest'
import { monthCellsOf, monthDataOf, primaryMusclesOf, trainingTopicsOf } from './training-calendar.js'

const workout = (id, d, start, entry = {}) => ({
  id,
  d,
  start: new Date(`${d}T${start || '10:00'}:00`).getTime(),
  end: new Date(`${d}T${start || '10:00'}:00`).getTime() + 60 * 60000,
  entries: [{ id: entry.id || '0025', sets: [{ w: 60, r: 8, done: true }], ...entry }],
})

describe('monthCellsOf', () => {
  it('handles leap February and Monday-first layout', () => {
    const cells = monthCellsOf(2024, 1, 1)
    expect(cells.filter(cell => cell.inMonth)).toHaveLength(29)
    expect(cells[0].iso).toBe('2024-01-29')
    expect(cells.at(-1).iso).toBe('2024-03-03')
  })

  it('supports Sunday-first layout and cross-year months', () => {
    const cells = monthCellsOf(2025, 0, 0)
    expect(cells[0].iso).toBe('2024-12-29')
    expect(cells.filter(cell => cell.inMonth)).toHaveLength(31)
  })
})

it('uses the selected routine topic and keeps supporting muscles out of the label', () => {
  const routines = [{ id: 'chest-day', name: 'Chest' }]
  const record = {
    id: 'push', d: '2026-10-08', name: 'Chest session', routineIds: ['chest-day'],
    entries: [{ id: '0025', exercise: { primaries: ['chest', 'delts', 'triceps'] }, sets: [{ done: true, w: 60, r: 8 }] }],
  }
  expect(trainingTopicsOf(record, routines)).toEqual(['Chest'])
  const day = monthDataOf([record], 2026, 9, routines).days.get('2026-10-08')
  expect(day.topics).toEqual(['Chest'])
  expect(day.muscles).toEqual(['chest'])
})

describe('monthDataOf', () => {
  it('counts unique days separately from saved sessions', () => {
    const data = monthDataOf([
      workout('morning', '2026-10-08', '08:00'),
      workout('evening', '2026-10-08', '19:00', { id: '0043' }),
      workout('other-month', '2026-09-30', '10:00'),
    ], 2026, 9)
    expect(data.trainingDays).toBe(1)
    expect(data.trainingSessions).toBe(2)
    expect(data.days.get('2026-10-08').sessions).toHaveLength(2)
    expect(data.days.get('2026-10-08').muscles).toEqual(expect.arrayContaining(['chest', 'gluteal', 'quadriceps']))
  })

  it('deduplicates same-day muscles while keeping each session separate', () => {
    const data = monthDataOf([
      workout('a', '2026-10-02', '09:00'),
      workout('b', '2026-10-02', '18:00'),
    ], 2026, 9)
    expect(data.days.get('2026-10-02').muscles).toEqual(['chest'])
    expect(data.days.get('2026-10-02').sessions.map(s => s.workout.id)).toEqual(['a', 'b'])
  })

  it('keeps a valid record visible when muscle data is missing', () => {
    const data = monthDataOf([{ id: 'legacy', d: '2026-10-12', entries: [] }], 2026, 9)
    expect(data.trainingDays).toBe(1)
    expect(data.trainingSessions).toBe(1)
    expect(data.days.get('2026-10-12').muscles).toEqual([])
  })

  it('prefers a saved day over a mismatched start timestamp', () => {
    const data = monthDataOf([{ ...workout('saved', '2026-10-14', '10:00'), start: new Date('2026-10-13T10:00:00').getTime() }], 2026, 9)
    expect(data.days.has('2026-10-14')).toBe(true)
    expect(data.days.has('2026-10-13')).toBe(false)
  })
})

it('uses catalogue primary weight for compact labels', () => {
  expect(primaryMusclesOf({ id: '0025', sets: [{ done: true }] })).toEqual(['chest'])
})


describe('calendar acceptance boundaries', () => {
  it('excludes adjacent-month padding and rejects impossible dates', () => {
    const records = [
      workout('previous', '2025-12-31'), workout('first', '2026-01-01'),
      workout('last', '2026-01-31'), workout('next', '2026-02-01'),
      { d: '2026-01-32' }, { d: '2026-02-30' }, { start: 'invalid' }, null,
    ]
    const data = monthDataOf(records, 2026, 0)
    expect(data.trainingDays).toBe(2)
    expect(data.sessions.map(s => s.workout.id)).toEqual(['first', 'last'])
    expect(monthDataOf([], 2026, 0).trainingSessions).toBe(0)
  })

  it('uses the local start day across UTC month/year boundaries, including numeric strings', () => {
    for (const stamp of ['2025-12-31T23:30:00Z', '2026-01-01T00:30:00Z', '2026-09-30T23:30:00Z']) {
      const date = new Date(stamp)
      const iso = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
      const data = monthDataOf([{ start: String(+date) }], date.getFullYear(), date.getMonth())
      expect([...data.days.keys()]).toEqual([iso])
    }
  })

  it('uses completed work only, including a completed side, and excludes warmups', () => {
    const w = workout('partial', '2026-10-08', '08:00', { id: 'custom-curl', exercise: { primaries: ['biceps'] }, sets: [{
      done: false, sides: { L: { done: true, w: 10, r: 5 }, R: { done: false, w: 10, r: 5 } },
    }] })
    w.entries.push({ exercise: { primaries: ['chest'] }, sets: [{ phase: 'warmup', done: true }] })
    w.entries.push({ exercise: { primaries: ['triceps'] }, sets: [{ done: false }] })
    const day = monthDataOf([w], 2026, 9).days.get(w.d)
    expect(day.muscles).toEqual(['biceps'])
    expect(day.volume).toBe(50)
  })

  it('prefers saved muscle snapshots to a changed catalogue and retains deleted custom mappings', () => {
    expect(primaryMusclesOf({ id: '0025', muscleWeights: { biceps: 1, chest: 0 } })).toEqual(['biceps'])
    expect(primaryMusclesOf({ id: '0025', exercise: { muscleWeights: { triceps: 1 } } })).toEqual(['triceps'])
    expect(primaryMusclesOf({ id: 'deleted-custom', muscleWeights: { quadriceps: 1 } })).toEqual(['quadriceps'])
  })

  it('sums duration and completed volume per day without merging sessions or mutating history', () => {
    const records = [workout('evening', '2026-10-08', '18:00'), workout('morning', '2026-10-08', '08:00')]
    const before = structuredClone(records)
    records[0].vol = 99999
    const day = monthDataOf(records, 2026, 9).days.get('2026-10-08')
    expect(day.duration).toBe(7200000)
    expect(day.volume).toBe(960)
    expect(day.sessions.map(s => s.workout.id)).toEqual(['morning', 'evening'])
    expect(records[1]).toEqual(before[1])
    expect(records[0].vol).toBe(99999)
  })
})
