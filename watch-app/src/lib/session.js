import { wireHash, expandWireDelta } from './sync-wire.js'
import { compactStartEvent } from './event-wire.js'
import { dependenciesFor } from './event-dependencies.js'
import { runtime } from './runtime.js'
import { readStored, writeStored, writeStoredAtomic } from './persistence.js'
// 会话状态机 + 持久化。训练动作立即写盘；HR 每个采样进入 App runtime，
// 按阈值及暂停/结束边界合并写盘。应用启动时读回已持久化的状态。
//
// v2 重构（2026-10）：组数据按"每动作每小组"独立存，不再是隐式的 exIdx/setIdx 游标。
//   workout.exercises[i] = { name, sets, reps, restSec, weight }   计划（手机推来的）
//   workout.rows[i]      = [{ w, r, done, at }, …]                 实际数据：每组一行
// 游标（exIdx/setIdx）只表示"现在正在做哪组"，可以自由前后切；done 状态在行上，
// 切回已完成的组看到的是完成态（可撤销重做），切到没做的组直接开始。
//
// 存储结构：
//   session_state    当前会话的紧凑状态（含 rows、休息截止的绝对时间戳、心率累计）
import storage from '@blueos.storage.storage'
import { applyEdit, applyRest } from './protocol.js'
import { prepareClose } from './close-journal.js'
import { allocateEventIdentity } from './event-id.js'

const K_STATE = 'session_state'

const now = () => Date.now()
const hrFields = ['sid', 'startedAt', 'segmentStartedAt', 'hr', 'active', 'pausedAt', 'closeIntent']
function sameHrSession(a, b) {
  return !!a?.sid && a.sid === b?.sid && (a.segmentStartedAt || a.startedAt) === (b.segmentStartedAt || b.startedAt)
}
// Counts, unlike wall-clock timestamps, distinguish samples in the same millisecond.
function newerHr(a, b) { return (b?.count || 0) > (a?.count || 0) ? b : a }
function latestHr(state) {
  const stored = readStored(K_STATE, hrFields), buffered = runtime().sessionHr
  let hr = state.hr || { sum: 0, count: 0, max: 0 }
  if (sameHrSession(state, stored)) hr = newerHr(hr, stored.hr)
  if (sameHrSession(state, buffered)) hr = newerHr(hr, buffered.hr)
  return { ...hr } // Never expose the mutable runtime aggregate to a Page.
}
function reconcileHrCapture(state) {
  const capture = runtime().hrCapture
  if (capture && (!state?.active || state.pausedAt || state.closeIntent || !sameHrSession(state, capture))) capture.stop()
}
function queueExpired(msg) {
  const r = runtime()
  r.expiredQueued ||= new Set()
  if (r.expiredQueued.has(msg.eventId)) return
  r.expiredQueued.add(msg.eventId)
  ;(r.expiredEvents ||= []).push(msg)
}

export function blankState() {
  return {
    active: false,
    startedAt: 0,
    sid: '',            // 会话 id：BLE 回传时手机按 sid+动作+组号 幂等去重
    workout: null,      // { name, exercises, rows } —— rows 与 exercises 对齐
    profile: null,      // { weight, age, sex } 热量估算用，随计划推送过来
    exIdx: 0,           // 当前动作下标（游标，可自由切）
    setIdx: 0,          // 当前动作内的组下标（游标，可自由切）
    focusAt: 0,         // 手机/手表显式焦点的时间戳，防止旧快照回滚游标
    restUntil: 0,       // 绝对时间戳；0 表示不在休息
    hr: { sum: 0, count: 0, max: 0 },
    rev: 0,             // 本地修订号；手机 sync 用它判断谁更新
  }
}

// 同步读（启动路径上不能等异步回调，闪退恢复要立刻拿到状态）。
// 注意：这里不是纯读。超过 6 小时的活动会话会被放弃，但放弃之前必须先把已记录的数据
// 冻成可恢复候选写进关闭日志（独立 key），再清空 session_state；否则重启/重开手表时
// 唯一一份热量就没了。原始状态在日志确认之前不做删除。
export function readSessionHr(sid) {
  const current = readStored(K_STATE, hrFields)
  return current?.sid === sid ? latestHr(current) : null
}

export function loadState() {
  if (runtime().sessionDraft) return runtime().sessionDraft
  try {
    const s = readStored(K_STATE)
    if (s?.expiredClose) queueExpired(s.expiredClose)
    if (s && typeof s === 'object' && s.workout) {
      s.hr = latestHr(s)
      if (s.active && now() - (s.segmentStartedAt || s.startedAt) >= 21600000) {
        expireSession(s)
        return blankState()
      }
      if (s.rev == null) s.rev = 0
      ensureRows(s)
      return s
    }
  } catch (e) { /* 首次运行没有记录 */ }
  return blankState()
}

// 过期放弃：先冻结候选，再清理。候选不自动变成手机历史，等手机明确“已保存”才补传。
function expireSession(s) {
  const at = now()
  const msg = { t: 'session_close', sid: s.sid, disposition: 'abandoned', reason: 'expired', closedAt: at, at,
    eventId: 'expired:' + s.sid, source: 'watch' }
  queueExpired(msg)
  const summary = buildSessionSummary(s, s.profile, at)
  const id = allocateEventIdentity(s.sid)
  const entry = summaryEventOf(summary, id, s, true)
  const done = ok => {
    if (!ok) return                       // 日志没落盘：保留原始会话，下次启动/重试继续
    closeSession(s.sid, { expiredClose: msg })
    storage.set({ key: 'last_notice', value: '训练超过6小时，已保存记录待补传', fail() {} })
  }
  try {
    const p = prepareClose({ sid: s.sid, disposition: 'abandoned', reason: 'expired', closedAt: at,
      eventId: msg.eventId }, entry, 'candidate')
    if (p && typeof p.then === 'function') p.then(done, () => {})
  } catch (e) { /* 原始状态保留 */ }
}

// rows 缺失/长度对不上（老版本升级、计划热替换）时按计划补齐，已有数据原样保留
function ensureRows(s) {
  if (!s.workout) return
  const rows = s.workout.rows || []
  s.workout.rows = (s.workout.exercises || []).map((ex, i) => {
    const r = Array.isArray(rows[i]) ? rows[i] : []
    return Array.from({ length: ex.sets || 1 }, (_, k) => {
      const cell = ex.setIds?.[k] ? r.find(row => row.setId === ex.setIds[k]) : r[k]
      return cell && typeof cell === 'object'
        ? { setId: cell.setId || ex.setIds?.[k], w: cell.w != null ? cell.w : initWeight(ex), r: cell.r != null ? cell.r : initReps(ex), done: !!cell.done, at: cell.at || 0, ...rowEffort(cell) }
        : { setId: ex.setIds?.[k], w: initWeight(ex), r: initReps(ex), done: false, at: 0 }
    })
  })
}

// 计划里带的目标值作为初始值（手机端"计划从上一组带过来"的等价物）
function initWeight(ex) { return ex.weight === '' || ex.weight == null ? '' : ex.weight }
// 强度（RPE/RIR）跟着组走：重建行/同步快照时必须原样保留，缺字段不等于清除。
function rowEffort(cell) {
  const out = {}
  if (cell && Number.isFinite(cell.rpe)) out.rpe = cell.rpe
  if (cell && Number.isFinite(cell.rir)) out.rir = cell.rir
  if (cell && Number.isFinite(cell.effortAt ?? cell.effortVersion)) out.effortAt = cell.effortAt ?? cell.effortVersion
  return out
}
function initReps(ex) { return ex.reps == null ? '' : ex.reps }

// 每次改动立即落盘。storage.set 是异步的，失败回调必须给（文档要求）。
function persist(state) {
  state.hr = latestHr(state)
  if (runtime().sessionDraft === state) return
  reconcileHrCapture(state)
  writeStored(K_STATE, state)
}

export function save(state) {
  state.rev = (state.rev || 0) + 1
  persist(state)
}

// The operation and stable pending intentions enter the SAME candidate document.
// No candidate is published, sent, or rolled back over a newer value before storage confirms it.
export async function commitSessionAction(sid, action) {
  let output
  const result = await writeStoredAtomic(K_STATE, latest => {
    if (runtime().closingSid === sid || latest?.closeIntent || !latest?.active || latest.sid !== sid) throw new Error('session_changed')
    const candidate = JSON.parse(JSON.stringify(latest))
    candidate.hr = latestHr(candidate)
    runtime().sessionDraft = candidate
    try { output = action(candidate) }
    finally { runtime().sessionDraft = null }
    candidate.rev = (candidate.rev || 0) + 1
    return candidate
  })
  if (result.ok) {
    result.value.hr = latestHr(result.value)
    reconcileHrCapture(readStored(K_STATE, hrFields))
  }
  return { ...result, output }
}

export function stageSessionEvent(state, event) {
  const existing = state.pendingEdits?.find(e => e.eventId && e.eventId === event.eventId)
  if (existing) return existing
  const pending = state.pendingEdits ||= []
  if (pending.length >= 256) throw new Error('pending_edits_full')
  const identity = event.eventId ? {} : allocateEventIdentity(event.sid)
  const ex = state.workout?.exercises?.[event.ex], row = state.workout?.rows?.[event.ex]?.[event.set - 1]
  const msg = { ...identity, ...eventIdentity(state, event.ex, event.set - 1), ...event,
    installationId: event.installationId || identity.installationId || runtime().eventClock?.installationId,
    source: 'watch', protocolVersion: 3, dependencyEvents: true }
  msg.entryInstanceId ||= ex?.entryInstanceId; msg.setId ||= row?.setId
  if (msg.t === 'add_set') msg.newSetIds = (state.workout.rows[msg.ex] || []).map(r => r.setId)
  msg.dependsOn = dependenciesFor(msg, pending.filter(e => !e.sid || e.sid === state.sid))
  pending.push(JSON.parse(JSON.stringify(msg)))
  return pending[pending.length - 1]
}

export function startSession(workout, profile) {
  const s = blankState()
  s.active = true
  s.startedAt = now()
  s.sid = workout.sid || 'w' + s.startedAt
  s.profile = profile || null
  s.weightUnit = workout.weightUnit || profile?.weightUnit || 'kg'
  s.protocolVersion = workout.protocolVersion || 1
  s.structureRevision = workout.structureRevision || null
  s.effortScale = workout.effortScale === 'rpe' || workout.effortScale === 'rir' ? workout.effortScale : 'none'
  s.workout = { name: workout.name, exercises: JSON.parse(JSON.stringify(workout.exercises || [])), rows: JSON.parse(JSON.stringify(workout.rows || [])) }
  ensureRows(s)
  if (!runtime().buildingSession) save(s)
  return s
}

// New watch-start follows the same one-document commit boundary as row actions.
export async function commitSessionStart(workout, profile) {
  return writeStoredAtomic(K_STATE, latest => {
    if (latest?.active) throw new Error('session_active')
    const candidate = blankState()
    runtime().sessionDraft = candidate
    try {
      // Build with existing business initializer without publishing its save.
      runtime().buildingSession = true
      const started = startSession(workout, profile)
      Object.assign(candidate, started, { pendingStart: true, planId: workout.id })
      stageSessionEvent(candidate, compactStartEvent({ t: 'watch_start', sid: candidate.sid, startedAt: candidate.startedAt, planId: workout.id, plan: workout }))
      return candidate
    } finally { runtime().buildingSession = false; runtime().sessionDraft = null }
  })
}

// Persistent transport applies independently of the visible Page. The marker shares
// the training document, so state-success / transfer-index-failure is recoverable.
export async function commitWireSnapshot(message, meta) {
  let status = 'applied'
  const result = await writeStoredAtomic(K_STATE, current => {
    let latest = current || blankState()
    const prior = (latest.appliedTransfers || []).find(m => m.id === meta.transferId)
    if (prior) { if (prior.hash !== meta.hash) throw new Error('transfer_mismatch'); status = prior.status; return latest }
    let snapshot = message.t === 'sync_delta' ? expandWireDelta(latest.syncBase, message) : message
    const { wireHash: hash, ...value } = snapshot
    if (!hash || wireHash(value) !== hash) throw new Error('snapshot_checksum')
    if (snapshot.sid !== meta.sid || snapshot.commitRev !== meta.revision) throw new Error('snapshot_version')
    if ((readStored('closed_sessions') || []).includes(snapshot.sid)) throw new Error('session_closed')
    if (latest.active && latest.sid !== snapshot.sid) throw new Error('session_conflict')
    if (latest.closeIntent || runtime().closingSid === snapshot.sid) throw new Error('session_closing')
    if (latest.sid === snapshot.sid && snapshot.commitRev < (latest.commitRev || 0)) status = 'retained'
    else {
      // Never carry cursor/HR/rest/UI flags into a different training. Unresolved
      // old intentions remain available to the existing durable replay path.
      const candidate = latest.sid === snapshot.sid ? JSON.parse(JSON.stringify(latest))
        : { ...blankState(), pendingEdits: JSON.parse(JSON.stringify(latest.pendingEdits || [])).map(e => e.sid ? e : { ...e, sid: latest.sid }) }
      runtime().sessionDraft = candidate
      try {
        if (!candidate.active) Object.assign(candidate, { active: true, sid: snapshot.sid, startedAt: snapshot.startedAt, workout: { exercises: [], rows: [] } })
        applySync(candidate, snapshot)
        latest = candidate
      } finally { runtime().sessionDraft = null }
    }
    latest.appliedTransfers = [...(latest.appliedTransfers || []), { id: meta.transferId, hash: meta.hash, status }].slice(-8)
    return latest
  })
  if (result.ok) reconcileHrCapture(readStored(K_STATE, hrFields))
  return { ...result, status }
}

// 训练中途手机重推计划：替换动作清单，rows 对齐补齐（同名的动作保留已录数据）
export function replacePlan(state, workout) {
  if (!workout || !Array.isArray(workout.exercises) || !workout.exercises.length) return state
  if ((state.pendingEdits || []).length) return state
  state.weightUnit = workout.weightUnit || state.weightUnit || 'kg'
  state.protocolVersion = workout.protocolVersion || state.protocolVersion || 1
  state.structureRevision = workout.structureRevision || state.structureRevision
  if (workout.effortScale != null) state.effortScale = workout.effortScale === 'rpe' || workout.effortScale === 'rir' ? workout.effortScale : 'none'
  const old = state.workout
  const focused = old && old.exercises[state.exIdx]
  const oldRows = (old && old.rows) || []
  state.workout = { name: workout.name || (old && old.name) || '', exercises: workout.exercises }
  state.workout.rows = state.workout.exercises.map((ex, i) => {
    const prevIdx = old.exercises ? old.exercises.findIndex(e => ex.entryInstanceId ? e.entryInstanceId === ex.entryInstanceId : e.name === ex.name) : -1
    const src = prevIdx >= 0 ? oldRows[prevIdx] : ex.entryInstanceId ? [] : (oldRows[i] || [])
    const r = Array.isArray(src) ? src : []
    return Array.from({ length: ex.sets || 1 }, (_, k) => {
      const cell = ex.setIds?.[k] ? r.find(row => row.setId === ex.setIds[k]) : r[k]
      return cell && typeof cell === 'object'
        ? { setId: cell.setId || ex.setIds?.[k], w: cell.w != null ? cell.w : initWeight(ex), r: cell.r != null ? cell.r : initReps(ex), done: !!cell.done, at: cell.at || 0, ...rowEffort(cell) }
        : { setId: ex.setIds?.[k], w: initWeight(ex), r: initReps(ex), done: false, at: 0 }
    })
  })
  // 游标兜底：动作被删了落在前一个，组越界了归到最后一个
  state.exIdx = Math.max(0, Math.min(state.exIdx, state.workout.exercises.length - 1))
  const focusedIndex = focused ? state.workout.exercises.findIndex(ex => focused.entryInstanceId ? ex.entryInstanceId === focused.entryInstanceId : focused.id ? ex.id === focused.id : ex.name === focused.name) : -1
  if (focusedIndex >= 0) state.exIdx = focusedIndex
  const ex = state.workout.exercises[state.exIdx]
  state.setIdx = Math.max(0, Math.min(state.setIdx, (ex.sets || 1) - 1))
  save(state)
  return state
}

// 手机重连后的权威快照：手机是唯一数据源，手表整体接受。
export function applySync(state, snapshot, options) {
  if (!snapshot || !Array.isArray(snapshot.exercises)) return state
  if (snapshot.sid && state.sid && snapshot.sid !== state.sid) return state
  if (snapshot.protocolVersion >= 3 ? snapshot.commitRev < (state.commitRev || 0) : snapshot.rev && snapshot.rev < (state.snapshotRev || 0)) return state
  const previousSegment = state.segmentStartedAt || state.startedAt
  if (snapshot.protocolVersion >= 3) {
    state.commitRev = snapshot.commitRev || 0
    state.syncBase = JSON.parse(JSON.stringify(snapshot))
  }
  state.weightUnit = snapshot.weightUnit || snapshot.profile?.weightUnit || state.weightUnit || 'kg'
  state.protocolVersion = snapshot.protocolVersion || state.protocolVersion || 1
  state.structureRevision = snapshot.structureRevision || state.structureRevision
  if (snapshot.effortScale != null) state.effortScale = snapshot.effortScale === 'rpe' || snapshot.effortScale === 'rir' ? snapshot.effortScale : 'none'
  state.snapshotRev = snapshot.rev || state.snapshotRev || 0
  const stored = options?.pendingEdits ? { sid: state.sid, pendingEdits: options.pendingEdits } : snapshot.protocolVersion >= 3 ? readStored(K_STATE) : null
  const edits = snapshot.sid && snapshot.sid !== state.sid ? [] :
    stored?.sid === state.sid && Array.isArray(stored.pendingEdits) ? stored.pendingEdits : state.pendingEdits || []
  const focused = state.workout && state.workout.exercises[state.exIdx]
  if (snapshot.sid && state.sid && snapshot.sid !== state.sid) {
    // 手机已经换了一场训练：手表不该把旧会话续上去。
    state.sid = snapshot.sid
    state.startedAt = snapshot.startedAt || state.startedAt
    state.hr = { sum: 0, count: 0, max: 0 }
  } else if (snapshot.sid) {
    state.sid = snapshot.sid
  }
  state.active = true
  state.segmentStartedAt = snapshot.segmentStartedAt || state.segmentStartedAt || state.startedAt
  if (snapshot.startedAt) state.startedAt = snapshot.startedAt
  if (state.segmentStartedAt !== previousSegment) state.hr = { sum: 0, count: 0, max: 0 }
  state.workout = {
    name: snapshot.workout || snapshot.name || (state.workout && state.workout.name) || '',
    exercises: snapshot.exercises,
  }
  const srcRows = Array.isArray(snapshot.rows) ? snapshot.rows : []
  state.workout.rows = state.workout.exercises.map((ex, i) => {
    const src = Array.isArray(srcRows[i]) ? srcRows[i] : []
    return Array.from({ length: ex.sets || 1 }, (_, k) => {
      const cell = src[k]
      return cell && typeof cell === 'object'
        ? { setId: cell.setId || ex.setIds?.[k], w: cell.w != null ? cell.w : initWeight(ex), r: cell.r != null ? cell.r : initReps(ex), done: !!cell.done, at: cell.at || 0, ...rowEffort(cell) }
        : { setId: ex.setIds?.[k], w: initWeight(ex), r: initReps(ex), done: false, at: 0 }
    })
  })
  // 手机尚未回传对应确认值的本地编辑，不能被在途旧快照覆盖。
  state.pendingEdits = edits
  state.pendingEdits = edits.filter(e => (e.sid && e.sid !== state.sid) || (!(snapshot.ackedEvents || []).includes(e.eventId) && !(snapshot.protocolVersion >= 3 && e.committedRev != null && e.committedRev <= snapshot.commitRev)))
  const maxEx = Math.max(0, state.workout.exercises.length - 1)
  state.exIdx = Math.max(0, Math.min(Number(state.exIdx) || 0, maxEx))
  const focusedIndex = focused ? state.workout.exercises.findIndex(ex => focused.entryInstanceId ? ex.entryInstanceId === focused.entryInstanceId : focused.id ? ex.id === focused.id : ex.name === focused.name) : -1
  if (focusedIndex >= 0) state.exIdx = focusedIndex
  const curRows = state.workout.rows[state.exIdx] || []
  state.setIdx = Math.max(0, Math.min(Number(state.setIdx) || 0, Math.max(0, curRows.length - 1)))
  const incomingFocusAt = Number(snapshot.focusAt || (snapshot.focus && snapshot.focus.at) || 0)
  if (snapshot.protocolVersion >= 3 || incomingFocusAt > (state.focusAt || 0)) {
    const incomingEx = Math.max(0, Math.min(Number(snapshot.exIdx) || 0, maxEx))
    const incomingRows = state.workout.rows[incomingEx] || []
    state.exIdx = incomingEx
    state.setIdx = Math.max(0, Math.min(Number(snapshot.setIdx) || 0, Math.max(0, incomingRows.length - 1)))
    state.focusAt = incomingFocusAt
  }
  if (snapshot.protocolVersion >= 3 || snapshot.pauseVersion >= (state.pauseVersion || 0)) {
    state.pausedAt = snapshot.pausedAt || 0
    state.pausedMs = snapshot.pausedMs || 0
    state.pauseVersion = snapshot.pauseVersion || 0
  }
  if (snapshot.rest) {
    if (snapshot.protocolVersion >= 3) state.restVersion = 0
    applyRest(state, snapshot.rest)
  }
  else if (!state.restVersion) state.restUntil = snapshot.restUntil || 0
  if (snapshot.baseCalories != null) state.baseCalories = snapshot.baseCalories
  if (snapshot.profile) state.profile = snapshot.profile
  for (const edit of state.pendingEdits) if (!edit.sid || edit.sid === state.sid) applyEdit(state, edit)
  state.rev = Math.max(state.rev || 0, snapshot.rev || 0)
  persist(state)
  return state
}
// A receipt can arrive after its snapshot. Rebuild the durable projection after
// retiring its overlay; notifying a page alone must never leave that overlay in rows/focus.
export function reconcileCommittedSnapshot(state, revision, delta) {
  if (delta && state.active && !state.closeIntent && state.sid === delta.sid &&
      (!state.syncBase || state.syncBase.commitRev < revision ||
        (state.syncBase.commitRev === revision && state.syncBase.wireHash !== delta.wireHash))) {
    if (delta.t !== 'sync_delta' || delta.commitRev !== revision) throw new Error('receipt_version')
    const snapshot = expandWireDelta(state.syncBase, delta)
    const previousDraft = runtime().sessionDraft
    runtime().sessionDraft = state
    try { return applySync(state, snapshot, { pendingEdits: state.pendingEdits || [] }) }
    finally { runtime().sessionDraft = previousDraft }
  }
  if (!state.active || !state.syncBase || !Number.isFinite(revision) || state.syncBase.sid !== state.sid || state.syncBase.commitRev < revision) return state
  const previousDraft = runtime().sessionDraft
  runtime().sessionDraft = state
  try { return applySync(state, state.syncBase, { pendingEdits: state.pendingEdits || [] }) }
  finally { runtime().sessionDraft = previousDraft }
}

export function nextUndoneFrom(s, exIdx = s.exIdx, setIdx = s.setIdx) {
  const count = s.workout.rows.length
  const start = Math.max(0, Math.min(Number(exIdx) || 0, Math.max(0, count - 1)))
  for (let offset = 0; offset < count; offset++) {
    const i = (start + offset) % count
    const startJ = offset === 0 ? (Number(setIdx) || 0) + 1 : 0
    for (let j = startJ; j < s.workout.rows[i].length; j++) {
      if (!s.workout.rows[i][j].done) return { exIdx: i, setIdx: j }
    }
  }
  return null
}

export function nextUndone(s) {
  return nextUndoneFrom(s, s.exIdx, s.setIdx)
}

// 会话是否全部完成
export function allDone(s) {
  return !nextUndone(s)
}

// 完成/撤销当前游标指向的那一组。done=true 时把行上录的 w/r 固化并开休息。
export function toggleSet(state, done) {
  const row = state.workout.rows[state.exIdx] && state.workout.rows[state.exIdx][state.setIdx]
  if (!row) return null
  if (done === !!row.done) return null // 状态没变（重复点击）
  row.done = !!done
  row.at = done ? now() : 0
  if (done) {
    const ex = state.workout.exercises[state.exIdx]
    state.restStartedAt = now()
    state.restId = state.sid + ':' + state.restStartedAt
    state.restTargetSec = ex.restSec || storage.getSync({ key: 'default_rest_sec' }) || 90
    state.restVersion = now()
    state.restUntil = now() + state.restTargetSec * 1000
  } else {
    state.restUntil = 0
  }
  save(state)
  return row
}

// 改某组的重量/次数（手表本地编辑 or 手机 weight 同步），立即落盘
export function setRowValue(state, exIdx, setIdx, field, value, notifyPhone = false) {
  const row = state.workout.rows[exIdx] && state.workout.rows[exIdx][setIdx]
  if (!row) return
  if (field === 'w') row.w = value === '' || value == null ? '' : value
  else if (field === 'r') row.r = value === '' || value == null ? '' : value
  if (notifyPhone) {
    // 输入页没有训练页的 RPC 实例。先与行数据一起落盘，返回后交给训练页的 outbox。
    const edits = state.pendingEdits ||= []
    const at = Math.max(now(), edits.length ? edits[edits.length - 1].at + 1 : 0)
    stageSessionEvent(state, { ...eventIdentity(state, exIdx, setIdx), t: field === 'w' ? 'weight' : 'reps', sid: state.sid, ex: exIdx, set: setIdx + 1,
      [field === 'w' ? 'weight' : 'reps']: row[field], at })
    state.pendingEdits = edits
  }
  save(state)
}

// 每组强度：只写这一个字段，并清掉另一量表；version 是独立于 done/weight/rest 的评分版本。
// value 为 null 表示“明确清除”（effortAt 保留，用来拒绝更旧的消息复活旧值）。
export function setEffort(state, ex, set, scale, value, version) {
  const row = state.workout?.rows?.[ex]?.[set]
  if (!row) return false
  if (scale !== 'rpe' && scale !== 'rir') return false
  const at = Number.isFinite(version) ? version : now()
  if (Number.isFinite(row.effortAt) && at < row.effortAt) return false
  delete row.rpe; delete row.rir
  if (typeof value === 'number' && Number.isFinite(value)) row[scale] = value
  row.effortAt = at
  return true
}

// 当前动作加一组（末尾追加，继承最后一组的重量；次数回到计划目标）
export function addSet(state, exIdx) {
  const ex = state.workout.exercises[exIdx]
  const rows = state.workout.rows[exIdx]
  if (!ex || !rows) return
  const last = rows[rows.length - 1]
  rows.push({ setId: 'watch-set:' + state.sid + ':' + now() + ':' + Math.random().toString(36).slice(2), w: last ? last.w : initWeight(ex), r: initReps(ex), done: false, at: 0 })
  ex.sets = rows.length
  save(state)
}

// 当前动作减一组（去掉最后一组；已完成的组不可删，先撤销）
export function removeSet(state, exIdx) {
  const rows = state.workout.rows[exIdx]
  if (!rows || rows.length <= 1) return // 至少留一组
  const last = rows[rows.length - 1]
  if (last.done) return
  rows.pop()
  state.workout.exercises[exIdx].sets = rows.length
  if (state.exIdx === exIdx && state.setIdx >= rows.length) state.setIdx = rows.length - 1
  save(state)
}

// 休息累计（本次训练的组间休息总秒数，休息页显示"总计"）
export function addRestTime(state, sec) {
  if (!(sec > 0)) return
  state.restTotalSec = (state.restTotalSec || 0) + Math.round(sec)
}

// Every valid sample enters the App aggregate, independently of Page/disk lifetime.
export function addHr(state, bpm) {
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 220) return
  state.hr = latestHr(state)
  const sampleAt = now()
  state.hr.sampledDurationMs = (state.hr.sampledDurationMs || 0) + (state.hr.sampleAt ? Math.max(0, Math.min(15000, sampleAt - state.hr.sampleAt)) : 0)
  state.hr.sampleAt = sampleAt
  state.hr.last = bpm
  state.hr.sum += bpm
  state.hr.count += 1
  if (bpm > state.hr.max) state.hr.max = bpm
  runtime().sessionHr = { sid: state.sid, segmentStartedAt: state.segmentStartedAt || state.startedAt, hr: { ...state.hr } }
}

// Queue only an HR intention, never an old Page's rows/pending events. The transform
// runs after preceding atomic actions and merges against their published document.
// Keep the aggregate on failure so a subsequent sample/save/stop can retry it.
export function flushHr(state = runtime().sessionHr) {
  if (!state?.sid) return Promise.resolve({ ok: true })
  const target = { sid: state.sid, segmentStartedAt: state.segmentStartedAt || state.startedAt, hr: latestHr(state) }
  const stored = readStored(K_STATE, hrFields)
  if (!sameHrSession(target, stored) || target.hr.count <= (stored.hr?.count || 0)) return Promise.resolve({ ok: true })
  return writeStoredAtomic(K_STATE, latest => {
    if (!sameHrSession(target, latest) || latest.closeIntent) return latest
    latest.hr = { ...newerHr(latestHr(latest), target.hr) }
    latest.rev = (latest.rev || 0) + 1
    return latest
  })
}

// 热量估算：有心率走 Keytel；没有心率用 MET 5.0（力量训练）兜底。
export function calories(state, profile, minutes) {
  const w = (profile && (profile.bodyWeightKg || profile.weight)) || 70
  if (!minutes) return 0
  const aggregate = latestHr(state)
  const hr = aggregate.count ? Math.round(aggregate.sum / aggregate.count) : 0
  if (!hr) return Math.max(0, Math.round(5.0 * w * (minutes / 60)))
  const a = (profile && profile.age) || 30
  const male = !profile || profile.sex !== 'female'
  const kcalPerMin = male
    ? (-55.0969 + 0.6309 * hr + 0.1988 * a + 0.2017 * w) / 4.184
    : (-20.4022 + 0.4472 * hr - 0.1263 * a + 0.074 * w) / 4.184
  return Math.max(0, Math.round(kcalPerMin * minutes))
}

// 纯结算：只计算本段结果，不写存储、不关闭会话、不碰 outbox。
// 关闭流程（RPC 的 session_close/ended、训练页主动结束、动作列表保存）都从这里取同一份
// 数据，避免“有的入口结了算、有的入口结了算还顺手清空”。
export function buildSessionSummary(state, profile, endedAt = now()) {
  state = { ...state, hr: latestHr(state) }
  const end = Math.min(now(), Math.max(state.segmentStartedAt || state.startedAt, Number(endedAt) || now()))
  const minutes = Math.max(0, ((state.pausedAt || end) - (state.segmentStartedAt || state.startedAt) - (state.pausedMs || 0)) / 60000)
  const flat = []
  ;(state.workout?.rows || []).forEach((rows, ex) => rows.forEach((row, set) => {
    if (row.done) flat.push({ ...eventIdentity(state, ex, set), ex, set: set + 1, reps: row.r != null ? String(row.r) : '', weight: row.w != null ? String(row.w) : '', at: row.at || now(),
      ...(Number.isFinite(row.rpe) ? { rpe: row.rpe } : {}), ...(Number.isFinite(row.rir) ? { rir: row.rir } : {}),
      ...(Number.isFinite(row.effortAt) ? { effortVersion: row.effortAt, ...(Number.isFinite(row.rpe) || Number.isFinite(row.rir) ? {} : { effortCleared: true }) } : {}) })
  }))
  return {
    id: state.sid || 's' + state.startedAt,
    sid: state.sid || 's' + state.startedAt,
    workout: state.workout ? state.workout.name : '',
    startedAt: state.startedAt,
    endedAt: end,
    minutes,
    avgHr: state.hr?.count ? Math.round(state.hr.sum / state.hr.count) : 0,
    maxHr: state.hr?.max || 0,
    calories: calories(state, profile, minutes),
    weightUnit: state.weightUnit || 'kg', algorithmVersion: 1, sampleCount: state.hr?.count || 0,
    sampledDurationMs: state.hr?.sampledDurationMs || 0,
    volume: flat.reduce((sum, s) => {
      const w = parseFloat(s.weight)
      const r = parseFloat(s.reps)
      return sum + (Number.isFinite(w) && Number.isFinite(r) ? w * r : 0)
    }, 0),
    sets: flat,
  }
}

// 本段最终汇总事件（冻结值，只含本段 calories，不含更早续练段的 baseCalories）。
// eventId/seq 由调用方一次性分配并随关闭日志持久保存；这里不生成随机 ID。
export function summaryEventOf(session, identity, state, final = true) {
  return {
    t: 'summary', sid: session.sid, eventId: identity.eventId, seq: identity.seq, at: identity.at,
    endedAt: session.endedAt, calories: session.calories, avgHr: session.avgHr, maxHr: session.maxHr,
    minutes: session.minutes, volume: session.volume, weightUnit: session.weightUnit,
    algorithmVersion: session.algorithmVersion, sampleCount: session.sampleCount,
    sampledDurationMs: session.sampledDurationMs, protocolVersion: state?.protocolVersion || 1,
    structureRevision: state?.structureRevision || null, sets: session.sets.length, source: 'watch',
    ...(final ? { final: true } : {}),
  }
}

// 结束会话（主动保存）：结算 → 写 summary_last → 清空当前状态。
// 注意：这里没有可靠的待上传队列。需要手机确认的最终汇总走 close-journal.js（rpc 负责），
// 不能只看这个函数的返回值就以为“已经传到手机”。
export function endSession(state, profile, endedAt = now()) {
  const session = buildSessionSummary(state, profile, endedAt)
  closeSession(state.sid)
  writeStored('summary_last', { ...session, totalMinutes: Math.max(0, ((state.pausedAt || session.endedAt) - state.startedAt - (state.pausedMs || 0)) / 60000), totalCalories: (state.baseCalories || 0) + session.calories, sets: session.sets.length })
  return session
}

export function closeSession(sid, extra = {}) {
  runtime().hrCapture?.stop()
  const closed = readStored('closed_sessions') || []
  writeStored('closed_sessions', [...closed.filter(id => id !== sid), sid].slice(-500))
  save({ ...blankState(), ...extra })
}

export function eventIdentity(s, ex, set) {
  return { protocolVersion: s.protocolVersion || 1, baseCommitRev: s.commitRev || 0, sessionEpoch: s.sid,
    entryInstanceId: s.workout?.exercises?.[ex]?.entryInstanceId,
    setId: s.workout?.rows?.[ex]?.[set]?.setId, structureRevision: s.structureRevision, weightUnit: s.weightUnit || 'kg' }
}

// Freeze both close payload and prerequisites BEFORE clearing the active session.
// The journal is the recovery source even when the process exits before Outbox save.
export async function commitLocalClose(sid, disposition, closedAt = now()) {
  if (runtime().closingSid) return { ok: false, error: 'close_busy' }
  runtime().closingSid = sid
  try {
    const frozen = await writeStoredAtomic(K_STATE, latest => {
      if (!latest?.active || latest.sid !== sid) throw new Error('session_changed')
      if (latest.closeIntent) return latest
      latest.hr = latestHr(latest)
      const session = buildSessionSummary(latest, latest.profile, closedAt)
      const closeEvent = stageSessionEvent(latest, { t: 'session_close', sid, disposition, closedAt, at: closedAt,
        ...(disposition === 'saved' ? { workout: latest.workout, startedAt: latest.startedAt, weightUnit: latest.weightUnit || 'kg',
          summary: { minutes: session.minutes, avgHr: session.avgHr, maxHr: session.maxHr, calories: session.calories, volume: session.volume }, completedSets: session.sets } : {}) })
      const summaryEvent = summaryEventOf(session, allocateEventIdentity(sid), latest, true)
      summaryEvent.protocolVersion = 3; summaryEvent.dependencyEvents = true; summaryEvent.dependsOn = [closeEvent.eventId]
      latest.pendingEdits = latest.pendingEdits.filter(e => e.eventId !== closeEvent.eventId)
      latest.closeIntent = { close: { sid, disposition, closedAt, eventId: closeEvent.eventId, closeEvent,
        pendingEvents: (latest.pendingEdits || []).filter(e => e.eventId !== closeEvent.eventId && e.committedRev == null) }, summaryEvent, session, summaryLast: { ...session, totalMinutes: Math.max(0, ((latest.pausedAt || session.endedAt) - latest.startedAt - (latest.pausedMs || 0)) / 60000), totalCalories: (latest.baseCalories || 0) + session.calories, sets: session.sets.length } }
      return latest
    })
    if (!frozen.ok) return frozen
    reconcileHrCapture(readStored(K_STATE, hrFields))
    return finishLocalClose(frozen.value.closeIntent)
  } finally { runtime().closingSid = null }
}

async function finishLocalClose(intent) {
  const { close, summaryEvent, session } = intent
  const entry = await prepareClose(close, summaryEvent, close.disposition === 'saved' ? 'pending' : 'candidate')
  if (!entry?.closeEvent) return { ok: false, error: 'close_journal_storage' }
  // Once the journal is durable the UI may leave. A failed clear is recovered on boot.
  // Keep closeIntent until ALL recovery data is durable. Clearing first creates a
  // crash window with neither tombstone/summary_last nor a recoverable intention.
  const closed = await writeStoredAtomic('closed_sessions', value => [...(value || []).filter(id => id !== close.sid), close.sid].slice(-500))
  const summary = close.disposition !== 'saved' || (await writeStoredAtomic('summary_last', () => intent.summaryLast || ({ ...session, totalMinutes: session.minutes, totalCalories: session.calories, sets: session.sets.length }))).ok
  if (!closed.ok || !summary) return { ok: true, entry, session, pendingRecovery: true }
  const cleared = await writeStoredAtomic(K_STATE, latest => latest?.sid === close.sid ? blankState() : latest)
  if (cleared.ok) runtime().hrCapture?.stop()
  return { ok: true, entry, session, pendingRecovery: !cleared.ok }
}
export async function recoverLocalClose() {
  const intent = loadState().closeIntent
  return intent ? finishLocalClose(intent) : { ok: true }
}
