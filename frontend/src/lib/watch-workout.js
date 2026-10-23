import { ensureWatchIdentity } from './watch-identity.js'
import { fingerprint } from '../../../api/coach/core/debrief-selection.js'
import { isWarmupRow } from './workout-model.js'
import { exOr } from './exercises.js'
import { exerciseNameFor } from './i18n-core.js'
import { watchSidOf, elapsedMsOf } from './session-resume.js'
import { buildSessionEntries } from './session-start.js'
import { effectiveRoutineIds } from './history.js'
import { todayISO } from './format.js'

/** 活动条目只存 id；计划与重连快照必须和手机界面解析出相同名称。 */
export function watchExercisesOf(S, entries) {
  return entries.map(e => {
    const ex = S.customEx?.find(x => x.id === e.id) || exOr(e.id)
    const rows = e.sets.filter(x => !isWarmupRow(x))
    return { id: e.id, entryInstanceId: e.entryInstanceId, weightUnit: S.unit || 'kg', setIds: rows.map(r => r.setId), name: e.id ? exerciseNameFor(ex) : e.name || '', sets: rows.length,
      reps: rows[0]?.sec != null ? rows[0].sec + '秒' : rows[0]?.r ?? rows[0]?.reps ?? '',
      restSec: e.target?.restSec > 0 ? e.target.restSec : S.restSec || 60, weight: rows[0]?.w ?? '' }
  })
}

/** 会话存在于全局 store，切换到设置页不应撤销它的手表计划。 */
export function watchPlanOf(S) {
  const A = S.active
  if (!A?.start || A.editingWorkoutId) return null
  const profile = watchProfileOf(S)
  return {
    sid: watchSidOf(A), protocolVersion: 2, weightUnit: S.unit || 'kg', structureRevision: A.structureRevision,
    profile,
    workout: { name: A.name, exercises: watchExercisesOf(S, A.entries) },
  }
}

export function watchSnapshotOf(S, timer, now = Date.now()) {
  const A = S.active, plan = watchPlanOf(S)
  if (!plan) return null
  const ex = Number.isInteger(A.watchFocus?.ex) ? A.watchFocus.ex : (A.cur || 0)
  const rows = A.entries.map(e => e.sets.filter(r => !isWarmupRow(r)).map(r => ({
    setId: r.setId, w: r.w ?? '', r: r.sec ?? r.reps ?? r.r ?? '', done: !!r.done, at: r.at || 0,
  })))
  const first = (rows[ex] || []).findIndex(r => !r.done)
  return { ...plan, workout: A.name, exercises: plan.workout.exercises, rows,
    rev: now, startedAt: now - elapsedMsOf(A, now) - (A.pausedMs || 0) - (A.pausedAt ? now - A.pausedAt : 0),
    segmentStartedAt: A.segmentStartedAt || A.start,
    exIdx: ex, setIdx: A.watchFocus?.ex === ex ? A.watchFocus.set - 1 : first < 0 ? 0 : first,
    focusAt: Number(A.watchFocus?.at || A.watchFocusAt || 0),
    ackedEvents: A.watchEvents || [], pausedAt: A.pausedAt || 0, pausedMs: A.pausedMs || 0,
    pauseVersion: A.pauseVersion || 0, baseCalories: Object.entries(A.watchSegments || {}).filter(([id]) => id !== watchSidOf(A)).reduce((n, [, s]) => n + s.calories, 0),
    rest: timer ? { restId: timer.restId || String(timer.startedAt || timer.endsAt - timer.total * 1000),
      startedAt: timer.startedAt || timer.endsAt - timer.total * 1000, endsAt: timer.ready || timer.paused ? 0 : timer.endsAt,
      leftSec: timer.paused ? timer.left : timer.ready ? 0 : Math.max(0, Math.ceil((timer.endsAt - now) / 1000)),
      totalSec: timer.total, paused: !!timer.paused, seq: timer.seq || timer.startedAt || now } : { leftSec: 0, totalSec: 0, seq: A.restVersion || 0 },
    restUntil: timer && !timer.ready ? timer.endsAt : 0 }
}

export function watchCatalogOf(S, date = todayISO()) {
  const today = effectiveRoutineIds({ ...S, routines: S.routines || [], dayPlan: S.dayPlan || {}, week: S.week || {}, workouts: S.workouts || [] }, date, date)
  const ids = [...new Set([...today, ...(S.watchPlanIds || [])])]
  const profile = watchProfileOf(S)
  return { t: 'plan_catalog', date, at: Date.now(), plans: ids.map(id => {
    const routine = S.routines?.find(r => r.id === id)
    if (!routine) return null
    const entries = buildSessionEntries(S, routine)
    ensureWatchIdentity({ entries }, 'catalog:' + routine.id + ':' + fingerprint(routine.ex || []))
    const exercises = watchExercisesOf(S, entries)
    return { protocolVersion: 2, weightUnit: S.unit || 'kg', id: routine.id, name: routine.name, today: today.includes(id), available: exercises.length > 0,
      exercises, entries, profile, rows: entries.map(e => e.sets.filter(r => !isWarmupRow(r)).map(r => ({ setId: r.setId, w: r.w ?? '', r: r.sec ?? r.r ?? '', done: false, at: 0 }))) }
  }).filter(Boolean) }
}

export function watchProfileOf(S) {
  const bw = S.bodyweight?.at(-1)?.w
  const known = typeof bw === 'number' && Number.isFinite(bw) && bw > 0
  const bodyWeightKg = known ? Math.round((S.unit === 'lb' ? bw * 0.45359237 : bw) * 10) / 10 : 70
  return { weight: bodyWeightKg, bodyWeightKg, bodyWeightSource: known ? 'recorded' : 'default', weightUnit: S.unit || 'kg' }
}
