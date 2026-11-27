import { applyWatchEffort, applyWatchEvent, rememberClose } from './watch-events.js'
import { resolveWatchTarget } from './watch-identity.js'
import { watchFieldKey } from './watch-revision.js'
import { watchSidOf } from './session-resume.js'
import { isWarmupRow } from './workout-model.js'

const liveTypes = new Set(['set', 'unset', 'SET_COMPLETED', 'SET_UNDONE', 'session_close',
  'focus', 'weight', 'reps', 'effort', 'add_set', 'remove_set', 'pause', 'rest'])
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const revision = value => Number.isSafeInteger(value) && value >= 0
const disposition = value => value === 'saved' || value === 'discarded' || value === 'abandoned'
const sameSession = (active, sid) => !!active && !active.editingWorkoutId && active.watchStarted !== true && watchSidOf(active) === sid

export const isWatchV4LifecycleEvent = ev => ev?.protocolVersion === 4 &&
  (ev.t === 'STATE_SNAPSHOT' || liveTypes.has(ev.t))

export function watchTerminalOf(S, sid) {
  if (!validId(sid)) return null
  const closed = Object.hasOwn(S.watchClosed || {}, sid) ? S.watchClosed[sid] : null
  if (closed && disposition(closed.disposition)) return { sid, disposition: closed.disposition, closedAt: closed.closedAt }
  const w = S.workouts?.find(w => w.watchSid === sid || String(w.start) === sid || w.watchSids?.includes(sid) || Object.hasOwn(w.watchSegments || {}, sid))
  return w ? { sid, disposition: 'saved', closedAt: w.finishedAt || w.end || w.start } : null
}

function targetOf(active, ev) {
  const setId = ev.setId || ev.groupId
  if (!validId(setId)) return null
  const entry = active.entries.find(e => (ev.entryInstanceId ? e.entryInstanceId === ev.entryInstanceId : e.sets.some(r => r.setId === setId)))
  if (!entry) return null
  const target = resolveWatchTarget(active, { ...ev, entryInstanceId: entry.entryInstanceId, setId })
  return target?.row ? target : null
}

function applyWatchV4Structure(S, ev, revisions, fresh) {
  if (!validId(ev.entryInstanceId)) return false
  const active = S.active
  const target = resolveWatchTarget(active, ev)
  if (!target) return false
  const { entry, rows, ex } = target
  const adding = ev.t === 'add_set'
  const idField = adding ? 'newSetIds' : 'removedSetIds'
  if (!Array.isArray(ev[idField])) return false

  const keyOf = setId => watchFieldKey(entry, { setId }, 'structure')
  const ids = ev[idField].filter(id => {
    if (!validId(id) || !fresh(keyOf(id))) return false
    const owner = active.entries.find(e => e.sets.some(row => row.setId === id))
    if (adding) return !owner && id.startsWith('watch-set:') && !active.watchRemovedSets?.includes(id)
    return owner ? owner === entry && rows.some(row => row.setId === id) : id.startsWith('watch-set:')
  })
  if (!ids.length) return false

  // Watch adds append, so their revisions give the order even when frames
  // arrive in reverse. Existing rows through the snapshot watermark stay put.
  const beforeSetId = adding ? rows.find(row => revisions[keyOf(row.setId)] > ev.rev)?.setId : undefined
  const focus = active.watchFocus
  const focused = focus?.ex === ex ? rows[focus.set - 1] : null
  if (!applyWatchEvent(S, { ...ev, [idField]: ids }, { beforeSetId })) return false
  for (const id of ids) revisions[keyOf(id)] = ev.rev
  if (focused) {
    const set = entry.sets.filter(row => !isWarmupRow(row)).indexOf(focused) + 1
    if (set) focus.set = set
  }
  return true
}

function restState(S, value, sid, now) {
  const active = S.active
  const seq = Math.max(active.restVersion || 0, S.watchRest?.seq || 0) + 1
  const endsAt = revision(value.endsAt) ? value.endsAt : 0
  const leftSec = value.paused === true ? Number(value.leftSec) || 0
    : endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : Number(value.leftSec) || 0
  active.restVersion = seq
  if (leftSec <= 0) { S.watchRest = null; return { sid, seq, leftSec: 0 } }
  const totalSec = Math.max(leftSec, Number(value.totalSec) || 0)
  const rest = { sid, seq, endsAt, totalSec, leftSec, paused: value.paused === true,
    startedAt: value.startedAt || (endsAt ? endsAt - totalSec * 1000 : now),
    restId: value.restId || `watch-v4:${sid}:${endsAt || seq}` }
  S.watchRest = rest
  return rest
}

function applyTerminal({ getState, update, finish }, sid, value) {
  if (watchTerminalOf(getState(), sid) || !sameSession(getState().active, sid) ||
      !disposition(value.disposition) || !revision(value.closedAt) || !value.closedAt) return false
  // This marker expresses the user's choice. The workout itself is built by the
  // normal phone finish action from the phone's rows, which the watch never uploads.
  update(S => {
    rememberClose(S, { sid, disposition: value.disposition, closedAt: value.closedAt,
      phoneLedSession: true, sessionGeneration: S.active.watchSessionGeneration })
    S.watchRest = null
  })
  if (value.disposition === 'saved') finish(value.closedAt)
  else update(S => { S.active = null })
  return true
}

function reconcileSnapshot(deps, ev, now) {
  const { getState, update } = deps
  const active = getState().active
  if (!sameSession(active, ev.sid) || !revision(ev.rev)) return {}
  if (ev.active === false) {
    // A terminal snapshot carries the revision of the now-blank watch state. Its
    // SID and disposition are independent of that reset revision.
    return { stop: ev.terminal?.sid === ev.sid && applyTerminal(deps, ev.sid, ev.terminal) }
  }
  if (ev.active !== true || ev.rev < (active.watchV4Rev ?? -1) ||
      ev.rev <= (active.watchV4SnapshotRev ?? -1) || watchTerminalOf(getState(), ev.sid)) return {}
  let rest
  update(S => {
    const A = S.active
    A.watchV4Rev = ev.rev
    A.watchV4SnapshotRev = ev.rev
    A.watchV4FieldRevs = {}
    // The arrays contain just the focused row. exIdx/setIdx are zero-based
    // absolute positions in the watch's plan, and cannot index those arrays.
    const ex = A.entries?.[ev.exIdx], row = ex?.sets.filter(r => !isWarmupRow(r))[ev.setIdx]
    const watchEntry = ev.exercises?.[0], watchRow = ev.rows?.[0]?.[0]
    const byIdentity = watchRow?.setId && targetOf(A, {
      ex: ev.exIdx, entryInstanceId: watchEntry?.entryInstanceId, setId: watchRow.setId,
    })
    const target = byIdentity || (!watchRow?.setId && row && (!watchEntry?.entryInstanceId || ex.entryInstanceId === watchEntry.entryInstanceId)
      ? { ex: ev.exIdx, set: ev.setIdx + 1 } : null)
    if (target) {
      A.cur = target.ex
      A.watchFocus = { ex: target.ex, set: target.set, at: Math.max(A.watchFocus?.at || 0, A.watchFocusAt || 0) + 1 }
    }
    if (revision(ev.pausedAt)) A.pausedAt = ev.pausedAt
    if (revision(ev.pausedMs)) A.pausedMs = ev.pausedMs
    if (revision(ev.restUntil)) rest = restState(S, { endsAt: ev.restUntil, totalSec: ev.restTargetSec,
      ...(ev.pausedAt && revision(ev.restLeftSec) ? { paused: true, leftSec: ev.restLeftSec } : {}) }, ev.sid, now)
  })
  return { rest }
}

export function applyWatchV4Lifecycle(deps, ev, now = Date.now()) {
  const { getState, update } = deps
  if (ev.t === 'STATE_SNAPSHOT') return reconcileSnapshot(deps, ev, now)
  const A = getState().active
  if (ev.phoneLed !== true || deps.isForeground?.() === false || !sameSession(A, ev.sid) ||
      watchTerminalOf(getState(), ev.sid) || !revision(ev.rev) || !validId(ev.eventId) ||
      ev.rev <= (A.watchV4SnapshotRev ?? -1) ||
      (ev.phoneSessionGeneration != null && ev.phoneSessionGeneration !== (A.watchSessionGeneration || ev.sid))) return {}
  const type = ev.t === 'SET_COMPLETED' ? 'set' : ev.t === 'SET_UNDONE' ? 'unset' : ev.t
  if (type === 'session_close') return { stop: ev.rev >= (A.watchV4Rev ?? -1) && applyTerminal(deps, ev.sid, ev) }
  if ((A.watchEvents || []).includes(ev.eventId)) return {}
  let rest
  update(S => {
    const a = S.active
    // Keep the prior session-wide floor when reopening state saved by an older app.
    const revisions = a.watchV4FieldRevs ?? { legacy: a.watchV4Rev ?? -1 }
    const fresh = field => ev.rev >= (revisions.legacy ?? -1) && ev.rev > (revisions[field] ?? -1)
    let field = type
    if (type === 'add_set' || type === 'remove_set') {
      if (!applyWatchV4Structure(S, ev, revisions, fresh)) return
      field = null
    } else if (type === 'pause') {
      if (!fresh(field)) return
      const at = revision(ev.at) && ev.at ? ev.at : now
      if (typeof ev.paused !== 'boolean') return
      a.pauseVersion = (a.pauseVersion || 0) + 1
      if (ev.paused && !a.pausedAt) a.pausedAt = at
      else if (ev.paused === false && a.pausedAt) {
        a.pausedMs = (a.pausedMs || 0) + Math.max(0, at - a.pausedAt)
        a.pausedAt = 0
      }
      a.watchEvents = [...(a.watchEvents || []), ev.eventId].slice(-4000)
    } else if (type === 'rest') {
      if (!fresh(field)) return
      rest = restState(S, ev, ev.sid, now)
      a.watchEvents = [...(a.watchEvents || []), ev.eventId].slice(-4000)
    } else {
      const target = targetOf(a, ev)
      if (!target) return
      const key = name => watchFieldKey(target.entry, target.row, name)
      if (type === 'set' || type === 'unset') field = key('done')
      else if (type !== 'focus') field = key(type)
      if (!fresh(field)) return
      const routed = { ...ev, t: type, ex: target.ex, set: target.set, entryInstanceId: target.entry.entryInstanceId,
        ...(target.row ? { setId: target.row.setId } : {}) }
      if (type === 'effort') {
        if (applyWatchEffort(S, routed).status !== 'applied') return
      } else if ((type === 'set' || type === 'unset') && !!target.row.done === (type === 'set')) {
        // The same stable group may be reported under a second event ID. A
        // duplicate must neither overwrite its measurements nor start rest again.
        a.watchEvents = [...(a.watchEvents || []), ev.eventId].slice(-4000)
      } else {
        // Undo changes completion only; inputs supplied by an old watch view
        // cannot overwrite the phone's measurements while undoing a group.
        // Older senders may also bundle measurements with a completion edge.
        // Each measurement has its own clock, independent of the edge.
        if (type !== 'focus') {
          if (type === 'unset' || !fresh(key('weight'))) delete routed.weight
          if (type === 'unset' || !fresh(key('reps'))) delete routed.reps
        }
        if (!applyWatchEvent(S, routed)) return
        if (target.row && ['weight', 'reps', 'set'].includes(type)) {
          if (routed.weight != null) revisions[key('weight')] = ev.rev
          if (routed.reps != null) revisions[key('reps')] = ev.rev
        }
        if (type === 'set' && ev.rest && fresh('rest')) {
          rest = restState(S, ev.rest, ev.sid, now)
          revisions.rest = ev.rev
        }
      }
    }
    if (field) revisions[field] = ev.rev
    a.watchV4FieldRevs = revisions
    a.watchV4Rev = Math.max(a.watchV4Rev ?? -1, ev.rev)
  })
  return { rest }
}
