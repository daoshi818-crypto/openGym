import { describe, it, expect } from 'vitest'
import { applyChangeSet, canonicalPlan, planHash, markStale } from './coach.js'
import recordedResponses from '../../../api/test/fixtures/deepseek-chat-20261106.json'
import { chatPending } from '../../../api/coach/core/chat.js'
import { validateChat } from '../../../api/coach/core/chat.js'
import { coachContext } from '../../../api/coach/core/context.js'
import { chatCommand } from './coach-chat-command.js'
import { runPipeline } from '../../../api/coach/core/pipeline.js'
import { SCHEMAS } from '../../../api/coach/core/schemas.js'
const state = () => ({ unit: 'kg', customEx: [], routines: [{ id: 'back', name: 'Back', ex: [{ id: '0001', mode: 'reps', sets: 4, reps: 8 }] }], week: { 1: ['back'] }, dayPlan: {}, coach: { profile: null }, workouts: [{ id: 'old', entries: [] }], active: { watchSid: 's1', entries: [{ id: '0001', sets: Array.from({ length: 4 }, () => ({ w: 40, r: 8, done: false })) }] } })
function pending(s, change = {}) {
  const result = validateChat({ coach_contract: 1, chat_actions_contract: 1, replyType: 'proposal', answer: 'Awaiting confirmation', summary: 'Adjust sets', targetRoutineId: 'back', changes: [{ id: 'c', type: 'sets', target: { routineId: 'back', exId: '0001' }, after: 3, why: 'User requested', ...change }], notes: [] }, canonicalPlan(s))
  expect(result.ok).toBe(true)
  return { ...result.proposal, kind: 'review', source: 'chat', id: 'p1', revision: 1, runtimeIdentity: 'server|test', scope: { kind: 'routine', routineId: 'back' }, expiresAt: Date.now() + 60000, planHash: planHash(s), context: coachContext(s, planHash(s)) }
}
const proof = p => ({ pending: structuredClone(p), job: null, runtimeIdentity: p.runtimeIdentity, currentRuntimeIdentity: p.runtimeIdentity })
describe('chat application authority and isolation', () => {
  it.each([[3, []], ['3', []], [{ sets: 3 }, []], [3, '第一个动作保持四组；尚未应用，请确认。']])('regresses “我想把练背除了第一个动作以外 其他改为三组” with after=%j, notes=%j', async (after, notes) => {
    const s = state()
    s.routines[0].name = '练背'
    s.routines[0].ex = ['0001', '0002', '0003', '0004'].map(id => ({ id, mode: 'reps', sets: 4, reps: 8 }))
    s.routines.push({ id: 'legs', name: '练腿', ex: [{ id: '0005', mode: 'reps', sets: 5, reps: 10 }] })
    const original = structuredClone(s)
    const adapter = { spawns: false, invoke: async args => {
      expect(args.prompt).toContain('我想把练背除了第一个动作以外 其他改为三组')
      expect(args.schema).toBe(SCHEMAS.chat)
      expect(args.schema.properties.changes.items.properties.after.type).toBe('integer')
      return { code: 0, text: JSON.stringify({ coach_contract: 1, chat_actions_contract: 1, replyType: 'proposal', answer: '尚未应用，请确认', summary: '保留首个动作，其余改三组', targetRoutineId: 'back', notes, changes: s.routines[0].ex.slice(1).map(e => ({ type: 'sets', target: { routineId: 'back', exId: e.id }, after, why: '用户要求' })) }) }
    } }
    const result = await runPipeline({ adapter, cfg: {}, kind: 'chat', payload: { meta: { lang: 'zh' }, userNote: '我想把练背除了第一个动作以外 其他改为三组', plan: canonicalPlan(s), library: [] } })
    expect(result.ok).toBe(true)
    expect(s).toEqual(original) // receiving an answer is never an authorization to write
    const p = { ...result.result, kind: 'review', source: 'chat', id: 'back-three', revision: 1, runtimeIdentity: 'server|test', scope: { kind: 'routine', routineId: 'back' }, expiresAt: Date.now() + 60000, planHash: planHash(s), context: coachContext(s, planHash(s)) }
    expect(p.changes.map(c => c.after)).toEqual([3, 3, 3])
    expect(applyChangeSet(s, p, p.changes.map(c => c.id), proof(p)).applied).toBe(3)
    expect(s.routines[0].ex.map(e => e.sets)).toEqual([4, 3, 3, 3])
    expect(s.routines[1]).toEqual(original.routines[1])
    expect({ active: s.active, workouts: s.workouts, week: s.week, dayPlan: s.dayPlan }).toEqual({ active: original.active, workouts: original.workouts, week: original.week, dayPlan: original.dayPlan })
  })
  it.each(recordedResponses.map((record, i) => [i, record]))('replays real DeepSeek response %s through validation, pending and explicit application', async (_i, record) => {
    const s = state()
    s.routines = [{ id: 'back', name: '练背', ex: ['0027', '2330', '0861', '0293'].map(id => ({ id, mode: 'reps', sets: 4, reps: 10 })) },
      { id: 'chest', name: '练胸', ex: [{ id: '0025', mode: 'reps', sets: 4, reps: 10 }] }]
    const original = structuredClone(s)
    let calls = 0
    const adapter = { spawns: false, invoke: async () => { calls++; return { code: 0, text: JSON.stringify(record.response) } } }
    const result = await runPipeline({ adapter, cfg: {}, kind: 'chat', payload: { meta: { lang: 'zh' }, userNote: '我想把练背除了第一个动作以外 其他改为三组', plan: canonicalPlan(s), library: [] } })
    expect(result.ok).toBe(true)
    expect(calls).toBe(1) // even the captured string-notes failure no longer needs model repair
    expect(s).toEqual(original)
    if (result.result.replyType !== 'proposal') {
      expect(['answer', 'clarify']).toContain(result.result.replyType)
      const readOnly = chatPending(result.result, { id: 'read-only-response' }, {})
      expect(readOnly.kind).toBe('ask')
      expect(readOnly.changes).toBeUndefined()
      expect(s).toEqual(original)
      return // a readable answer or question never authorizes an edit
    }
    const p = chatPending(result.result, { id: 'live-response', runtimeIdentity: 'byok|recorded', planHash: planHash(s), context: coachContext(s, planHash(s)), expiresAt: Date.now() + 60000 }, {})
    expect(p.scope).toEqual({ kind: 'routine', routineId: 'back' })
    expect(applyChangeSet(s, p, p.changes.map(c => c.id), proof(p)).applied).toBe(3)
    expect(s.routines[0].ex.map(e => e.sets)).toEqual([4, 3, 3, 3])
    expect(s.routines[1]).toEqual(original.routines[1])
    expect({ active: s.active, workouts: s.workouts, week: s.week, dayPlan: s.dayPlan }).toEqual({ active: original.active, workouts: original.workouts, week: original.week, dayPlan: original.dayPlan })
  })
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
