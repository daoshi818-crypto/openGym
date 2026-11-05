import { describe, expect, it } from 'vitest'
import { buildSets } from './history.js'

// A session that logged warm-ups, the way finish-workout persists it: warm-up rows and work
// rows in one `sets` array, all done.
const S = {
  workouts: [{
    d: '2026-08-24',
    entries: [{
      id: 'bench',
      target: { id: 'bench', sets: 3, reps: 5, weight: 100 },
      sets: [
        { w: 50, r: 5, done: true, phase: 'warmup', warmup: true },
        { w: 75, r: 5, done: true, phase: 'warmup', warmup: true },
        { w: 100, r: 5, done: true },
        { w: 100, r: 5, done: true },
        { w: 100, r: 5, done: true },
      ],
    }],
  }],
  exWeights: {},   // no confirmed working weight for this exercise
  routines: [],
}

describe('seeding the next session from one that had warm-ups', () => {
  it('does not seed the work sets from the warm-up rows', () => {
    const cfg = { id: 'bench', sets: 3, reps: 5, weight: 100 }
    const rows = buildSets(S, cfg)
    const work = rows.filter(r => r.phase !== 'warmup')
    expect(work.map(r => r.w)).toEqual([100, 100, 100])
  })

  it('freestyle reproducing last time also skips the warm-ups', () => {
    const cfg = { id: 'bench', sets: 3, reps: 5, weight: 100 }
    const rows = buildSets(S, cfg, { preferLast: true })
    const work = rows.filter(r => r.phase !== 'warmup')
    expect(work.map(r => r.w)).toEqual([100, 100, 100])
  })
})


describe('planned warm-ups respect module preferences', () => {
  const cfg = { id: 'bench', sets: 3, reps: 5, weight: 100, warmupSets: 2 }
  it('pauses automatic warm-ups without changing the saved routine', () => {
    const paused = { ...S, modules: { plates: false } }
    expect(buildSets(paused, cfg).filter(r => r.phase === 'warmup')).toHaveLength(0)
    expect(buildSets(paused, cfg).map(r => r.w)).toEqual([100, 100, 100])
    expect(cfg.warmupSets).toBe(2)
    expect(buildSets({ ...paused, modules: { plates: true } }, cfg).filter(r => r.phase === 'warmup')).toHaveLength(2)
  })
  it('keeps planned warm-ups enabled for existing profiles', () => {
    expect(buildSets(S, cfg).filter(r => r.phase === 'warmup')).toHaveLength(2)
  })
})
