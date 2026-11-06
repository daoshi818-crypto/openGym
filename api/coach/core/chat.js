// Shared chat safety boundary for server, BYOK and the demo. Model output never owns metadata.
import { fingerprint } from './debrief-selection.js';
import { validateReview } from './validate.js';
import { waitingProposal } from './pending.js';
export const CHAT_ACTIONS_VERSION = 1;
export const CHAT_TYPES = ['sets', 'reps', 'repsMin', 'repsMax', 'sec'];
const fail = message => ({ ok: false, errors: [message] });
const error = code => Object.assign(new Error(code), { code });
const only = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(k => keys.includes(k));
// Chat has scalar edits only. Some non-strict providers use "3" or {sets:3}
// despite the decoding schema. Accept only those lossless encodings, never parseInt,
// booleans, human prose, deltas, nested objects or objects with extra edit fields.
function scalarAfter(type, value) {
  if (only(value, [type]) && Object.hasOwn(value, type)) value = value[type];
  return typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
}
export function validateChat(data, plan, ctx = {}) {
  if (!only(data, ['coach_contract', 'chat_actions_contract', 'replyType', 'answer', 'summary', 'targetRoutineId', 'changes', 'notes', 'clarification']) || data.coach_contract !== 1 || data.chat_actions_contract !== 1) return fail('invalid chat contract or unknown fields');
  if (!['answer', 'clarify', 'proposal'].includes(data.replyType) || typeof data.answer !== 'string' || !data.answer.trim() || data.answer.length > 6000 || !Array.isArray(data.changes)) return fail('replyType, answer and changes are required');
  if (data.notes != null && (!Array.isArray(data.notes) || data.notes.length > 10 || data.notes.some(n => typeof n !== 'string' || n.length > 1200))) return fail('invalid notes');
  if (data.summary != null && (typeof data.summary !== 'string' || data.summary.length > 2000)) return fail('invalid summary');
  if (data.clarification != null && (typeof data.clarification !== 'string' || data.clarification.length > 1200)) return fail('invalid clarification');
  if (data.replyType !== 'proposal') {
    if (data.changes.length || (data.replyType === 'answer' && data.clarification) || (data.replyType === 'clarify' && !data.clarification?.trim())) return fail('read-only answer must not include changes; clarify must ask a question');
    return { ok: true, proposal: { replyType: data.replyType, answer: data.answer.trim(), ...(data.replyType === 'clarify' ? { clarification: data.clarification.trim() } : {}) } };
  }
  if (typeof data.summary !== 'string' || !data.summary.trim() || data.changes.length < 1 || data.changes.length > 10 || data.clarification) return fail('proposal requires summary and 1-10 changes');
  const routine = plan?.routines?.find(r => r.id === data.targetRoutineId);
  if (!routine || ctx.scope && ctx.scope.routineId !== routine.id) return fail('proposal exceeds selected routine');
  const fields = new Set(), ids = new Set();
  const changes = [];
  for (const c of data.changes) {
    if (!only(c, ['id', 'type', 'target', 'before', 'after', 'why']) || !CHAT_TYPES.includes(c.type) || !only(c.target, ['routineId', 'exId']) || c.target.routineId !== routine.id) return fail('unsupported change or target');
    const key = [c.target.routineId, c.target.exId, c.type].join('|');
    if (fields.has(key) || c.id != null && (typeof c.id !== 'string' || ids.has(c.id))) return fail('duplicate field or change ID');
    fields.add(key); if (c.id != null) ids.add(c.id);
    const ex = routine.ex?.find(e => e.id === c.target.exId);
    if (!ex || routine.ex.filter(e => e.id === c.target.exId).length !== 1) return fail('missing or ambiguous exercise identity');
    if ((c.type === 'sec' && ex.mode !== 'time') || (['reps', 'repsMin', 'repsMax'].includes(c.type) && ex.mode !== 'reps')) return fail('change is incompatible with exercise mode');
    changes.push({ ...c, after: scalarAfter(c.type, c.after) });
  }
  // Every checkbox subset must be safe. Restrict independent bounds instead of inventing an
  // atomic group that the existing review UI cannot represent. Never validate only the full set.
  for (const ex of routine.ex || []) {
    const edits = changes.filter(c => c.target.exId === ex.id);
    const mins = [ex.repsMin || null, ...edits.filter(c => c.type === 'repsMin').map(c => c.after)].filter(v => v != null);
    const maxs = [ex.repsMax || null, ...edits.filter(c => c.type === 'repsMax').map(c => c.after)].filter(v => v != null);
    if (mins.some(lo => maxs.some(hi => lo > hi))) return fail('a selected subset would invert the rep range');
  }
  // Canonical plan uses zero for an unset range. The legacy validator treats non-null
  // bounds as real bounds, so pass null only for its range checks, preserving canonical before.
  const reviewPlan = { ...plan, routines: plan.routines.map(r => ({ ...r, ex: (r.ex || []).map(e => ({ ...e, repsMin: e.repsMin || null, repsMax: e.repsMax || null })) })) };
  const checked = validateReview({ summary: data.summary, changes, notes: data.notes || [] }, reviewPlan, { ...ctx, scope: { kind: 'routine', routineId: routine.id } });
  if (!checked.ok) return checked;
  if (checked.nochange || !checked.proposal?.changes?.length) return { ok: true, proposal: { replyType: 'answer', answer: data.answer } };
  return { ok: true, proposal: { ...checked.proposal, replyType: 'proposal', answer: data.answer, targetRoutineId: routine.id,
    changes: checked.proposal.changes.map((c, i) => ({ ...c, id: 'chat-c' + (i + 1), ...(['repsMin', 'repsMax'].includes(c.type) ? { before: routine.ex.find(e => e.id === c.target.exId)[c.type] || 0 } : {}) })) } };
}
export function bindChatRequest(pending, options = {}, history = []) {
  const opts = { ...options };
  if (typeof opts.clientRequestId !== 'string' || !opts.clientRequestId.trim() || opts.clientRequestId.length > 128) throw error('invalid_request');
  const base = waitingProposal(pending);
  if (base?.kind === 'create') throw error('pending_mismatch');
  if (opts.proposalRef) {
    if (!only(opts.proposalRef, ['id', 'revision']) || base?.kind !== 'review' || opts.proposalRef.id !== base.id || opts.proposalRef.revision !== (base.revision || 1)) throw error('pending_mismatch');
  } else if (base?.kind === 'review') throw error('pending_mismatch');
  const routineIds = [...new Set((base?.changes || []).map(c => c.target?.routineId).filter(Boolean))];
  const baseScope = base?.kind === 'review' ? base.scope || base.context?.scope || (routineIds.length === 1 ? { kind: 'routine', routineId: routineIds[0] } : null) : null;
  if (base?.kind === 'review' && !baseScope) throw error('scope_mismatch');
  if (opts.scope && baseScope && opts.scope.routineId !== baseScope.routineId) throw error('scope_mismatch');
  if (opts.contextRef) {
    if (!only(opts.contextRef, ['kind', 'id']) || opts.contextRef.kind !== 'debrief') throw error('context_missing');
    const selected = base?.kind === 'debrief' && opts.contextRef.id === base.id ? base :
      (!base ? history.find(p => p.kind === 'debrief' && p.id === opts.contextRef.id) : null);
    if (!selected) throw error('context_missing');
    const evidence = selected.evidenceSnapshot;
    opts.debriefContext = { id: selected.id, summary: String(selected.summary || '').slice(0, 2000), scope: selected.scope || null,
      nextTime: (selected.nextTime || []).slice(0, 10).map(x => String(x).slice(0, 400)),
      evidence: evidence ? { unit: evidence.unit, totals: evidence.totals,
        truncated: (evidence.sessions || []).length > 12 || (evidence.sessions || []).some(w => (w.lifts || []).length > 24),
        sessions: (evidence.sessions || []).slice(-12).map(w => ({ ref: w.ref, d: w.d, name: String(w.name || '').slice(0, 80),
          minutes: w.minutes, sets: w.sets, volume: w.volume, lifts: (w.lifts || []).slice(0, 24).map(e => ({ id: e.id, sets: e.sets, volume: e.volume, bestWeight: e.bestWeight })) })) } : null };
  }
  return { ...opts, scope: opts.scope || baseScope || null, baseId: pending?.id || null, baseRevision: pending?.revision || 1, basePending: base };
}
export function assertChatBase(pending, opts) {
  if ((pending?.id || null) !== opts.baseId || (pending?.revision || 1) !== opts.baseRevision) throw error('pending_mismatch');
}
export function chatPending(result, metadata, opts) {
  const { replyType, targetRoutineId, ...clean } = result;
  if (replyType !== 'proposal') return { ...metadata, ...clean, kind: 'ask', source: 'chat', replyType, prev: waitingProposal(opts.basePending) };
  if (opts.basePending && opts.basePending.kind !== 'review' && !opts.contextRef) throw error('pending_mismatch');
  return { ...metadata, ...clean, kind: 'review', source: 'chat', revision: opts.basePending?.kind === 'review' ? (opts.basePending.revision || 1) + 1 : 1,
    ...(opts.basePending?.kind === 'review' ? { parentProposalId: opts.basePending.id } : {}),
    scope: { kind: 'routine', routineId: targetRoutineId } };
}
export function chatSnapshot(p) {
  if (!p || p.kind !== 'review') return null;
  return { id: p.id, revision: p.revision || 1, scope: p.scope || null, summary: String(p.summary || '').slice(0, 1200),
    changes: (p.changes || []).slice(0, 10).map(c => ({ type: c.type, target: { routineId: c.target?.routineId, exId: c.target?.exId }, before: c.before, after: c.after, why: String(c.why || '').slice(0, 600) })) };
}

export function chatRequestSignature(opts) {
  return fingerprint({ text: opts.note || '', lang: opts.lang || null, proposalRef: opts.proposalRef || null, scope: opts.scope || null, contextRef: opts.contextRef || null });
}
export function replayChatRequest(requests, opts, mode = 'server') {
  const found = (requests || []).find(x => x.clientRequestId === opts.clientRequestId && x.mode === mode && Date.now() - x.at < 864e5);
  if (!found) return null;
  if (found.signature !== chatRequestSignature(opts)) throw error('invalid_request');
  return { job: { id: found.jobId }, replayed: true };
}
export function rememberChatRequest(requests, opts, jobId, mode = 'server') {
  return [...(requests || []).filter(x => Date.now() - x.at < 864e5), { clientRequestId: opts.clientRequestId, signature: chatRequestSignature(opts), jobId, mode, at: Date.now() }].slice(-64);
}
export function containsChatProposal(p) {
  return waitingProposal(p)?.source === 'chat';
}
