import { watchSidOf } from './session-resume.js'
import { watchSnapshotOf, watchCatalogOf } from './watch-workout.js'
import { isWarmupRow } from './workout-model.js'
import { applyWatchEvent, applyWatchEffort, startFromWatch, rememberClose } from './watch-events.js'
import { resolveWatchTarget } from './watch-identity.js'
import { pruneWatchClosed } from './watch-retention.js'
import { finiteKcal, isSegmentAtLeast, workoutCaloriesOf } from './workout-calories.js'

export function endedWatchSession(S, sid) {
  const saved = S.workouts?.find(w => w.watchSid === sid || String(w.start) === sid || w.watchSids?.includes(sid) || w.watchSegments?.[sid])
  return { t: 'ended', sid, endedAt: saved?.finishedAt || saved?.end || Date.now(),
    reason: saved ? 'finished' : 'no_active_session' }
}

// Segment identity prevents an offline summary from ending a resumed training session.
export function applyWatchSummary(S, ev) {
  const calories = finiteKcal(ev?.calories)
  if (!ev?.sid || calories == null) return false
  const active = S.active && watchSidOf(S.active) === ev.sid ? S.active : null
  const target = active || S.workouts?.find(w => w.watchSid === ev.sid || String(w.start) === ev.sid || w.watchSids?.includes(ev.sid) || w.watchSegments?.[ev.sid])
  if (!target) return false
  const segments = target.watchSegments || {}
  const previous = segments[ev.sid]
  if (previous && !isSegmentAtLeast(ev, previous)) return true
  const incomingSeq = finiteKcal(ev.seq)
  const incomingAt = finiteKcal(ev.at)
  target.watchSegments = { ...segments, [ev.sid]: {
    calories: Math.min(100000, calories), avgHr: Number(ev.avgHr) || 0,
    maxHr: Number(ev.maxHr) || 0, ...(incomingAt != null ? { at: incomingAt } : {}),
    ...(incomingSeq != null ? { seq: incomingSeq } : {}),
    source: 'watch_estimate',
  } }
  target.calories = workoutCaloriesOf(target).kcal
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
      update(s => { pruneWatchClosed(s) })
      send(watchCatalogOf(current))
      for (const close of Object.values(getState().watchClosed || {}).filter(c => !c.acknowledgedAt || c.sid === ev.sid)) send({ t: 'session_close', sid: close.sid,
        disposition: close.disposition, closedAt: close.closedAt, eventId: close.eventId })
      const snapshot = watchSnapshotOf(current, getTimer())
      if (ev.sid && !ev.pendingStart && (!snapshot || snapshot.sid !== ev.sid)) sendEnded(endedWatchSession(current, ev.sid))
      if (snapshot) sendSync(snapshot)
      return true
    }
    if (ev.t === 'session_close_ack') {
      update(s => { const close = s.watchClosed?.[ev.sid]; if (close && (!ev.eventId || close.eventId === ev.eventId)) { close.acknowledgedAt = Date.now(); if (!Object.values(s.watchPendingSaves || {}).some(e => e.sid === ev.sid)) delete close.entries } })
      return true
    }
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
    if (ev.t === 'effort') {
      // 评分有独立的版本域与冲突裁决：应用/过期都算已处理；冲突把手机现值交回手表，
      // 让手表重新确认，而不是静默覆盖任何一方。
      let result = { status: 'rejected' }
      update(s => { result = applyWatchEffort(s, ev) })
      if (result.status === 'applied' || result.status === 'stale') { ack(); sync() }
      else if (result.status === 'conflict') {
        send({ t: 'effort_ack', eventId: ev.eventId, sid: ev.sid, status: 'conflict',
          scale: result.scale || ev.scale, value: result.value, version: result.version })
        ack(); sync()
      } else if (current.watchClosed?.[ev.sid]) ack()
      else { send({ t: 'event_rejected', eventId: ev.eventId, sid: ev.sid, reason: result.reason || 'target_changed' }); sync() }
      return true
    }
    if (['weight', 'reps', 'set', 'unset', 'add_set', 'remove_set', 'focus'].includes(ev.t)) {
      let accepted = false
      const wasDone = resolveWatchTarget(current.active, ev)?.row?.done
      update(s => { accepted = applyWatchEvent(s, ev) })
      if (accepted) {
        if (ev.t === 'set' && !wasDone && ev.rest) rest(ev.rest)
        ack(); sync()
      } else if (current.watchClosed?.[ev.sid]) ack()
      else { send({ t: 'event_rejected', eventId: ev.eventId, sid: ev.sid, reason: 'target_changed' }); sync() }
      return true
    }
    if (ev.t !== 'end' && ev.t !== 'summary') return false
    let accepted = false
    update(s => {
      accepted = applyWatchSummary(s, ev)
      if (ev.t === 'end' && watchSidOf(s.active) === ev.sid && Array.isArray(ev.completedSets)) {
        for (const set of ev.completedSets) {
          applyWatchEvent(s, { ...set, sid: ev.sid, t: 'set', eventId: (ev.eventId || ev.sid) + ':' + set.ex + ':' + set.set })
          // 结束数据里的评分是最后一份权威值：按同一版本规则合并（不清除未提及的字段）。
          if (set.rpe != null || set.rir != null || set.effortCleared === true) {
            applyWatchEffort(s, { ...set, sid: ev.sid, t: 'effort', clear: set.effortCleared === true,
              scale: set.rpe != null ? 'rpe' : 'rir', value: set.rpe != null ? set.rpe : set.rir,
              effortVersion: set.effortVersion || ev.endedAt || ev.at,
              eventId: (ev.eventId || ev.sid) + ':effort:' + set.ex + ':' + set.set })
          }
        }
      }
    })
    if (ev.t === 'end' && !current.active?.editingWorkoutId && watchSidOf(current.active) === ev.sid) finish(ev.endedAt)
    // 精确回执：汇总必须带 eventId，手表才能把关闭日志标成已送达并只清掉那一条。
    // 只用时间戳回执会把同一时刻之后尚未确认的事件一起删掉（W06/W08）。
    if (accepted || ev.t === 'end') sendAck(ev.at, ev.eventId)
    return true
  }
}
