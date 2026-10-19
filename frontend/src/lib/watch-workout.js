import { isWarmupRow } from './workout-model.js'
import { exOr } from './exercises.js'
import { exerciseNameFor } from './i18n-core.js'

/** 活动条目只存 id；计划与重连快照必须和手机界面解析出相同名称。 */
export function watchExercisesOf(S, entries) {
  return entries.map(e => {
    const ex = S.customEx?.find(x => x.id === e.id) || exOr(e.id)
    const rows = e.sets.filter(x => !isWarmupRow(x))
    return { name: e.id ? exerciseNameFor(ex) : e.name || '', sets: rows.length,
      reps: rows[0]?.r ?? rows[0]?.reps ?? '',
      restSec: e.target?.restSec > 0 ? e.target.restSec : S.restSec || 60, weight: rows[0]?.w ?? '' }
  })
}

/** 会话存在于全局 store，切换到设置页不应撤销它的手表计划。 */
export function watchPlanOf(S) {
  const A = S.active
  if (!A?.start || A.editingWorkoutId) return null
  const bw = S.bodyweight?.length ? S.bodyweight[S.bodyweight.length - 1].w : null
  const weightKg = bw ? (S.unit === 'lb' ? bw * 0.45359237 : bw) : 70
  return {
    sid: String(A.start),
    profile: { weight: Math.round(weightKg * 10) / 10 },
    workout: { name: A.name, exercises: watchExercisesOf(S, A.entries) },
  }
}
