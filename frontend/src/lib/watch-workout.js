import { isWarmupRow } from './workout-model.js'
import { exOr } from './exercises.js'
import { exerciseNameFor } from './i18n-core.js'
import { watchSidOf, elapsedMsOf } from './session-resume.js'
import { effortOf, entryRoutineId } from './history.js'
import { EFFORT_CAPABILITY } from '../../../watch-app/src/lib/effort-scale.js'
import { watchLastTimeOf } from './watch-last-time.js'
import { loadOf, MUSCLES } from './muscles.js'

/**
 * 活动条目只存 id；计划与重连快照必须和手机界面解析出相同名称。
 *
 * 活动训练按 entryRoutineId 查每条记录的来源（合并日里同一个动作可以属于两个计划）。
 */
export function watchExercisesOf(S, entries, { routineId = null, sourceWorkout = null } = {}) {
  return entries.map(e => {
    const ex = S.customEx?.find(x => x.id === e.id) || exOr(e.id)
    const rows = e.sets.filter(x => !isWarmupRow(x))
    // 条目自带的 rid 优先于外层默认计划：合并日的自由动作因此仍查它自己的计划历史。
    const source = sourceWorkout ? entryRoutineId(sourceWorkout, e) : (e.rid || routineId || null)
    const muscles = Object.fromEntries(Object.entries(loadOf([{ id: e.id, ex, sets: 1 }]))
      .filter(([key, weight]) => MUSCLES.includes(key) && weight > 0)
      .map(([key, weight]) => [key, Math.round(weight * 100) / 100]))
    return { id: e.id, entryInstanceId: e.entryInstanceId, weightUnit: S.unit || 'kg', setIds: rows.map(r => r.setId), name: e.id ? exerciseNameFor(ex) : e.name || '', sets: rows.length,
      reps: rows[0]?.sec != null ? rows[0].sec + '秒' : rows[0]?.r ?? rows[0]?.reps ?? '',
      restSec: e.target?.restSec > 0 ? e.target.restSec : S.restSec || 60, weight: rows[0]?.w ?? '',
      ...(Object.keys(muscles).length ? { muscles } : {}), lastTime: watchLastTimeOf(S, e, source) }
  })
}

/** 会话存在于全局 store，切换到设置页不应撤销它的手表计划。 */
export function watchPlanOf(S) {
  const A = S.active
  if (!A?.start || A.editingWorkoutId) return null
  const profile = watchProfileOf(S)
  return {
    sid: watchSidOf(A), ...(A.watchSessionGeneration ? { sessionGeneration: A.watchSessionGeneration } : {}),
    protocolVersion: 2, weightUnit: S.unit || 'kg', structureRevision: A.structureRevision,
    // 强度量表跟随手机设置；手表只显示这一种，关闭（'none'）时隐藏入口。
    effortScale: effortOf(S), capabilities: { setEffort: EFFORT_CAPABILITY },
    profile,
    workout: { name: A.name, exercises: watchExercisesOf(S, A.entries, { sourceWorkout: A }) },
  }
}

/** Stable execution rows plus the small context used by the watch metrics screen. */
export function watchWorkoutDTOOf(workout, sid, requestId) {
  if (!sid || !requestId || !workout?.exercises?.length) return null
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  const entries = new Set(), sets = new Set()
  const exercises = workout.exercises.map((ex, i) => {
    const rows = workout.rows?.[i] || []
    const count = Math.min(100, rows.length || (Array.isArray(ex.sets) ? ex.sets.length : Number(ex.sets)) || ex.setIds?.length || 0)
    if (!id(ex.entryInstanceId) || entries.has(ex.entryInstanceId) || !Number.isInteger(count) || count < 1) return null
    entries.add(ex.entryInstanceId)
    const workSets = Array.from({ length: count }, (_, j) => {
      const row = rows[j] || (Array.isArray(ex.sets) ? ex.sets[j] : null) || {}
      const setId = row.setId || ex.setIds?.[j]
      if (!id(setId) || sets.has(setId)) return null
      sets.add(setId)
      return { setId, weight: row.w ?? row.weight ?? ex.weight ?? '', reps: String(row.r ?? row.reps ?? ex.reps ?? ''),
        ...(row.done ? { done: true, at: row.at || 0 } : {}),
        ...(row.rpe != null ? { rpe: row.rpe } : {}), ...(row.rir != null ? { rir: row.rir } : {}),
        ...(row.effortVersion != null ? { effortVersion: row.effortVersion } : {}) }
    })
    const muscles = ex.muscles && typeof ex.muscles === 'object'
      ? Object.fromEntries(Object.entries(ex.muscles).filter(([key, weight]) => /^[a-z][a-z0-9_-]{0,31}$/.test(key) && Number.isFinite(Number(weight)) && Number(weight) > 0))
      : null
    return workSets.includes(null) ? null : { exerciseId: ex.id || ex.exerciseId || '', entryInstanceId: ex.entryInstanceId,
      name: ex.name || '', restSec: Number(ex.restSec) || 60, ...(muscles && Object.keys(muscles).length ? { muscles } : {}), sets: workSets }
  })
  if (exercises.includes(null)) return null
  const birthYear = Number.isInteger(workout.profile?.birthYear) ? workout.profile.birthYear : null
  return { t: 'START_SESSION', protocolVersion: 4, requestId, sid, workout: workout.name || '', weightUnit: workout.weightUnit || 'kg',
    ...(birthYear !== null ? { profile: { birthYear } } : {}),
    structureRevision: workout.structureRevision || 0,
    ...(workout.sessionGeneration ? { sessionGeneration: workout.sessionGeneration } : {}),
    ...(workout.effortScale ? { effortScale: workout.effortScale } : {}), exercises }
}

export function watchSnapshotOf(S, timer, now = Date.now()) {
  const A = S.active, plan = watchPlanOf(S)
  if (!plan) return null
  const ex = Number.isInteger(A.watchFocus?.ex) ? A.watchFocus.ex : (A.cur || 0)
  const rows = A.entries.map(e => e.sets.filter(r => !isWarmupRow(r)).map(r => ({
    setId: r.setId, w: r.w ?? '', r: r.sec ?? r.reps ?? r.r ?? '', done: !!r.done, at: r.at || 0,
    // 评分与它的独立版本一起进快照：缺字段 ≠ 清除，清除由版本号表达。
    ...(r.rpe != null ? { rpe: r.rpe } : {}), ...(r.rir != null ? { rir: r.rir } : {}),
    ...(r.effortVersion != null ? { effortVersion: r.effortVersion } : {}),
  })))
  const first = (rows[ex] || []).findIndex(r => !r.done)
  return { ...plan, workout: A.name, exercises: plan.workout.exercises, rows,
    rev: now, startedAt: now - elapsedMsOf(A, now) - (A.pausedMs || 0) - (A.pausedAt ? now - A.pausedAt : 0),
    segmentStartedAt: A.segmentStartedAt || A.start,
    exIdx: ex, setIdx: A.watchFocus?.ex === ex ? A.watchFocus.set - 1 : first < 0 ? 0 : first,
    focusAt: Number(A.watchFocus?.at || A.watchFocusAt || 0),
    commitRev: A.syncRev || 0, sessionEpoch: watchSidOf(A),
    ...(A.watchSessionGeneration ? { sessionGeneration: A.watchSessionGeneration } : {}),
    ackedEvents: A.watchEvents || [], pausedAt: A.pausedAt || 0, pausedMs: A.pausedMs || 0,
    pauseVersion: A.pauseVersion || 0, baseCalories: Object.entries(A.watchSegments || {}).filter(([id]) => id !== watchSidOf(A)).reduce((n, [, s]) => n + s.calories, 0),
    rest: timer ? { restId: timer.restId || String(timer.startedAt || timer.endsAt - timer.total * 1000),
      startedAt: timer.startedAt || timer.endsAt - timer.total * 1000, endsAt: timer.ready || timer.paused ? 0 : timer.endsAt,
      leftSec: timer.paused ? timer.left : timer.ready ? 0 : Math.max(0, Math.ceil((timer.endsAt - now) / 1000)),
      totalSec: timer.total, paused: !!timer.paused, seq: timer.seq || timer.startedAt || now } : { leftSec: 0, totalSec: 0, seq: A.restVersion || 0 },
    restUntil: timer && !timer.ready ? timer.endsAt : 0 }
}

export function watchProfileOf(S) {
  const bw = S.bodyweight?.at(-1)?.w
  const known = typeof bw === 'number' && Number.isFinite(bw) && bw > 0
  const bodyWeightKg = known ? Math.round((S.unit === 'lb' ? bw * 0.45359237 : bw) * 10) / 10 : 70
  const year = new Date().getFullYear(), age = year - S.birthYear
  return { weight: bodyWeightKg, bodyWeightKg, bodyWeightSource: known ? 'recorded' : 'default', weightUnit: S.unit || 'kg',
    ...(Number.isInteger(S.birthYear) && age >= 10 && age <= 100 ? { birthYear: S.birthYear } : {}) }
}
