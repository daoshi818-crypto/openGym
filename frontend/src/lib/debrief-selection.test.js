import { describe, it, expect } from 'vitest'
import { selectionForWorkout, selectionForPlan, resolveDebriefSelection, legacySelection, workoutRefOf } from './debrief-selection.js'
import { build } from '../../../api/coach/core/payload.js'
import { debriefMetadata } from '../../../api/coach/core/debrief-report.js'
import { validateDebrief, validateReview } from '../../../api/coach/core/validate.js'
const workout = (id, rid, start = 10, d = '2026-10-23') => ({ id, d, start, end: start + 3600000, name: rid, routineIds: [rid], entries: [{ id: '0001', rid, sets: [{ done: true, w: 20, r: 10 }] }] })
const fixture = () => ({ unit: 'kg', routines: [{ id: 'chest', name: 'Chest', ex: [] }, { id: 'abs', name: 'Abs', ex: [] }], workouts: [workout('chest-am', 'chest', 10), workout('abs-am', 'abs', 20)] })
const payload = (s, selection) => build(s, { handle: 'test', kind: 'debrief', debriefSelection: selection })
describe('frozen workout selection', () => {
  it('keeps the morning chest session when a later abs session exists or is added', () => {
    const s = fixture(), selected = selectionForWorkout(s, s.workouts[0])
    s.workouts.push(workout('abs-pm', 'abs', 30))
    const p = payload(s, selected)
    expect(p.session.id).toBe('chest-am')
    expect(p.previous).toEqual([])
    expect(p.sessions).toHaveLength(1)
    expect(debriefMetadata(p).workout.id).toBe('chest-am')
  })
  it('filters by stable plan id before taking N, and sorts out of order history', () => {
    const s = fixture()
    s.workouts = [workout('c1', 'chest', 1, '2026-10-01'), workout('c3', 'chest', 3, '2026-10-03'), workout('c2', 'chest', 2, '2026-10-02'), ...Array.from({ length: 20 }, (_, i) => workout('a' + i, 'abs', i))]
    const selected = selectionForPlan(s, 'chest', 5), p = payload(s, selected)
    expect(selected.refs.map(r => r.value)).toEqual(['c1', 'c2', 'c3'])
    expect(p.debriefScope).toMatchObject({ actual: 3, requested: 5, mode: 'plan' })
    expect(p.previous).toEqual([])
    s.routines[0].name = 'New chest name'
    expect(resolveDebriefSelection(s, selected).records).toHaveLength(3)
  })
  it('rejects deletion, ambiguous legacy identity, and edits without falling back', () => {
    const s = fixture(), selected = selectionForWorkout(s, s.workouts[0])
    s.workouts[0].entries[0].sets[0].r = 8
    expect(() => resolveDebriefSelection(s, selected)).toThrow('selection_stale')
    s.workouts.shift()
    expect(() => resolveDebriefSelection(s, selected)).toThrow('noworkout')
    expect(() => legacySelection(s, 'missing')).toThrow('noworkout')
    const w = workout(undefined, 'chest')
    expect(() => selectionForWorkout({ ...s, workouts: [w, { ...w }] }, w)).toThrow('ambiguous_workout')
  })
  it('uses typed refs for old records and keeps selected records independent of array order', () => {
    const s = fixture(); delete s.workouts[0].id
    const selected = selectionForWorkout(s, s.workouts[0])
    expect(selected.refs[0].type).toBe('legacy')
    s.workouts.reverse()
    expect(payload(s, selected).session.name).toBe('chest')
  })
  it('projects mixed sessions without attributing whole session metrics', () => {
    const s = fixture(), w = s.workouts[0]
    w.routineIds.push('abs'); w.entries.push({ id: '0002', rid: 'abs', sets: [{ done: true, w: 100, r: 10 }] }); w.calories = 300; w.vol = 1200
    const p = payload(s, selectionForPlan(s, 'chest', 5)), m = debriefMetadata(p)
    expect(p.sessions[0].entries.map(e => e.id)).toEqual(['0001'])
    expect(m.evidenceSnapshot.totals.volume).toBe(200)
    expect(m.evidenceSnapshot.sessions[0].minutes).toBeNull()
    expect(p.dataLimitations).toContain('mixed_session_metrics_not_attributable')
    delete w.entries[0].rid
    expect(() => selectionForPlan(s, 'chest', 5)).toThrow()
  })
  it('rejects invalid N, duplicate refs, unknown plans, empty plans', () => {
    const s = fixture(), selected = selectionForPlan(s, 'chest', 5)
    expect(() => resolveDebriefSelection(s, { ...selected, refs: [selected.refs[0], selected.refs[0]] })).toThrow('invalid_selection')
    expect(() => selectionForPlan(s, 'chest', 4)).toThrow()
    expect(() => selectionForPlan(s, 'deleted', 5)).toThrow()
    expect(() => selectionForWorkout(s, { id: 'missing' })).toThrow()
  })
  it('does not compare a historical target against future sessions', () => {
    const s = fixture(); s.workouts.unshift(workout('past', 'chest', 1, '2026-10-01'))
    const p = payload(s, selectionForWorkout(s, s.workouts[0]))
    expect(p.previous).toEqual([])
    expect(p.debriefScope.to).toBe('2026-10-01')
  })
  it('checks trend references and disallows review operations outside the selected routine', () => {
    const base = { summary: 'x', highlights: ['x'], watch: [], nextTime: [], trends: [{ text: 'x', sessionRefs: ['id:other'] }], dataLimitations: [] }
    expect(validateDebrief(base, { scope: { mode: 'plan' }, sessions: [{ ref: 'id:chest', entries: [] }] }).ok).toBe(false)
    expect(validateReview({ changes: [{ id: 'x', type: 'week', target: { weekday: 1 }, after: 'chest' }] }, {}, { scope: { kind: 'routine', routineId: 'chest' } }).ok).toBe(false)
  })
})
