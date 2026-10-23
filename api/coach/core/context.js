import { fingerprint } from './debrief-selection.js';
export function scheduleHash(S) {
  return fingerprint({ week: S.week || {}, dayPlan: S.dayPlan || {}, scheduleMode: S.scheduleMode || 'week', queue: S.queue || null, rotation: S.rotation || null });
}
export function coachContext(S, planHash, scope = null) {
  return { version: 2, unit: S.unit || 'kg', planHash, scheduleHash: scheduleHash(S), profileRevision: fingerprint(S.coach?.profile || null), scope };
}
