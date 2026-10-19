import { watchSidOf } from './session-resume.js'
import { watchSnapshotOf } from './watch-workout.js'
import { isWarmupRow } from './workout-model.js'

export function endedWatchSession(S, sid) {
  const saved = S.workouts?.find(w => w.watchSid === sid || String(w.start) === sid || w.watchSids?.includes(sid) || w.watchSegments?.[sid])
  return { t: 'ended', sid, endedAt: saved?.finishedAt || saved?.end || Date.now(),
    reason: saved ? 'finished' : 'no_active_session' }
}

// Segment identity prevents an offline summary from ending a resumed training session.
export function applyWatchSummary(S, ev) {
  if (!ev?.sid || !Number.isFinite(Number(ev.calories)) || Number(ev.calories) < 0) return false
  const active = S.active && watchSidOf(S.active) === ev.sid ? S.active : null
  const target = active || S.workouts?.find(w => w.watchSid === ev.sid || String(w.start) === ev.sid || w.watchSids?.includes(ev.sid) || w.watchSegments?.[ev.sid])
  if (!target) return false
  const segments = target.watchSegments || {}
  const previous = segments[ev.sid]
  if (previous?.at > ev.at) return true
  target.watchSegments = { ...segments, [ev.sid]: {
    calories: Math.min(100000, Number(ev.calories)), avgHr: Number(ev.avgHr) || 0,
    maxHr: Number(ev.maxHr) || 0, at: Number(ev.at) || 0,
    source: 'watch_estimate',
  } }
  target.calories = Object.values(target.watchSegments).reduce((n, s) => n + s.calories, 0)
  target.calorieSource = 'watch_estimate'
  return true
}

export function createWatchLifecycle({ getState, update, getTimer, sendEnded, sendSync, sendAck, finish }) {
  return ev => {
    const current = getState()
    if (ev.t === 'hello') {
      const snapshot = watchSnapshotOf(current, getTimer())
      if (ev.sid && (!snapshot || snapshot.sid !== ev.sid)) sendEnded(endedWatchSession(current, ev.sid))
      if (snapshot) sendSync(snapshot)
      return true
    }
    if (ev.t !== 'end' && ev.t !== 'summary') return false
    let accepted = false
    update(s => {
      accepted = applyWatchSummary(s, ev)
      if (ev.t === 'end' && watchSidOf(s.active) === ev.sid && Array.isArray(ev.completedSets)) {
        for (const set of ev.completedSets) {
          const entry = s.active.entries[set.ex]
          const row = entry?.sets.filter(r => !isWarmupRow(r))[set.set - 1]
          if (!row) continue
          row.done = true; row.at = Number(set.at) || ev.endedAt || Date.now()
          const weight = parseFloat(set.weight)
          if (Number.isFinite(weight) && weight >= 0) row.w = weight
          if (set.reps != null) { row.r = String(set.reps); row.reps = String(set.reps) }
        }
      }
    })
    if (ev.t === 'end' && !current.active?.editingWorkoutId && watchSidOf(current.active) === ev.sid) finish(ev.endedAt)
    if (accepted || ev.t === 'end') sendAck(ev.at)
    return true
  }
}
