import { isWarmupRow } from './workout-model.js'

/** 会话存在于全局 store，切换到设置页不应撤销它的手表计划。 */
export function watchPlanOf(S) {
  const A = S.active
  if (!A?.start || A.editingWorkoutId) return null
  const bw = S.bodyweight?.length ? S.bodyweight[S.bodyweight.length - 1].w : null
  const weightKg = bw ? (S.unit === 'lb' ? bw * 0.45359237 : bw) : 70
  return {
    sid: String(A.start),
    profile: { weight: Math.round(weightKg * 10) / 10 },
    workout: { name: A.name, exercises: A.entries.map(e => {
      const rows = e.sets.filter(x => !isWarmupRow(x))
      return { name: e.name, sets: rows.length, reps: rows[0]?.r ?? rows[0]?.reps ?? '',
        restSec: e.target?.restSec > 0 ? e.target.restSec : S.restSec || 60, weight: rows[0]?.w ?? '' }
    }) },
  }
}
