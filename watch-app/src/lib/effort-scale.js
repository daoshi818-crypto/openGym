// 每组强度（RPE / RIR）的共享定义：范围、步长、换算与中文含义。
//
// 手机（frontend，经 history.js/effort.js）与手表（Workout 评分层）都从这里取，
// 避免两边各写一份范围与文案后慢慢漂移。纯数据 + 纯函数，不依赖任何平台 API。
//
// 约定：
//  - RPE 6–10，RIR 0–10，步长都是 0.5。
//  - 0 RIR 是“力竭”的有效值，不是“没填”。没填用 null 表示。
//  - 读取旧值时不改写：7.3 这样的历史值原样返回，只有用户主动滑动才移动一个步长。

export const EFFORT_SCALES = {
  rpe: { key: 'rpe', field: 'rpe', label: 'RPE', step: 0.5, min: 6, max: 10 },
  rir: { key: 'rir', field: 'rir', label: 'RIR', step: 0.5, min: 0, max: 10 },
}

export const EFFORT_KEYS = ['rpe', 'rir']

/** 'none'/未知 → null；'rpe'/'rir' → 量表定义。 */
export const effortScaleOf = value => (typeof value === 'string' && Object.prototype.hasOwnProperty.call(EFFORT_SCALES, value) ? EFFORT_SCALES[value] : null)

/** 该量表写入组数据的字段名；'none' → null（不写任何字段）。 */
export const effortFieldOf = scale => effortScaleOf(scale)?.field || null

/** 一组数据里实际登记的量表：只可能是 rpe 或 rir 之一。 */
export function effortKindOf(set) {
  if (!set) return null
  if (isEffortNumber(set.rpe)) return 'rpe'
  if (isEffortNumber(set.rir)) return 'rir'
  return null
}

/** 数值合法性（不要求是 0.5 的整数倍，旧数据要如实保留）。 */
export const isEffortNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10

/** 读取一组已登记的有效值；没登记返回 null。0 是有效值。 */
export function effortValueOf(set, scale = null) {
  if (!set) return null
  const kind = scale && effortScaleOf(scale) ? scale : effortKindOf(set)
  if (!kind) return null
  const v = set[kind]
  return isEffortNumber(v) ? v : null
}

/**
 * 覆盖层的一次步进：空 → 该量表最低档（无论方向，避免“右滑变成清除”）；
 * 否则按 0.5 移动并在边界处停住，不循环、不清除（清除是单独动作）。
 */
export function stepEffortValue(scale, current, dir) {
  const def = effortScaleOf(scale)
  if (!def) return null
  if (!isEffortNumber(current)) return def.min
  if (!dir) return current
  const next = Math.round((current + (dir > 0 ? def.step : -def.step)) * 10) / 10
  return Math.max(def.min, Math.min(def.max, next))
}

/** 输入/粘贴时的上限约束：只压上限，不抬下限（避免打字“10”时第一下被抬成 6）。
 *  这里用宽松的有限数判断：要压的正是“超过量表上限”的那种输入。 */
export function capEffortValue(scale, value) {
  const def = effortScaleOf(scale)
  if (!def || typeof value !== 'number' || !Number.isFinite(value) || value < 0) return value
  return Math.min(def.max, value)
}

/** 把一组数据换到给定量表显示（用于“另一量表的旧值”提示，不做保存）。 */
export function toScale(kind, rir) {
  if (!isEffortNumber(rir) || !effortScaleOf(kind)) return null
  return Math.round((kind === 'rpe' ? 10 - rir : rir) * 10) / 10
}

/** 内部统一用 RIR 表达“还剩几次”。 */
export const rirOfEffort = (scale, value) => {
  const def = effortScaleOf(scale)
  if (!def || !isEffortNumber(value)) return null
  return scale === 'rpe' ? Math.round((10 - value) * 10) / 10 : value
}

const half = n => Math.abs(n - Math.round(n)) > 0.01

/**
 * 中文含义（与方案中的对照表一致）。返回 { rir, repsLeft, text }。
 * 半次值表达为“介于 N 次与 N+1 次之间”，不把 4+ 说成精确数字。
 */
export function effortMeaning(scale, value) {
  const def = effortScaleOf(scale)
  const rir = rirOfEffort(scale, value)
  if (!def || rir == null) return { rir: null, repsLeft: null, text: '' }
  if (rir <= 0) return { rir, repsLeft: 0, text: '无法再完成一次标准动作' }
  if (rir <= 0.5) return { rir, repsLeft: null, text: '可能已做不完下一次' }
  if (half(rir)) {
    const lo = Math.floor(rir)
    return { rir, repsLeft: null, text: '介于还能做' + lo + '次与' + (lo + 1) + '次之间' }
  }
  const n = Math.round(rir)
  return { rir, repsLeft: n, text: n >= 4 ? '还能再做约' + n + '次，较轻松' : '还能再做约' + n + '次' }
}

/** 入口行的一行摘要：'RPE 8 · 还能再做约2次'；没登记 → '未登记'。 */
export function effortSummaryText(scale, value) {
  const def = effortScaleOf(scale)
  const v = isEffortNumber(value) ? value : null
  if (!def || v == null) return '未登记'
  const meaning = effortMeaning(scale, v)
  return def.label + ' ' + formatEffort(v) + (meaning.text ? ' · ' + meaning.text : '')
}

/** 0.5 步长显示成 8 / 8.5，不显示 8.0。 */
export function formatEffort(value) {
  if (!isEffortNumber(value)) return '—'
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

/** 能力声明：手机告诉手表“能收评分”。不靠版本号字符串推断。 */
export const EFFORT_CAPABILITY = 1
