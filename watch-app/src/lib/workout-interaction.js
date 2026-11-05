// An explicit stable identity must never silently fall back to a neighbouring index.
export function rowTarget(state, target) {
  if (!state?.active || !state.workout || !target || (target.sid && target.sid !== state.sid)) return null
  const ex = target.entryInstanceId ? state.workout.exercises.findIndex(e => e.entryInstanceId === target.entryInstanceId) : Number(target.exIdx)
  if (!Number.isInteger(ex) || ex < 0 || ex >= state.workout.exercises.length) return null
  const rows = state.workout.rows[ex] || []
  const set = target.setId ? rows.findIndex(r => r.setId === target.setId) : Number(target.setIdx)
  if (!Number.isInteger(set) || set < 0 || set >= rows.length) return null
  return { exIdx: ex, setIdx: set, row: rows[set] }
}
export function captureRow(state) {
  const ex = state?.workout?.exercises[state.exIdx], row = state?.workout?.rows[state.exIdx]?.[state.setIdx]
  return ex && row ? { sid: state.sid, entryInstanceId: ex.entryInstanceId, setId: row.setId,
    exIdx: state.exIdx, setIdx: state.setIdx, weightUnit: state.weightUnit || 'kg' } : null
}
export function setDotWindow(state, requestedPage) {
  const rows = state?.workout?.rows[state.exIdx] || [], segmented = rows.length > 7, size = segmented ? 5 : 7
  const max = Math.max(0, Math.ceil(rows.length / size) - 1)
  const page = Math.max(0, Math.min(max, Number.isInteger(requestedPage) ? requestedPage : Math.floor(state.setIdx / size)))
  const identity = captureRow(state) || {}
  return { page, segmented, hasPrev: page > 0, hasNext: page < max,
    dots: rows.slice(page * size, (page + 1) * size).map((r, i) => ({ ...identity,
      setIdx: page * size + i, setId: r.setId, number: page * size + i + 1,
      done: !!r.done, current: page * size + i === state.setIdx })) }
}
