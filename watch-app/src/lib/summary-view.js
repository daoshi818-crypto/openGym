// 总结页的纯显示格式化：都在这里算，.ux 只负责摆放，因此可以单测。
//
// 两条硬规则：缺字段就明说“未记录”或整块隐藏，不用 0 冒充真实采样；同步文案只反映
// 已经发生的业务确认（同 sid 的 close-journal delivered），不从“队列空 + 已连接”推断上传成功。

const isNum = v => typeof v === 'number' && Number.isFinite(v)
const grouped = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** 时长：52.13→“52分钟”，65→“1小时05分钟”，59.6→“1小时00分钟”，0→“少于1分钟”。 */
export function summaryDurationLabel(minutes) {
  if (!isNum(minutes) || minutes < 0) return '未记录'
  // 不足一分钟不写“0分钟”，也不写伪造的秒数。
  if (minutes < 1) return '少于1分钟'
  const m = Math.round(minutes)
  if (m < 60) return m + '分钟'
  return Math.floor(m / 60) + '小时' + String(m % 60).padStart(2, '0') + '分钟'
}

/** 总结里的时长先取 totalMinutes（排除暂停的整场分钟），没有才退回本段 minutes。 */
export function summaryMinutesOf(summary) {
  if (!summary || typeof summary !== 'object') return null
  if (isNum(summary.totalMinutes) && summary.totalMinutes >= 0) return summary.totalMinutes
  if (isNum(summary.minutes) && summary.minutes >= 0) return summary.minutes
  return null
}

/** 计划名：非空字符串才用，否则“自由训练”（不能把空名字显示成空白标题）。 */
export function summaryNameLabel(summary) {
  const name = summary && typeof summary.workout === 'string' ? summary.workout.trim() : ''
  return name || '自由训练'
}

/**
 * 组数：用已保存的数值，合法的 0 显示 0；字段缺失才“未记录”。
 * 旧版本的 summary 可能把 sets 存成数组，那时明确取 length，不能 String 出 [object Object]。
 */
export function summarySetsLabel(summary) {
  const v = summary ? summary.sets : null
  if (Array.isArray(v)) return String(v.length)
  if (isNum(v) && v >= 0) return String(Math.round(v))
  return '未记录'
}

/** 训练容量：{ text, unit } 或 null（缺失就整块隐藏，合法的 0 照常显示）。 */
export function summaryVolumeOf(summary) {
  const v = summary ? summary.volume : null
  if (!isNum(v) || v < 0) return null
  return { text: grouped(v), unit: typeof summary.weightUnit === 'string' && summary.weightUnit ? summary.weightUnit : 'kg' }
}

/**
 * 心率：只认有限正数。0 表示“没有采样”，不能画成真实心率；两项都没有就整块隐藏。
 * 返回 { text } 或 null。
 */
export function summaryHeartOf(summary) {
  const ok = v => isNum(v) && v > 0
  if (!summary) return null
  const parts = []
  if (ok(summary.avgHr)) parts.push(Math.round(summary.avgHr) + ' 平均')
  if (ok(summary.maxHr)) parts.push(Math.round(summary.maxHr) + ' 最高')
  return parts.length ? { text: parts.join(' · ') } : null
}

/** 热量：totalCalories 优先，退回本段 calories；0 是合法值。标签始终叫“估算热量”。 */
export function summaryCaloriesOf(summary) {
  if (!summary) return null
  const v = isNum(summary.totalCalories) && summary.totalCalories >= 0 ? summary.totalCalories
    : isNum(summary.calories) && summary.calories >= 0 ? summary.calories : null
  return v == null ? null : grouped(v)
}

/**
 * 同步文案：只从真实业务状态推导，优先级自高而低。
 *
 * `delivered` 必须是本总结 sid 的关闭日志状态（Summary 页读 journalEntry(sid).delivery），
 * `pending` 是全局 outbox 数量（不能宣称都是这一场训练的），`connected` 只说明连接在。
 */
export function summarySyncLabel({ delivered, pending, connected } = {}) {
  if (delivered) return '已同步到手机'
  if (!connected) return '已本地保存 · 离线待同步'
  if (pending > 0) return '已本地保存 · 有待传事件'
  // 连接着、队列也空，但没有收到本场汇总的业务确认：只能说“待手机确认”。
  return '已本地保存 · 待手机确认'
}
