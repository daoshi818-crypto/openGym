const isWarmup = s => s?.phase ? ['warmup','warm-up','warm_up'].includes(String(s.phase).trim().toLowerCase()) : s?.warmup === true;
const number = v => Number.isFinite(Number(v)) && (typeof v === 'number' || typeof v === 'string') ? Number(v) : 0;
export function debriefEvidence(payload) {
  const sessions = (payload.sessions || []).map(w => {
    let sets = 0, volume = 0;
    const lifts = (w.entries || []).map(e => {
      const done = (e.sets || []).filter(s => s.done && !isWarmup(s));
      sets += done.length;
      const vol = done.reduce((n, s) => n + Math.max(0, number(s.w)) * Math.max(0, number(s.r)), 0);
      volume += vol;
      return { id: e.id, sets: done.length, volume: Math.round(vol), bestWeight: Math.max(0, ...done.map(s => number(s.w))) };
    });
    return { ref: w.ref, id: w.id, d: w.d, name: w.name, minutes: w.minutes, sets, volume: Math.round(volume), prs: w.prs, lifts: lifts.slice(0, 100) };
  });
  return { version: 2, unit: payload.meta.unit, scope: payload.debriefScope, sessions,
    totals: { sessions: sessions.length, sets: sessions.reduce((n,s) => n+s.sets, 0), volume: sessions.reduce((n,s) => n+s.volume, 0) },
    limitations: payload.dataLimitations || [] };
}
export function debriefMetadata(payload) {
  const evidence = debriefEvidence(payload), scope = evidence.scope;
  const last = evidence.sessions.at(-1);
  return { scope, evidenceSnapshot: evidence,
    workout: scope.mode === 'plan' ? { id: null, d: scope.to, name: scope.planName, sessions: scope.actual }
      : last ? { ...last, vol: last.volume } : null };
}
