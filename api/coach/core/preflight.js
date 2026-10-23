import { hasCoachConsent } from './consent.js';
import { legacySelection, resolveDebriefSelection, selectionError } from './debrief-selection.js';
export function prepareCoachRequest(S, kind, options = {}) {
  if (!hasCoachConsent(S)) throw selectionError('consent');
  const opts = { ...options };
  if (opts.scope) {
    if (opts.scope.kind !== 'routine' || typeof opts.scope.routineId !== 'string' || !(S.routines || []).some(r => r.id === opts.scope.routineId)) throw selectionError('scope_missing');
    opts.scope = { kind: 'routine', routineId: opts.scope.routineId };
  }
  if (kind === 'debrief') {
    opts.debriefSelection = opts.debriefSelection || legacySelection(S, opts.workoutId);
    resolveDebriefSelection(S, opts.debriefSelection);
  }
  return opts;
}
export function assertPayloadSize(payload, maximum = 300000) {
  if (JSON.stringify(payload).length > maximum) throw selectionError('toolarge');
  return payload;
}
