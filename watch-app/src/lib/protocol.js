export function applyEdit(state, ev) {
  const workout = state.workout
  const rows = workout && workout.rows[ev.ex]
  if (!rows) return
  if (ev.t === 'add_set') {
    const target = Math.min(100, Number(ev.sets || ev.set))
    while (rows.length < target) rows.push({ w: ev.weight || '', r: ev.reps || '', done: false, at: 0 })
  } else if (ev.t === 'remove_set') {
    const target = Math.max(1, Number(ev.sets != null ? ev.sets : ev.set - 1))
    if (!rows.slice(target).some(r => r.done)) rows.splice(target)
  } else {
    const row = rows[ev.set - 1]
    if (!row) return
    if (ev.t === 'weight') row.w = ev.weight
    if (ev.t === 'reps') row.r = ev.reps
    if (ev.t === 'set' || ev.t === 'unset') {
      row.done = ev.t === 'set'; row.at = row.done ? ev.at : 0
      if (ev.weight != null) row.w = ev.weight
      if (ev.reps != null) row.r = ev.reps
    }
  }
  workout.exercises[ev.ex].sets = rows.length
}

export function applyFocus(state, ev) {
  if (!ev || ev.sid !== state.sid || ev.source === 'watch' || !(ev.at > (state.focusAt || 0))) return false
  const ex = Math.max(0, Math.min(Number(ev.ex) || 0, state.workout.exercises.length - 1))
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
