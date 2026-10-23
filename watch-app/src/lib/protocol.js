export function applyEdit(state, ev) {
  const workout = state.workout
  const exIndex = ev.entryInstanceId ? workout?.exercises.findIndex(e => e.entryInstanceId === ev.entryInstanceId) : ev.ex
  if (!(exIndex >= 0)) return false
  const rows = workout && workout.rows[exIndex]
  if (!rows) return
  if (ev.t === 'add_set' || ev.t === 'remove_set') {
    if (Array.isArray(ev.setIds)) {
      if (!ev.setIds.length || ev.setIds.length > 100 || new Set(ev.setIds).size !== ev.setIds.length) return false
      workout.rows[exIndex] = ev.setIds.map(setId => rows.find(r => r.setId === setId) || { setId, w: ev.weight ?? '', r: ev.reps ?? '', done: false, at: 0 })
    } else if (ev.entryInstanceId) {
      if (ev.t === 'add_set' && Array.isArray(ev.newSetIds)) {
        for (const setId of ev.newSetIds) if (!rows.some(r => r.setId === setId) && rows.length < 100) rows.push({ setId, w: eventWeight(ev.weight ?? '', ev.weightUnit, state.weightUnit), r: ev.reps ?? '', done: false, at: 0 })
      } else if (ev.t === 'remove_set' && Array.isArray(ev.removedSetIds)) {
        const keep = rows.filter(r => !ev.removedSetIds.includes(r.setId) || r.done)
        if (keep.length) workout.rows[exIndex] = keep
      } else return false
    } else {
      const target = Math.max(1, Math.min(100, Number(ev.sets ?? (ev.t === 'add_set' ? ev.set : ev.set - 1))))
      if (ev.t === 'add_set') while (rows.length < target) rows.push({ w: ev.weight || '', r: ev.reps || '', done: false, at: 0 })
      else if (!rows.slice(target).some(r => r.done)) rows.splice(target)
    }
  } else {
    const row = ev.setId ? rows.find(r => r.setId === ev.setId) : rows[ev.set - 1]
    if (!row) return
    if (ev.t === 'weight') row.w = eventWeight(ev.weight, ev.weightUnit, state.weightUnit)
    if (ev.t === 'reps') row.r = ev.reps
    if (ev.t === 'set' || ev.t === 'unset') {
      row.done = ev.t === 'set'; row.at = row.done ? ev.at : 0
      if (ev.weight != null) row.w = eventWeight(ev.weight, ev.weightUnit, state.weightUnit)
      if (ev.reps != null) row.r = ev.reps
    }
  }
  workout.exercises[exIndex].sets = workout.rows[exIndex].length
  if (workout.rows[exIndex].every(r => r.setId)) workout.exercises[exIndex].setIds = workout.rows[exIndex].map(r => r.setId)
  return true
}

export function applyFocus(state, ev) {
  if (!ev || ev.sid !== state.sid || ev.source === 'watch' || !(ev.at > (state.focusAt || 0))) return false
  const ex = ev.entryInstanceId ? state.workout.exercises.findIndex(e => e.entryInstanceId === ev.entryInstanceId) : Math.max(0, Math.min(Number(ev.ex) || 0, state.workout.exercises.length - 1))
  if (ex < 0) return false
  state.exIdx = ex
  state.setIdx = Math.max(0, Math.min(Number(ev.set) - 1 || 0, state.workout.rows[ex].length - 1))
  state.focusAt = ev.at
  return true
}

export function restOf(state, at = Date.now()) {
  return { restId: state.restId || '', startedAt: state.restStartedAt || 0,
    endsAt: state.restUntil || 0, totalSec: state.restTargetSec || 0,
    leftSec: state.pausedAt ? state.restLeftSec || 0 : Math.max(0, Math.ceil(((state.restUntil || 0) - at) / 1000)),
    paused: !!state.pausedAt, seq: state.restVersion || at }
}

export function applyRest(state, ev, at = Date.now()) {
  const version = Number(ev.seq || ev.at) || 0
  if (version && version < (state.restVersion || 0)) return false
  state.restVersion = version
  state.restId = ev.restId || state.restId || ''
  state.restStartedAt = ev.startedAt || state.restStartedAt || at
  state.restTargetSec = Math.max(0, Number(ev.totalSec) || 0)
  state.restLeftSec = Math.max(0, Number(ev.leftSec) || 0)
  state.restUntil = ev.paused || state.pausedAt ? 0 : ev.endsAt || (state.restLeftSec > 0 ? at + state.restLeftSec * 1000 : 0)
  return true
}

function eventWeight(value, from, to) {
  if (!from || !to || from === to || value === '') return value
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * (from === 'lb' ? 0.45359237 : 1 / 0.45359237) * 1000) / 1000 : value
}
