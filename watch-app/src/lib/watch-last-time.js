// 手表端「上次」只读视图：把手机构建好的可选载荷归一化成能直接渲染的行。
//
// 手表不查历史、不算处方、不做单位换算：手机发什么就显示什么，字段坏了只隐藏这块，
// 不阻断训练。载荷格式见 frontend/src/lib/watch-last-time.js。
export function lastTimeView(exercise, weightUnit) {
  const lt = exercise && exercise.lastTime
  if (!lt || typeof lt !== 'object') return null
  const raw = Array.isArray(lt.rows) ? lt.rows : []
  const rows = []
  for (const r of raw) {
    // 只认 label 为非空字符串的行；摘要也从 rows 重建，不盲信手机拼好的 text。
    const label = r && typeof r.label === 'string' ? r.label.trim() : ''
    if (label) rows.push({ label })
  }
  if (!rows.length) return null
  const date = typeof lt.date === 'string' && lt.date.trim() ? lt.date.trim() : null
  // 单位只接受 kg/lb，其他一律用当前会话已经校验过的单位。
  const unit = lt.weightUnit === 'kg' || lt.weightUnit === 'lb'
    ? lt.weightUnit : (weightUnit === 'lb' ? 'lb' : 'kg')
  return {
    name: typeof exercise.name === 'string' ? exercise.name : '',
    date,
    // 缺日期只说“日期未知”，不把 null 显示成空行，也不用今天补。
    dateLabel: date || '日期未知',
    weightUnit: unit,
    metaLabel: (date || '日期未知') + ' · ' + unit,
    rows: rows.map((r, i) => ({ label: r.label, no: '第 ' + (i + 1) + ' 组' })),
    text: rows.map(r => r.label).join('，'),
  }
}

/** 主数值下方那一行摘要：`上次 60×10，60×8 ›`。没历史返回空串，调用方整行隐藏。 */
export function lastTimeSummaryLine(view) {
  if (!view || !view.text) return ''
  return '上次 ' + view.text
}
