import { validDay } from './dates.js';
// Pure selection contract shared by server, phone and demo.
export const DEBRIEF_SELECTION_VERSION = 2;
export const selectionError = code => Object.assign(new Error(code), { code, status: 409, data: { code } });
const list = v => Array.isArray(v) ? v : [];
export const legacyWorkoutKey = w => `${w?.d}|${w?.start}`;
export const workoutRefOf = w => w?.id != null ? { type: 'id', value: String(w.id) } : { type: 'legacy', value: legacyWorkoutKey(w) };
export const refKey = ref => `${ref?.type}:${ref?.value}`;
export function compareWorkouts(a, b) {
  return String(a?.d || '').localeCompare(String(b?.d || '')) || (Number(a?.start) || 0) - (Number(b?.start) || 0)
    || refKey(workoutRefOf(a)).localeCompare(refKey(workoutRefOf(b)));
}
export const sortedWorkouts = S => list(S?.workouts).filter(w => w && validDay(w.d)).slice().sort(compareWorkouts);
export const routineIdsOfWorkout = w => [...new Set([
  ...list(w?.routineIds), ...(w?.routineId != null ? [w.routineId] : []), ...list(w?.entries).map(e => e?.rid).filter(x => x != null)
])].sort();
export function sameWorkoutFamily(a, b) {
  const x = routineIdsOfWorkout(a), y = routineIdsOfWorkout(b);
  return x.length && y.length ? JSON.stringify(x) === JSON.stringify(y) : !!a?.name && a.name === b?.name;
}
export function resolveWorkoutRef(S, ref) {
  if (!ref || !['id', 'legacy'].includes(ref.type) || typeof ref.value !== 'string' || !ref.value || ref.value.length > 128) throw selectionError('invalid_selection');
  const matches = sortedWorkouts(S).filter(w => refKey(workoutRefOf(w)) === refKey(ref));
  if (matches.length !== 1) throw selectionError(matches.length ? 'ambiguous_workout' : 'noworkout');
  return matches[0];
}
export function projectWorkout(w, planId) {
  if (!routineIdsOfWorkout(w).includes(planId)) return null;
  const mixed = routineIdsOfWorkout(w).length > 1;
  const entries = mixed ? list(w.entries).filter(e => e?.rid === planId) : list(w.entries);
  if (mixed && (!entries.length || list(w.entries).some(e => e?.rid == null))) return null;
  return mixed ? { ...w, entries, routineIds: [planId], routineId: planId, vol: undefined,
    end: undefined, durationMs: undefined, prs: [], calories: undefined, calorieSource: undefined,
    watchSegments: undefined, _mixedProjection: true } : w;
}
export const workoutsForPlan = (S, planId) => sortedWorkouts(S).filter(w => projectWorkout(w, planId));
// A change detector, not a security hash.
export function fingerprint(value) {
  const text = JSON.stringify(value);
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 0x01000193); b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
const safeNumber = x => (typeof x === 'number' || typeof x === 'string') && String(x).trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null;
const text = (x, n) => typeof x === 'string' ? x.slice(0, n) : null;
function recordInput(w) {
  return { ref: workoutRefOf(w), d: w.d, start: safeNumber(w.start), end: safeNumber(w.end), durationMs: safeNumber(w.durationMs),
    name: text(w.name, 80), note: text(w.note, 500), rating: safeNumber(w.rating), routines: routineIdsOfWorkout(w), prs: list(w.prs).slice(0, 100),
    entries: list(w.entries).map(e => ({ id: text(e?.id, 64), rid: text(e?.rid, 64), note: text(e?.note, 500),
      target: Object.fromEntries(['sets','reps','sec','weight','mode','bodyweight','side'].map(k => [k, e?.target?.[k] ?? null])),
      sets: list(e?.sets).map(s => Object.fromEntries(['done','phase','warmup','failure','w','r','sec','min','speed','rir','rpe'].map(k => [k, s?.[k] ?? null]))) })) };
}
export function selectionHash(S, selection, records) {
  return fingerprint({ version: 2, unit: S.unit || 'kg', mode: selection.mode, planId: selection.planId || null,
    profile: S.coach?.profile || null, records: records.map(recordInput) });
}
export function resolveDebriefSelection(S, selection, { checkHash = true } = {}) {
  if (selection?.version !== 2 || !['single','plan'].includes(selection.mode)) throw selectionError('invalid_selection');
  const refs = list(selection.refs);
  if (!refs.length || refs.length > 10 || new Set(refs.map(refKey)).size !== refs.length || (selection.mode === 'single' && refs.length !== 1)) throw selectionError('invalid_selection');
  if (selection.mode === 'plan' && (![3,5,10].includes(selection.limit) || refs.length > selection.limit || typeof selection.planId !== 'string' || !list(S.routines).some(r => r.id === selection.planId))) throw selectionError('scope_missing');
  const originals = refs.map(ref => resolveWorkoutRef(S, ref)).sort(compareWorkouts);
  const records = originals.map(w => selection.mode === 'plan' ? projectWorkout(w, selection.planId) : w);
  if (records.some(w => !w)) throw selectionError('selection_stale');
  const inputHash = selectionHash(S, selection, records);
  if (checkHash && selection.inputHash !== inputHash) throw selectionError('selection_stale');
  return { records, originals, inputHash };
}
export function freezeSelection(S, shape) {
  const selection = { version: 2, mode: shape.mode, refs: shape.refs, planId: shape.mode === 'plan' ? shape.planId : null, limit: shape.mode === 'plan' ? shape.limit : 1 };
  const { inputHash } = resolveDebriefSelection(S, selection, { checkHash: false });
  return { ...selection, inputHash };
}
export const selectionForWorkout = (S, w) => freezeSelection(S, { mode: 'single', refs: [workoutRefOf(w)] });
export const selectionForPlan = (S, planId, limit = 5) => freezeSelection(S, { mode: 'plan', planId, limit, refs: workoutsForPlan(S, planId).slice(-limit).map(workoutRefOf) });
export function legacySelection(S, id) {
  const all = sortedWorkouts(S);
  const w = id != null && id !== '' ? resolveWorkoutRef(S, { type: 'id', value: String(id) }) : all.at(-1);
  if (!w) throw selectionError('noworkout');
  return selectionForWorkout(S, w);
}
