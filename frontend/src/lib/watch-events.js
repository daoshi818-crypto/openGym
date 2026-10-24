import { resolveWatchTarget, convertWatchWeight, ensureWatchIdentity } from './watch-identity.js'
import { isWarmupRow } from './workout-model.js'
import { watchSidOf } from './session-resume.js'
import { todayISO } from './format.js'

const keyOf = ev => ev.eventId || [ev.sid, ev.t, ev.ex, ev.set, ev.at].join(':')
const rememberEvent = (A, key) => { A.watchEvents = [...(A.watchEvents || []), key].slice(-4000) }

/**
 * 手表登记的一组强度（RPE/RIR）落到手机活动会话。
 *
 * 用独立于 done/weight/rest 的 `effortVersion` 判新旧：
 *  - 版本更旧 → stale（保留现值，不回退；已清除的评分不会被旧消息复活）；
 *  - 手表基于旧版本编辑（baseEffortVersion 落后于现值版本）→ conflict，返回现值让手表收敛；
 *  - 其余按到达顺序应用，且只写 rpe 或 rir 一个字段（明确换量表时清掉另一个）。
 * 返回 {status, version, value, scale}，调用方据此 ACK 或告知冲突。
 */
export function applyWatchEffort(S, ev) {
  const A = S.active
  if (!A || watchSidOf(A) !== ev.sid || A.editingWorkoutId) return { status: 'rejected', reason: 'no_session' }
  ensureWatchIdentity(A)
  const key = keyOf(ev)
  // Same event replayed: a durable decision already exists, so it is a confirmable duplicate.
  if ((A.watchEvents || []).includes(key)) return { status: 'applied', duplicate: true }
  const target = resolveWatchTarget(A, ev)
  if (!target || !target.row) return { status: 'rejected', reason: 'target_changed' }
  const { row } = target
  const version = Number(ev.effortVersion || ev.seq || ev.at) || 0
  const current = Number.isFinite(row.effortVersion) ? row.effortVersion : 0
  const currentKind = row.rpe != null ? 'rpe' : row.rir != null ? 'rir' : null
  const currentOut = { status: 'x', version: current, value: currentKind ? row[currentKind] : null, scale: currentKind }
  // A rating edited on the watch while the phone changed the same set: the two clocks cannot
  // decide this, so report a conflict with the phone's value and let the watch re-confirm.
  const base = Number(ev.baseEffortVersion) || 0
  if (base && current > base) { rememberEvent(A, key); return { ...currentOut, status: 'conflict' } }
  if (version && current && version < current) { rememberEvent(A, key); return { ...currentOut, status: 'stale' } }
  const scale = ev.scale === 'rpe' || ev.scale === 'rir' ? ev.scale : null
  const cleared = ev.clear === true || ev.value == null
  delete row.rpe
  delete row.rir
  if (!cleared && scale && Number.isFinite(Number(ev.value))) row[scale] = Number(ev.value)
  row.effortVersion = version || current || Date.now()
  rememberEvent(A, key)
  return { status: 'applied', version: row.effortVersion, value: cleared ? null : row[scale], scale }
}
export function applyWatchEvent(S, ev) {
  const A = S.active
  if (!A || watchSidOf(A) !== ev.sid || A.editingWorkoutId) return false
  ensureWatchIdentity(A)
  const key = keyOf(ev)
  if ((A.watchEvents || []).includes(key)) return true
  const target = resolveWatchTarget(A, ev)
  if (!target) return false
  const { entry, rows, row } = target
  ev = { ...ev, ex: target.ex, set: target.set }
  if (ev.weight != null) {
    const weight = convertWatchWeight(ev.weight, ev.weightUnit || S.unit || 'kg', S.unit || 'kg')
    if (weight == null) return false
    ev.weight = weight
  }
  const version = Number(ev.seq || ev.at) || 0
  A.watchVersions ||= {}
  const field = ev.t === 'focus' ? 'focus' : ['weight', 'reps'].includes(ev.t) ? ev.t : ['set', 'unset'].includes(ev.t) ? 'done' : 'structure'
  const versionKeyFor = field => [entry.entryInstanceId || ev.ex, field === 'structure' ? '' : row?.setId || ev.set, field].join(':')
  const versionKey = versionKeyFor(field)
  if (version < (A.watchVersions[versionKey] || 0)) { rememberEvent(A, key); return true }
  if (ev.t === 'focus') {
    if (!entry || !row || version <= (A.watchFocus?.at || 0)) { rememberEvent(A, key); return true }
    A.cur = ev.ex; A.watchFocus = { ex: ev.ex, set: ev.set, at: version }
  } else if (ev.t === 'add_set') {
    if (!rows || rows.length >= 100) return false
    const stable = Array.isArray(ev.newSetIds) && !!ev.entryInstanceId
    const added = stable ? ev.newSetIds.filter(id => typeof id === 'string' && id.startsWith('watch-set:') && !rows.some(r => r.setId === id)) : []
    if (added.some(id => A.watchRemovedSets?.includes(id)) || new Set(added).size !== added.length || rows.length + added.length > 100) return false
    const target = stable ? rows.length + added.length : Math.min(100, Number(ev.sets || ev.set) || rows.length + 1)
    let nextId = 0
    while (entry.sets.filter(r => !isWarmupRow(r)).length < target) entry.sets.push({
      ...(rows.at(-1) || {}), setId: stable ? added[nextId++] : undefined, w: ev.weight === '' ? undefined : Number(ev.weight ?? rows.at(-1)?.w) || undefined,
      r: String(ev.reps ?? rows.at(-1)?.r ?? ''), done: false, at: 0,
    })
  } else if (ev.t === 'remove_set') {
    const target = Math.max(1, Number(ev.sets != null ? ev.sets : ev.set - 1))
    const removed = ev.entryInstanceId ? rows.filter(r => ev.removedSetIds?.includes(r.setId)) : rows.slice(target)
    if (ev.entryInstanceId && !Array.isArray(ev.removedSetIds) || !rows || removed.some(r => r.done) || rows.length - removed.length < 1) return false
    A.watchRemovedSets = [...new Set([...(A.watchRemovedSets || []), ...removed.map(r => r.setId).filter(Boolean)])].slice(-4000)
    entry.sets = entry.sets.filter(r => !removed.includes(r))
  } else if (['weight', 'reps', 'set', 'unset'].includes(ev.t)) {
    if (!row) return false
    if (ev.weight != null && version >= (A.watchVersions[versionKeyFor('weight')] || 0)) {
      row.w = ev.weight === '' ? undefined : Math.max(0, Number(ev.weight) || 0)
      A.watchVersions[versionKeyFor('weight')] = version
    }
    if (ev.reps != null && version >= (A.watchVersions[versionKeyFor('reps')] || 0)) {
      if (row.sec != null) row.sec = Math.max(0, Number(ev.reps) || 0)
      else { row.r = String(ev.reps); row.reps = String(ev.reps) }
      A.watchVersions[versionKeyFor('reps')] = version
    }
    if (ev.t === 'set' || ev.t === 'unset') { row.done = ev.t === 'set'; row.at = row.done ? ev.at || Date.now() : 0 }
  } else return false
  ensureWatchIdentity(A)
  A.watchVersions[versionKey] = version
  rememberEvent(A, key)
  return true
}

export function startFromWatch(S, ev) {
  if (S.watchClosed?.[ev.sid]) return 'closed'
  if (S.active) return watchSidOf(S.active) === ev.sid ? 'started' : 'conflict'
  if (S.workouts?.some(w => w.watchSid === ev.sid || w.watchSids?.includes(ev.sid))) return 'closed'
  const p = ev.plan
  if (!Number.isFinite(ev.startedAt) || ev.startedAt <= 0 || ev.startedAt > Date.now() + 300000) return 'invalid_plan'
  if (Date.now() - ev.startedAt > 7 * 864e5) return 'expired'
  if (!p?.entries?.length || p.entries.length > 100 || !ev.sid || p.entries.some(e => !Array.isArray(e.sets) || e.sets.length > 100)) return 'invalid_plan'
  const sourceUnit = p.weightUnit || S.unit || 'kg'
  const entries = JSON.parse(JSON.stringify(p.entries))
  if (sourceUnit !== (S.unit || 'kg')) for (const e of entries) for (const row of e.sets) if (row.w != null) row.w = convertWatchWeight(row.w, sourceUnit, S.unit || 'kg')
  S.active = { id: ev.sid, watchSid: ev.sid, start: Number(ev.startedAt) || Date.now(), d: todayISO(),
    name: p.name, routineIds: [p.id], entries, cur: 0,
    workoutView: S.workoutView || 'cards' }
  ensureWatchIdentity(S.active)
  return 'started'
}

export function rememberClose(S, ev) {
  S.watchClosed = { ...S.watchClosed, [ev.sid]: { ...S.watchClosed?.[ev.sid], sid: ev.sid, disposition: ev.disposition,
    closedAt: ev.closedAt || Date.now(), eventId: ev.eventId || 'phone:' + ev.sid,
    ...(ev.entries ? { entries: JSON.parse(JSON.stringify(ev.entries)) } : {}),
    ...(ev.elapsedBeforeMs != null ? { elapsedBeforeMs: ev.elapsedBeforeMs } : {}) } }
}
