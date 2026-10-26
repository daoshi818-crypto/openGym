import { runtime } from './runtime.js'
import { readStored, writeStored } from './persistence.js'
// 会话状态机 + 持久化。防闪退的关键：每一个动作（完成一组、休息开始、心率累计）
// 都立刻写入本地存储；应用启动时读回状态继续，而不是从头开始。
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
export function loadState() {
  try {
    const s = readStored(K_STATE)
    if (s?.expiredClose) queueExpired(s.expiredClose)
    if (s && typeof s === 'object' && s.workout) {
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
  writeStored(K_STATE, state)
}

export function save(state) {
  const latest = readStored(K_STATE)
  if (latest?.sid === state.sid && latest.segmentStartedAt === state.segmentStartedAt && (latest.hr?.sampleAt || 0) > (state.hr?.sampleAt || 0)) state.hr = latest.hr
  if (state.pausedAt || !state.active) runtime().hrCapture?.stop()
  state.rev = (state.rev || 0) + 1
  persist(state)
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
  save(s)
  return s
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
export function applySync(state, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.exercises)) return state
  if (snapshot.sid && state.sid && snapshot.sid !== state.sid) return state
  if (snapshot.protocolVersion >= 3 ? snapshot.commitRev < (state.commitRev || 0) : snapshot.rev && snapshot.rev < (state.snapshotRev || 0)) return state
  if (snapshot.protocolVersion >= 3) {
    state.commitRev = snapshot.commitRev || 0
    state.syncBase = JSON.parse(JSON.stringify(snapshot))
  }
  state.weightUnit = snapshot.weightUnit || snapshot.profile?.weightUnit || state.weightUnit || 'kg'
  state.protocolVersion = snapshot.protocolVersion || state.protocolVersion || 1
  state.structureRevision = snapshot.structureRevision || state.structureRevision
  if (snapshot.effortScale != null) state.effortScale = snapshot.effortScale === 'rpe' || snapshot.effortScale === 'rir' ? snapshot.effortScale : 'none'
  state.snapshotRev = snapshot.rev || state.snapshotRev || 0
  const stored = snapshot.protocolVersion >= 3 ? readStored(K_STATE) : null
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
  state.pendingEdits = edits.filter(e => !(snapshot.ackedEvents || []).includes(e.eventId) && !(snapshot.protocolVersion >= 3 && e.committedRev != null && e.committedRev <= snapshot.commitRev))
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
  for (const edit of state.pendingEdits) applyEdit(state, edit)
  state.rev = Math.max(state.rev || 0, snapshot.rev || 0)
  persist(state)
  return state
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
    const edits = state.pendingEdits || []
    const at = Math.max(now(), edits.length ? edits[edits.length - 1].at + 1 : 0)
    edits.push({ ...eventIdentity(state, exIdx, setIdx), t: field === 'w' ? 'weight' : 'reps', sid: state.sid, ex: exIdx, set: setIdx + 1,
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

// 心率累计（增量保存，崩溃最多丢几秒的心率）
export function addHr(state, bpm) {
  if (!bpm || bpm < 30 || bpm > 220) return
  const sampleAt = now()
  state.hr.sampledDurationMs = (state.hr.sampledDurationMs || 0) + (state.hr.sampleAt ? Math.max(0, Math.min(15000, sampleAt - state.hr.sampleAt)) : 0)
  state.hr.sampleAt = sampleAt
  state.hr.last = bpm
  state.hr.sum += bpm
  state.hr.count += 1
  if (bpm > state.hr.max) state.hr.max = bpm
}

export function flushHr(state) { save(state) }

// 热量估算：有心率走 Keytel；没有心率用 MET 5.0（力量训练）兜底。
export function calories(state, profile, minutes) {
  const w = (profile && (profile.bodyWeightKg || profile.weight)) || 70
  if (!minutes) return 0
  const hr = state.hr.count ? Math.round(state.hr.sum / state.hr.count) : 0
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
