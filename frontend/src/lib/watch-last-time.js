// 手表「上次」（Last time）载荷：把手机端已有的历史查询压成手表可读的可选字段。
//
// 这里不引入第二套排序、匹配或单位规则：来源就是 history.js 的 lastEntryFor（同计划优先、
// 再回退该动作的全局历史），时间截断是 backfill.js 的 sessionHistory（补录/编辑时排除自身
// 与未来记录），哑铃 each/total 的语义对齐是 dumbbells.js 的 historyAs，文本格式是
// history.js 的 setLabel（自重、计时、左右、特殊组、评分都按既有格式）。任一环节没有结果
// 就返回 null，让手表隐藏入口 —— 缺历史只是一行不显示，不能让整个计划构建失败。
import { lastEntryFor, setLabel } from './history.js'
import { sessionHistory } from './backfill.js'
import { dbLoadFor, historyAs } from './dumbbells.js'
import { speedUnitOf } from './speed.js'

/**
 * 「此前一次可计入训练的该动作实际完成结果」，或 null。
 *
 * `entry` 是本次会话的动作条目（计划来源的自由动作可能没有 rid）；`routineId` 是调用方
 * 已经解析好的计划来源（目录按 routine.id，活动训练按 entryRoutineId 的结果）。条目自带的
 * rid 优先：合并日里同一个动作在不同计划下是两条历史，不该互相借用。
 *
 * 返回的只是载荷，不写 S / entry / 历史，也不给本次处方、评分草稿赋值。
 */
export function watchLastTimeOf(S, entry, routineId = null) {
  try {
    const id = entry?.id
    if (!id) return null
    // 补录或编辑一场训练时，历史必须按它的时间位置截断：否则「上次」可能是正在编辑的这场，
    // 或者比它更晚的记录。`meaning` 只决定哑铃重量读成 each 还是 total，不做 kg/lb 换算
    // （全局单位已由 units.js 转换过 S.workouts 与当前重量）。
    const meaning = dbLoadFor(S, { ...(entry.target || {}), id })
    const history = historyAs(sessionHistory(S), id, meaning)
    const last = lastEntryFor(history, id, entry.rid || routineId || null)
    // lastEntryFor 返回的工作组已经排除热身、未完成与被排除的训练，不再拿原始历史补回去。
    if (!last || !Array.isArray(last.sets) || !last.sets.length) return null
    const speedUnit = speedUnitOf(S)
    const rows = []
    for (const row of last.sets) {
      let label = ''
      try {
        label = setLabel(id, row, last.target, speedUnit)
      } catch (e) {
        // 单行格式化失败只跳过这一行，其余有效行继续显示。
        label = ''
      }
      if (typeof label === 'string' && label.trim()) rows.push({ label: label.trim() })
    }
    if (!rows.length) return null
    return {
      // 缺日期就是 null：不用今天补齐，也不伪造一个日期。
      date: typeof last.d === 'string' && last.d ? last.d : null,
      weightUnit: S?.unit || 'kg',
      // 实际命中的来源计划（同计划命中是该项自己的 rid，全局回退时为 null），不是本次的处方。
      sourceRoutineId: last.rid || null,
      rows,
      text: rows.map(r => r.label).join('，'),
    }
  } catch (e) {
    // 兼容性兜底：历史损坏只让 lastTime 为空，不把整个计划构建带崩。
    return null
  }
}
