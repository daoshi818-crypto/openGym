import { watchSidOf } from './session-resume.js'
import { watchSnapshotOf, watchCatalogOf } from './watch-workout.js'
import { isWarmupRow } from './workout-model.js'
import { applyWatchEvent, startFromWatch, rememberClose } from './watch-events.js'

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

export function createWatchLifecycle({ getState, update, getTimer, sendEnded, sendSync, sendAck, finish, send = () => {}, rest = () => {}, pause = () => {}, stop = () => {} }) {
  return ev => {
    const current = getState()
    const ack = () => sendAck(ev.at, ev.eventId)
    const sync = () => { const snap = watchSnapshotOf(getState(), getTimer()); if (snap) sendSync(snap) }
    if (ev.t === 'watch_start') {
      let status
      update(s => { status = startFromWatch(s, ev) })
      send({ t: 'watch_start_ack', status, sid: ev.sid, eventId: ev.eventId, at: ev.at,
        snapshot: status === 'conflict' ? watchSnapshotOf(getState(), getTimer()) : null })
      if (status === 'started') { ack(); sync() }
      else if (status === 'closed') {
        const close = getState().watchClosed?.[ev.sid]
        ack(); send({ t: 'session_close', sid: ev.sid, disposition: close?.disposition || 'saved',
          closedAt: close?.closedAt, eventId: close?.eventId })
      }
      return true
    }
    if (ev.t === 'hello') {
      send(watchCatalogOf(current))
      for (const close of Object.values(current.watchClosed || {})) send({ t: 'session_close', sid: close.sid,
        disposition: close.disposition, closedAt: close.closedAt, eventId: close.eventId })
      const snapshot = watchSnapshotOf(current, getTimer())
      if (ev.sid && !ev.pendingStart && (!snapshot || snapshot.sid !== ev.sid)) sendEnded(endedWatchSession(current, ev.sid))
      if (snapshot) sendSync(snapshot)
      return true
    }
    if (ev.t === 'session_close_ack') return true
    if (ev.t === 'session_close') {
      const prior = current.watchClosed?.[ev.sid]
      if (prior && prior.eventId === ev.eventId && ev.eventId) { ack(); return true }
      const same = watchSidOf(current.active) === ev.sid && !current.active?.editingWorkoutId
      if (ev.disposition === 'saved' && (!same || prior)) {
        update(s => {
          s.watchPendingSaves ||= {}
          const key = ev.eventId || ev.sid + ':' + ev.closedAt
          if (!s.watchSaveDecisions?.[key]) s.watchPendingSaves[key] = ev
          if (!s.watchClosed?.[ev.sid]) rememberClose(s, ev)
        })
        ack(); return true
      }
      if (prior) { ack(); return true }
      if (ev.disposition === 'saved') {
        update(s => {
          applyWatchSummary(s, { ...ev, ...(ev.summary || {}), at: ev.closedAt || ev.at })
          if (same) for (const set of ev.completedSets || []) applyWatchEvent(s, { ...set, sid: ev.sid, t: 'set', eventId: ev.eventId + ':' + set.ex + ':' + set.set })
        })
        if (same) finish(ev.closedAt)
      } else if (same) update(s => { s.active = null })
      update(s => rememberClose(s, ev))
      if (same) stop()
      ack()
      return true
    }
    if (ev.t === 'pause') {
      if (watchSidOf(current.active) === ev.sid && (ev.seq || 0) > (current.active.pauseVersion || 0)) {
        update(s => {
          const a = s.active
          a.pauseVersion = ev.seq
          if (ev.paused && !a.pausedAt) a.pausedAt = ev.at || Date.now()
          else if (!ev.paused && a.pausedAt) { a.pausedMs = (a.pausedMs || 0) + Math.max(0, (ev.at || Date.now()) - a.pausedAt); a.pausedAt = 0 }
        })
        pause(ev.paused)
      }
      ack(); sync(); return true
    }
    if (ev.t === 'rest') {
      if (watchSidOf(current.active) === ev.sid && (ev.seq || 0) >= Math.max(current.active.restVersion || 0, getTimer()?.seq || 0)) {
        update(s => { s.active.restVersion = ev.seq || Date.now() })
        rest(ev)
      }
      ack(); sync(); return true
    }
    if (['weight', 'reps', 'set', 'unset', 'add_set', 'remove_set', 'focus'].includes(ev.t)) {
      let accepted = false
      const wasDone = current.active?.entries?.[ev.ex]?.sets.filter(r => !isWarmupRow(r))[ev.set - 1]?.done
      update(s => { accepted = applyWatchEvent(s, ev) })
      if (accepted) {
        if (ev.t === 'set' && !wasDone && ev.rest) rest(ev.rest)
        ack(); sync()
      } else if (current.watchClosed?.[ev.sid]) ack()
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
