import { describe, it, expect } from 'vitest'
import { applyChangeSet, canonicalPlan, planHash, markStale } from './coach.js'
import { validateChat } from '../../../api/coach/core/chat.js'
import { coachContext } from '../../../api/coach/core/context.js'
import { chatCommand } from './coach-chat-command.js'
const state = () => ({ unit: 'kg', customEx: [], routines: [{ id: 'back', name: 'Back', ex: [{ id: '0001', mode: 'reps', sets: 4, reps: 8 }] }], week: { 1: ['back'] }, dayPlan: {}, coach: { profile: null }, workouts: [{ id: 'old', entries: [] }], active: { watchSid: 's1', entries: [{ id: '0001', sets: Array.from({ length: 4 }, () => ({ w: 40, r: 8, done: false })) }] } })
function pending(s, change = {}) {
  const result = validateChat({ coach_contract: 1, chat_actions_contract: 1, replyType: 'proposal', answer: 'Awaiting confirmation', summary: 'Adjust sets', targetRoutineId: 'back', changes: [{ id: 'c', type: 'sets', target: { routineId: 'back', exId: '0001' }, after: 3, why: 'User requested', ...change }], notes: [] }, canonicalPlan(s))
  expect(result.ok).toBe(true)
  return { ...result.proposal, kind: 'review', source: 'chat', id: 'p1', revision: 1, runtimeIdentity: 'server|test', scope: { kind: 'routine', routineId: 'back' }, expiresAt: Date.now() + 60000, planHash: planHash(s), context: coachContext(s, planHash(s)) }
}
const proof = p => ({ pending: structuredClone(p), job: null, runtimeIdentity: p.runtimeIdentity, currentRuntimeIdentity: p.runtimeIdentity })
describe('chat application authority and isolation', () => {
  it('only changes the template; records revision, one snapshot and an idempotent decision', () => {
    const s = state(), p = pending(s), a = proof(p), untouched = structuredClone({ active: s.active, workouts: s.workouts, week: s.week, dayPlan: s.dayPlan })
    const result = applyChangeSet(s, p, ['chat-c1'], a)
    expect(result.applied).toBe(1); expect(s.routines[0].ex[0].sets).toBe(3)
    expect({ active: s.active, workouts: s.workouts, week: s.week, dayPlan: s.dayPlan }).toEqual(untouched)
    expect(s.active.entries[0].sets).toHaveLength(4)
    expect(s.coach.outbox[0].revision).toBe(1)
    expect(applyChangeSet(s, p, ['chat-c1'], a).alreadyApplied).toBe(true)
    expect(s.coach.snapshots).toHaveLength(1); expect(s.coach.log).toHaveLength(1)
  })
  it.each([
    ['no fresh status', (s, p, a) => { delete a.pending }],
    ['new pending', (s, p, a) => { a.pending.id = 'new' }],
    ['new revision', (s, p, a) => { a.pending.revision++ }],
    ['different payload', (s, p, a) => { a.pending.changes[0].after = 2 }],
    ['busy', (s, p, a) => { a.job = { id: 'newjob' } }],
    ['mode changed', (s, p, a) => { a.currentRuntimeIdentity = 'byok|new' }],
    ['provider changed', (s, p, a) => { p.executionModeFingerprint = 'old'; a.pending.executionModeFingerprint = 'old'; a.executionModeFingerprint = 'new' }],
    ['expired', (s, p, a) => { p.expiresAt = a.pending.expiresAt = Date.now() - 1 }],
    ['unit changed', s => { s.unit = 'lb' }],
    ['profile changed', s => { s.coach.profile = { changed: true } }],
    ['plan moved', s => { s.routines[0].name = 'Edited' }],
    ['before differs', (s, p, a) => { p.changes[0].before = a.pending.changes[0].before = 99 }],
    ['unknown selected ID', (s, p, a) => { p.changes[0].id = a.pending.changes[0].id = 'not-selected' }],
  ])('refuses %s without even creating a snapshot', (_name, mutate) => {
    const s = state(), p = pending(s), a = proof(p); mutate(s, p, a)
    const before = structuredClone(s)
    expect(() => applyChangeSet(s, p, ['chat-c1'], a)).toThrow()
    expect(s).toEqual(before)
  })
  it('refuses an empty selection, never reporting false success', () => {
    const s = state(), p = pending(s)
    expect(() => applyChangeSet(s, p, [], proof(p))).toThrow(); expect(s.coach.snapshots).toBeUndefined()
  })
  it('can add an unset rep range using canonical zero before, never skipping the check', () => {
    const s = state(), p = pending(s, { type: 'repsMin', after: 6 })
    expect(p.changes[0].before).toBe(0); expect(markStale(p, s).changes[0].status).toBe('proposed')
    expect(applyChangeSet(s, p, ['chat-c1'], proof(p)).applied).toBe(1)
    expect(s.routines[0].ex[0].repsMin).toBe(6)
  })
  it('marks the whole chat card stale when any template data changes', () => {
    const s = state(), p = pending(s); s.routines[0].name = 'New'
    expect(markStale(p, s).changes.every(c => c.status === 'stale')).toBe(true)
  })
})
describe('whole-sentence commands open confirmation only', () => {
  it.each(['按这个改', '确认应用！', '全部应用。', ' Apply all! '])('accepts %s', text => expect(chatCommand(text)).toBe('apply'))
  it.each(['不要按这个改', '可以，但只改一个动作', '好的', '可以', '全部应用但不要改背部', '请解释确认应用是什么意思'])('never substring-matches %s', text => expect(chatCommand(text)).toBeNull())
  it('recognizes explicit dismissal', () => expect(chatCommand('放弃这个方案')).toBe('dismiss'))
})
