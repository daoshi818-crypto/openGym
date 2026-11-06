import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChat, bindChatRequest, assertChatBase, chatPending } from '../coach/core/chat.js';
import { EXERCISES } from '../coach/core/library-data.js';
import { runPipeline } from '../coach/core/pipeline.js';
const exId = EXERCISES[0].id;
const plan = { routines: [{ id: 'back', name: 'Back', ex: [{ id: exId, mode: 'reps', sets: 4, reps: 10, repsMin: 8, repsMax: 12 }] }] };
const proposal = () => ({ coach_contract: 1, chat_actions_contract: 1, replyType: 'proposal', answer: 'Not applied yet', summary: 'Adjust sets', targetRoutineId: 'back', changes: [{ id: 'a', type: 'sets', target: { routineId: 'back', exId }, before: 1234, after: 3, why: 'Requested by user' }], notes: [], clarification: '' });
const options = { customIds: [exId] };
test('chat accepts unambiguous scalar encodings without weakening integer bounds', () => {
  for (const after of ['3', ' 3 ', { sets: 3 }, { sets: '3' }]) {
    const p = proposal(); p.changes[0].after = after;
    const before = structuredClone(p);
    const result = validateChat(p, plan, options);
    assert.equal(result.ok, true, JSON.stringify(after));
    assert.equal(result.proposal.changes[0].after, 3);
    assert.deepEqual(p, before, 'provider output must not be mutated');
  }
  for (const after of [true, null, [], [3], '', '3 sets', '三组', '3.5', '1e1', '0x3', { sets: 3, reps: 12 }, { value: 3 }, { sets: { sets: 3 } }, 0, 11, 3.5, '11']) {
    const p = proposal(); p.changes[0].after = after;
    assert.equal(validateChat(p, plan, options).ok, false, JSON.stringify(after));
  }
});
test('chat normalizes bounds before subset comparisons and keeps mode and range checks', () => {
  const p = proposal();
  p.changes = ['repsMin', 'repsMax'].map((type, i) => ({ type, target: { routineId: 'back', exId }, after: i ? '10' : '9', why: 'Requested' }));
  const result = validateChat(p, plan, options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.proposal.changes.map(c => c.after), [9, 10]);
  p.changes[0].after = { repsMin: '13' };
  assert.equal(validateChat(p, plan, options).ok, false);
  const timed = structuredClone(plan); timed.routines[0].ex[0].mode = 'time';
  for (const after of ['120', { sec: '120' }]) {
    const edit = proposal(); edit.changes[0] = { ...edit.changes[0], type: 'sec', after };
    assert.equal(validateChat(edit, timed, options).proposal.changes[0].after, 120);
    assert.equal(validateChat(edit, plan, options).ok, false);
  }
});
test('genuinely invalid sets still require the existing repair round and may never be clamped', async () => {
  for (const repaired of [3, 11]) {
    let calls = 0;
    const result = await runPipeline({ kind: 'chat', cfg: {}, payload: { plan }, adapter: {
      spawns: false, invoke: async args => {
        const p = proposal(); p.changes[0].after = calls++ ? repaired : 11;
        if (calls === 2) assert.ok(args.prompt.includes('whole number of sets (1-10)'));
        return { code: 0, text: JSON.stringify(p) };
      }
    } });
    assert.equal(calls, 2);
    assert.equal(result.ok, repaired === 3);
    if (result.ok) assert.equal(result.result.changes[0].after, 3);
    else assert.equal(result.errorClass, 'unusable');
  }
});
test('chat corrects before, assigns unique change IDs and keeps ask separate', () => {
  const r = validateChat(proposal(), plan, options); assert.equal(r.ok, true); assert.equal(r.proposal.changes[0].before, 4);
  assert.equal(r.proposal.changes[0].id, 'chat-c1');
  for (const replyType of ['answer', 'clarify']) {
    const a = validateChat({ ...proposal(), replyType, changes: [], clarification: replyType === 'clarify' ? 'Which routine?' : '' }, plan, options);
    assert.equal(a.ok, true); assert.equal(a.proposal.changes, undefined);
  }
});
test('chat rejects unknown contract, hidden mutation fields and invalid/multiple targets', () => {
  const mutate = [p => p.chat_actions_contract = 2, p => p.replyType = 'execute', p => p.patch = {}, p => p.changes[0].type = 'weight', p => p.changes[0].after = 0, p => p.changes.push({ ...p.changes[0] }), p => p.targetRoutineId = 'missing', p => p.changes[0].target.exId = 'absent', p => p.changes[0].target.extra = true, p => p.changes[0].source = 'trusted', p => p.replyType = 'answer'];
  for (const m of mutate) { const p = proposal(); m(p); assert.equal(validateChat(p, plan, options).ok, false, JSON.stringify(p)); }
  assert.equal(validateChat(proposal(), plan, { scope: { kind: 'routine', routineId: 'elsewhere' } }).ok, false);
});
test('chat rejects unsafe range subsets, duplicate IDs and over ten changes', () => {
  const p = proposal(); p.changes = [
    { id: 'a', type: 'repsMin', target: { routineId: 'back', exId }, after: 14, why: 'requested' },
    { id: 'b', type: 'repsMax', target: { routineId: 'back', exId }, after: 16, why: 'requested' }];
  assert.equal(validateChat(p, plan, options).ok, false);
  p.changes[0].after = 9; p.changes[1].after = 14; assert.equal(validateChat(p, plan, options).ok, true);
  p.changes[1].id = 'a'; assert.equal(validateChat(p, plan, options).ok, false);
  p.changes = Array.from({ length: 11 }, () => proposal().changes[0]); assert.equal(validateChat(p, plan, options).ok, false);
});
test('request references are resolved from trusted pending, not supplied content', () => {
  const base = { id: 'p1', kind: 'review', source: 'chat', revision: 2, scope: { kind: 'routine', routineId: 'back' }, summary: 'first', changes: proposal().changes };
  const opts = bindChatRequest(base, { clientRequestId: 'req1', proposalRef: { id: 'p1', revision: 2 } });
  assert.equal(opts.basePending.id, 'p1'); assert.equal(opts.scope.routineId, 'back'); assertChatBase(base, opts);
  assert.throws(() => assertChatBase({ ...base, revision: 3 }, opts), /pending_mismatch/);
  assert.throws(() => bindChatRequest(base, { clientRequestId: 'req1' }), /pending_mismatch/);
  assert.throws(() => bindChatRequest(base, { clientRequestId: 'req1', proposalRef: { id: 'p1', revision: 2 }, scope: { kind: 'routine', routineId: 'other' } }), /scope/);
  const result = validateChat(proposal(), plan, options).proposal;
  const meta = { id: 'p2', createdAt: 1, expiresAt: Date.now() + 10000, planHash: 'h', context: {}, scope: opts.scope };
  const p2 = chatPending(result, meta, opts);
  assert.equal(p2.kind, 'review'); assert.equal(p2.source, 'chat'); assert.equal(p2.revision, 3); assert.equal(p2.parentProposalId, 'p1'); assert.equal(p2.prev, undefined);
  const answer = chatPending({ replyType: 'answer', answer: 'explanation' }, meta, opts);
  assert.equal(answer.kind, 'ask'); assert.equal(answer.prev.id, 'p1'); assert.equal(answer.changes, undefined);
});
test('chat fails closed on non-string summary and malformed notes instead of throwing', () => {
  for (const summary of [12, {}, [], null]) assert.equal(validateChat({ ...proposal(), summary }, plan, options).ok, false);
  for (const notes of [{}, 'text', [4], Array(11).fill('x')]) assert.equal(validateChat({ ...proposal(), notes }, plan, options).ok, false);
});
test('debrief references preserve selected evidence without confusing debrief scope with template scope', () => {
  const debrief = { id: 'd1', kind: 'debrief', summary: 'Selected old debrief', scope: { mode: 'plan', planId: 'historic', actual: 2 }, nextTime: ['Reduce fatigue'], evidenceSnapshot: { unit: 'kg', totals: { sessions: 2 }, sessions: [{ ref: 'chosen', d: '2026-09-01', sets: 8, lifts: [{ id: exId, sets: 4 }] }] } };
  const req = { clientRequestId: 'from-debrief', contextRef: { kind: 'debrief', id: debrief.id } };
  const bound = bindChatRequest(debrief, req);
  assert.equal(bound.scope, null); assert.equal(bound.debriefContext.evidence.sessions[0].ref, 'chosen');
  assert.equal(validateChat(proposal(), plan, bound).ok, true);
  const history = { ...debrief, id: 'log-old' };
  const old = bindChatRequest(null, { ...req, contextRef: { kind: 'debrief', id: history.id } }, [history]);
  assert.equal(old.debriefContext.id, 'log-old'); assert.equal(old.debriefContext.summary, history.summary);
  assert.throws(() => bindChatRequest(null, req, [history]), /context_missing/);
  assert.throws(() => bindChatRequest(debrief, { ...req, contextRef: { kind: 'debrief', id: history.id } }, [history]), /context_missing/);
});
test('legacy single-routine reviews bind revisions to their real targets, not a new scope', () => {
  const base = { id: 'old-review', kind: 'review', changes: proposal().changes };
  const req = { clientRequestId: 'legacy-revise', proposalRef: { id: base.id, revision: 1 } };
  assert.equal(bindChatRequest(base, req).scope.routineId, 'back');
  assert.throws(() => bindChatRequest(base, { ...req, scope: { kind: 'routine', routineId: 'other' } }), /scope_mismatch/);
});
