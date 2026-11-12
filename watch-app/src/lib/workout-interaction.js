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
      key: JSON.stringify([state.sid, identity.entryInstanceId || state.exIdx, r.setId || page * size + i]),
      setIdx: page * size + i, setId: r.setId, number: page * size + i + 1,
      done: !!r.done, current: page * size + i === state.setIdx })) }
}

// Only coalesce cursor input BEFORE it becomes a durable event. Accepted intentions
// still use the existing exact receipt/retry path, including while another tap waits.
export function createSetDotPicker(apply, delay = 120) {
  let target = null, timer = null, running = false, batch = null, resolveBatch = null, generation = 0, dueAt = 0
  function settle(result) {
    const resolve = resolveBatch
    batch = null; resolveBatch = null
    if (resolve) resolve(result)
  }
  function arm() {
    if (timer != null) clearTimeout(timer)
    // BlueOS registers only ordinary Function callbacks; AsyncFunction has no
    // native callback ID. Keep the bridge callback synchronous and await inside.
    timer = setTimeout(() => { flush() }, Math.max(0, dueAt - Date.now()))
  }
  async function flush() {
    timer = null
    if (running || !target) return
    const next = target, epoch = generation
    target = null; running = true
    let result = false
    try { result = await apply(next) }
    catch (_) { /* The page reports storage errors; no accepted event is removed. */ }
    finally {
      running = false
      if (target) arm()
      else if (epoch === generation) settle(result)
    }
  }
  return {
    request(input) {
      // Never retain the reactive repeat item or a native event across an async write.
      target = { sid: input.sid, entryInstanceId: input.entryInstanceId, setId: input.setId,
        exIdx: input.exIdx, setIdx: input.setIdx, baseCommitRev: input.baseCommitRev }
      dueAt = Date.now() + delay
      if (!batch) batch = new Promise(resolve => { resolveBatch = resolve })
      if (!running) arm()
      return batch
    },
    pending() { return running || !!target },
    cancel() {
      generation++; target = null
      if (timer != null) clearTimeout(timer)
      timer = null; settle(false)
    },
  }
}
