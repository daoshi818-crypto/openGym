import { isWarmupRow } from './workout-model.js'
import { watchSidOf } from './session-resume.js'
import { todayISO } from './format.js'

const keyOf = ev => ev.eventId || [ev.sid, ev.t, ev.ex, ev.set, ev.at].join(':')
const rememberEvent = (A, key) => { A.watchEvents = [...(A.watchEvents || []), key].slice(-4000) }
export function applyWatchEvent(S, ev) {
  const A = S.active
  if (!A || watchSidOf(A) !== ev.sid || A.editingWorkoutId) return false
  const key = keyOf(ev)
  if ((A.watchEvents || []).includes(key)) return true
  const entry = A.entries[ev.ex]
  const rows = entry?.sets.filter(r => !isWarmupRow(r))
  const row = rows?.[ev.set - 1]
  const version = Number(ev.seq || ev.at) || 0
  A.watchVersions ||= {}
  const field = ev.t === 'focus' ? 'focus' : ['weight', 'reps'].includes(ev.t) ? ev.t : ['set', 'unset'].includes(ev.t) ? 'done' : 'structure'
  const versionKey = [ev.ex, field === 'structure' ? '' : ev.set, field].join(':')
  if (version < (A.watchVersions[versionKey] || 0)) { rememberEvent(A, key); return true }
  if (ev.t === 'focus') {
    if (!entry || !row || version <= (A.watchFocus?.at || 0)) { rememberEvent(A, key); return true }
    A.cur = ev.ex; A.watchFocus = { ex: ev.ex, set: ev.set, at: version }
  } else if (ev.t === 'add_set') {
    if (!rows || rows.length >= 100) return false
    const target = Math.min(100, Number(ev.sets || ev.set) || rows.length + 1)
    while (entry.sets.filter(r => !isWarmupRow(r)).length < target) entry.sets.push({
      ...(rows.at(-1) || {}), w: ev.weight === '' ? undefined : Number(ev.weight ?? rows.at(-1)?.w) || undefined,
      r: String(ev.reps ?? rows.at(-1)?.r ?? ''), done: false, at: 0,
    })
  } else if (ev.t === 'remove_set') {
    const target = Math.max(1, Number(ev.sets != null ? ev.sets : ev.set - 1))
    if (!rows || rows.slice(target).some(r => r.done)) return false
    entry.sets = entry.sets.filter(r => isWarmupRow(r) || rows.indexOf(r) < target)
  } else if (['weight', 'reps', 'set', 'unset'].includes(ev.t)) {
    if (!row) return false
    if (ev.weight != null && version >= (A.watchVersions[[ev.ex, ev.set, 'weight'].join(':')] || 0)) {
      row.w = ev.weight === '' ? undefined : Math.max(0, Number(ev.weight) || 0)
      A.watchVersions[[ev.ex, ev.set, 'weight'].join(':')] = version
    }
    if (ev.reps != null && version >= (A.watchVersions[[ev.ex, ev.set, 'reps'].join(':')] || 0)) {
      if (row.sec != null) row.sec = Math.max(0, Number(ev.reps) || 0)
      else { row.r = String(ev.reps); row.reps = String(ev.reps) }
      A.watchVersions[[ev.ex, ev.set, 'reps'].join(':')] = version
    }
    if (ev.t === 'set' || ev.t === 'unset') { row.done = ev.t === 'set'; row.at = row.done ? ev.at || Date.now() : 0 }
  } else return false
  A.watchVersions[versionKey] = version
  rememberEvent(A, key)
  return true
}

export function startFromWatch(S, ev) {
  if (S.watchClosed?.[ev.sid]) return 'closed'
  if (S.active) return watchSidOf(S.active) === ev.sid ? 'started' : 'conflict'
  if (S.workouts?.some(w => w.watchSid === ev.sid || w.watchSids?.includes(ev.sid))) return 'closed'
  const p = ev.plan
  if (!p?.entries?.length || p.entries.length > 100 || !ev.sid || p.entries.some(e => !Array.isArray(e.sets) || e.sets.length > 100)) return 'invalid_plan'
  S.active = { id: ev.sid, watchSid: ev.sid, start: Number(ev.startedAt) || Date.now(), d: todayISO(),
    name: p.name, routineIds: [p.id], entries: JSON.parse(JSON.stringify(p.entries)), cur: 0,
    workoutView: S.workoutView || 'cards' }
  return 'started'
}

export function rememberClose(S, ev) {
  S.watchClosed = { ...S.watchClosed, [ev.sid]: { sid: ev.sid, disposition: ev.disposition,
    closedAt: ev.closedAt || Date.now(), eventId: ev.eventId || 'phone:' + ev.sid,
    ...(ev.entries ? { entries: JSON.parse(JSON.stringify(ev.entries)) } : {}) } }
}
