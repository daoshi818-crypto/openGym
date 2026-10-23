import { it, expect } from 'vitest'
import { applyChangeSet, applyCreatedPlan, recordDebrief, revertLast } from './coach.js'
import { coachContext } from '../../../api/coach/core/context.js'
const state = () => ({ unit: 'kg', routines: [{ id: 'r', name: 'R', ex: [{ id: '0001', sets: 3, reps: 10 }] }], week: {}, dayPlan: {}, coach: { profile: {}, log: [], snapshots: [] } })
const proposal = s => ({ id: 'p', kind: 'review', context: coachContext(s, null), changes: [{ id: 'c', type: 'sets', target: { routineId: 'r', exId: '0001' }, before: 3, after: 4 }] })
it('records apply and acknowledgement atomically, and a repeated decision has no side effects', () => {
  const s = state(), p = proposal(s)
  applyChangeSet(s, p, ['c']); const before = JSON.stringify(s)
  expect(applyChangeSet(s, p, ['c']).alreadyApplied).toBe(true)
  expect(JSON.stringify(s)).toBe(before)
  expect(s.coach.outbox[0]).toMatchObject({ proposalId: 'p', requestId: expect.any(String) })
})
it('rechecks unit, profile, selected scope and live before values at apply time', () => {
  for (const edit of [s => { s.unit = 'lb' }, s => { s.coach.profile.goal = 'muscle' }, s => { s.routines[0].ex[0].sets = 5 }]) {
    const s = state(), p = proposal(s); edit(s)
    expect(() => applyChangeSet(s, p, ['c'])).toThrow()
  }
  const s = state(), p = proposal(s); p.scope = { kind: 'routine', routineId: 'other' }
  expect(() => applyChangeSet(s, p, ['c'])).toThrow()
})
it('refuses undo after manual edits and preserves the snapshot for inspection', () => {
  const s = state(); applyChangeSet(s, proposal(s), ['c']); s.routines[0].name = 'Manual edit'
  expect(() => revertLast(s)).toThrow(/overwrite/)
  expect(s.routines[0].name).toBe('Manual edit'); expect(s.coach.snapshots).toHaveLength(1)
})
it('keeps a report once with frozen evidence and does not advance review cadence', () => {
  const s = state(), p = { id: 'd', kind: 'debrief', scope: { version: 2, actual: 3 }, evidenceSnapshot: { unit: 'kg', totals: { sets: 9 } } }
  const a = recordDebrief(s, p), b = recordDebrief(s, p)
  expect(a).toBe(b); expect(s.coach.log).toHaveLength(1); expect(s.coach.lastReview).toBeUndefined()
  expect(s.coach.log[0].evidenceSnapshot.totals.sets).toBe(9)
})
