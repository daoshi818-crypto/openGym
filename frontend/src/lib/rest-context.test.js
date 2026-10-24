import { describe, expect, it } from 'vitest'
import { restContextOf, nextTargetAfter, restNextLine, restContextWire } from './rest-context.js'

const entry = (id, sets, extra = {}) => ({
  id, name: ({ a: 'Bench Press', b: 'Squat', c: 'Row' })[id] || id, entryInstanceId: 'inst-' + id, target: { reps: '8', weight: 60 },
  sets: sets.map((s, i) => ({ setId: id + '-s' + (i + 1), w: 60, r: '8', done: false, ...s })),
  ...extra,
})
const S = entries => ({ unit: 'kg', customEx: [], active: { id: 'w', watchSid: 'sid-1', start: 1000, entries } })
const timer = (forIdx, forSet = 0, extra = {}) => ({ restId: 'r1', total: 90, left: 80, endsAt: Date.now() + 80000, forIdx, forSet, ...extra })

describe('the rest summary handed to the Android overlay', () => {
  it('keeps the plain next set after a completed set, and the next exercise after the last one', () => {
    const S1 = S([entry('a', [{ done: true }, { done: true }, {}]), entry('b', [{}])])
    const ctx = restContextOf(S1, timer(0, 1))
    expect(ctx.next).toMatchObject({ name: 'Bench Press', setNumber: 3, totalSets: 3, kind: 'next' })
    expect(ctx.completed).toMatchObject({ setNumber: 2 })

    const S2 = S([entry('a', [{ done: true }, { done: true }]), entry('b', [{}])])
    expect(restContextOf(S2, timer(0, 1)).next).toMatchObject({ name: 'Squat', setNumber: 1, kind: 'next' })
  })

  it('follows a superset round instead of index + 1', () => {
    // A1 done, B still has both sets: the round goes to B1, not to A2.
    const A = entry('a', [{ done: true }, {}], { sg: 'g1' })
    const B = entry('b', [{}, {}], { sg: 'g1' })
    const C = entry('c', [{}])
    const ctx = restContextOf(S([A, B, C]), timer(0, 0))
    expect(ctx.next).toMatchObject({ name: 'Squat', setNumber: 1 })
    expect(ctx.next.instanceId).toBe('inst-b')
    // B finished its round: the superset is done, so A's second set is next.
    const A2 = entry('a', [{ done: true }, {}], { sg: 'g1' })
    const B2 = entry('b', [{ done: true }, { done: true }], { sg: 'g1' })
    const ctx2 = restContextOf(S([A2, B2, C]), timer(1, 1))
    expect(ctx2.next).toMatchObject({ name: 'Bench Press', setNumber: 2 })
  })

  it('returns null when nothing is left, so the overlay can show “open the workout”', () => {
    const ctx = restContextOf(S([entry('a', [{ done: true }])]), timer(0, 0))
    expect(ctx.next).toBeNull()
    expect(restNextLine(null)).toBe('返回训练查看')
  })

  it('carries the completed set’s estimated effort and the prescription numbers', () => {
    const Sx = S([entry('a', [{ done: true, rpe: 8 }, {}])])
    const ctx = restContextOf(Sx, timer(0, 0))
    expect(ctx.completed).toMatchObject({ effort: 'RPE 8 · 还能再做约2次' })
    expect(restNextLine(ctx.next)).toBe('第2/2组 · 60kg × 8次')
  })

  it('is a compact JSON object with the rest identity and a revision, and null without a rest', () => {
    const ctx = restContextOf(S([entry('a', [{ done: true }, {}])]), timer(0, 0))
    const wire = JSON.parse(restContextWire(ctx))
    expect(wire).toMatchObject({ version: 1, sid: 'sid-1', restId: 'r1' })
    expect(typeof wire.at).toBe('number')
    expect(restContextOf(S([entry('a', [{}])]), null)).toBeNull()
    expect(restContextOf(S([entry('a', [{}])]), { ...timer(0, 0), ready: true })).toBeNull()
  })

  it('ignores warm-up rows when numbering sets', () => {
    const A = entry('a', [{ w: 20, r: '10', warmup: true, done: true }, { done: true }, {}])
    const ctx = restContextOf(S([A]), timer(0, 1))
    expect(ctx.completed).toMatchObject({ setNumber: 1, totalSets: 2 })
    expect(ctx.next).toMatchObject({ setNumber: 2, totalSets: 2 })
  })
})
