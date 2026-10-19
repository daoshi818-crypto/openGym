import { legacySyncKey } from './workout-date.js'

export const watchSidOf = active => active?.watchSid || (active?.start ? String(active.start) : '')
export const elapsedMsOf = (active, now = Date.now()) => Math.max(0,
  active?.segmentStartedAt != null
    ? (active.elapsedBeforeMs || 0) + Math.max(0, (active.pausedAt || now) - active.segmentStartedAt - (active.pausedMs || 0))
    : (active?.pausedAt || now) - (active?.start || now) - (active?.pausedMs || 0))

export function resumeCompletedSession(state, ref, now = Date.now()) {
  if (state.active) throw new Error('Finish the current workout first.')
  const key = w => w.id ?? legacySyncKey(w)
  const original = state.workouts.find(w => key(w) === key(ref))
  if (!original) throw new Error('Workout deleted')
  const active = JSON.parse(JSON.stringify(original))
  active.id = key(original)
  active.resumeWorkoutId = active.id
  active.elapsedBeforeMs = original.durationMs ?? Math.max(0, original.end - original.start)
  active.segmentStartedAt = now
  active.pausedAt = 0
  active.pausedMs = 0
  active.watchSid = String(active.id) + ':' + now
  active.cur = Math.max(0, active.entries.findIndex(e => e.sets.some(r => !r.done)))
  for (const k of ['end', 'vol', 'prs', '_ts', 'durationMs']) delete active[k]
  state.active = active
  return active
}

export function saveResumedWorkout(state, active, completed) {
  const i = state.workouts.findIndex(w => (w.id ?? legacySyncKey(w)) === active.resumeWorkoutId)
  if (i < 0) throw new Error('Workout deleted')
  const segments = { ...state.workouts[i].watchSegments, ...completed.watchSegments }
  for (const [sid, summary] of Object.entries(state.workouts[i].watchSegments || {})) {
    if (!segments[sid] || summary.at > segments[sid].at) segments[sid] = summary
  }
  const record = { ...state.workouts[i], ...completed, id: active.resumeWorkoutId,
    ...(Object.keys(segments).length ? { watchSegments: segments,
      calories: Object.values(segments).reduce((n, s) => n + s.calories, 0), calorieSource: 'watch_estimate' } : {}) }
  state.workouts[i] = record
  return record
}
