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

const K_STATE = 'session_state'

const now = () => Date.now()

export function blankState() {
  return {
    active: false,
    startedAt: 0,
    sid: '',            // 会话 id：BLE 回传时手机按 sid+动作+组号 幂等去重
    workout: null,      // { name, exercises, rows } —— rows 与 exercises 对齐
    profile: null,      // { weight, age, sex } 热量估算用，随计划推送过来
    exIdx: 0,           // 当前动作下标（游标，可自由切）
    setIdx: 0,          // 当前动作内的组下标（游标，可自由切）
    restUntil: 0,       // 绝对时间戳；0 表示不在休息
    hr: { sum: 0, count: 0, max: 0 },
    rev: 0,             // 本地修订号；手机 sync 用它判断谁更新
  }
}

// 同步读（启动路径上不能等异步回调，闪退恢复要立刻拿到状态）
export function loadState() {
  try {
    const s = storage.getSync({ key: K_STATE })
    if (s && typeof s === 'object' && s.workout) {
      if (s.rev == null) s.rev = 0
      ensureRows(s)
      return s
    }
  } catch (e) { /* 首次运行没有记录 */ }
  return blankState()
}

// rows 缺失/长度对不上（老版本升级、计划热替换）时按计划补齐，已有数据原样保留
function ensureRows(s) {
  if (!s.workout) return
  const rows = s.workout.rows || []
  s.workout.rows = (s.workout.exercises || []).map((ex, i) => {
    const r = Array.isArray(rows[i]) ? rows[i] : []
    return Array.from({ length: ex.sets || 1 }, (_, k) => {
      const cell = r[k]
      return cell && typeof cell === 'object'
        ? { w: cell.w != null ? cell.w : initWeight(ex), r: cell.r != null ? cell.r : initReps(ex), done: !!cell.done, at: cell.at || 0 }
        : { w: initWeight(ex), r: initReps(ex), done: false, at: 0 }
    })
  })
}

// 计划里带的目标值作为初始值（手机端"计划从上一组带过来"的等价物）
function initWeight(ex) { return ex.weight === '' || ex.weight == null ? '' : ex.weight }
function initReps(ex) { return ex.reps == null ? '' : ex.reps }

// 每次改动立即落盘。storage.set 是异步的，失败回调必须给（文档要求）。
function persist(state) {
  storage.set({
    key: K_STATE,
    value: state,
    fail: (data, code) => console.log('save state failed', code),
  })
}

export function save(state) {
  state.rev = (state.rev || 0) + 1
  persist(state)
}

export function startSession(workout, profile) {
  const s = blankState()
  s.active = true
  s.startedAt = now()
  s.sid = workout.sid || 'w' + s.startedAt
  s.profile = profile || null
  s.workout = { name: workout.name, exercises: workout.exercises || [] }
  ensureRows(s)
  save(s)
  return s
}

// 训练中途手机重推计划：替换动作清单，rows 对齐补齐（同名的动作保留已录数据）
export function replacePlan(state, workout) {
  if (!workout || !Array.isArray(workout.exercises) || !workout.exercises.length) return state
  const old = state.workout
  const oldRows = (old && old.rows) || []
  state.workout = { name: workout.name || (old && old.name) || '', exercises: workout.exercises }
  state.workout.rows = state.workout.exercises.map((ex, i) => {
    const prevIdx = old.exercises ? old.exercises.findIndex(e => e.name === ex.name) : -1
    const src = prevIdx >= 0 ? oldRows[prevIdx] : (oldRows[i] || [])
    const r = Array.isArray(src) ? src : []
    return Array.from({ length: ex.sets || 1 }, (_, k) => {
      const cell = r[k]
      return cell && typeof cell === 'object'
        ? { w: cell.w != null ? cell.w : initWeight(ex), r: cell.r != null ? cell.r : initReps(ex), done: !!cell.done, at: cell.at || 0 }
        : { w: initWeight(ex), r: initReps(ex), done: false, at: 0 }
    })
  })
  // 游标兜底：动作被删了落在前一个，组越界了归到最后一个
  state.exIdx = Math.max(0, Math.min(state.exIdx, state.workout.exercises.length - 1))
  const ex = state.workout.exercises[state.exIdx]
  state.setIdx = Math.max(0, Math.min(state.setIdx, (ex.sets || 1) - 1))
  save(state)
  return state
}

// 手机重连后的权威快照：手机是唯一数据源，手表整体接受。
export function applySync(state, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.exercises)) return state
  const edits = snapshot.sid && snapshot.sid !== state.sid ? [] : state.pendingEdits || []
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
        ? { w: cell.w != null ? cell.w : initWeight(ex), r: cell.r != null ? cell.r : initReps(ex), done: !!cell.done, at: cell.at || 0 }
        : { w: initWeight(ex), r: initReps(ex), done: false, at: 0 }
    })
  })
  // 手机尚未回传对应确认值的本地编辑，不能被在途旧快照覆盖。
  state.pendingEdits = edits
  for (const edit of edits) {
    const row = state.workout.rows[edit.ex] && state.workout.rows[edit.ex][edit.set - 1]
    if (row) row[edit.t === 'weight' ? 'w' : 'r'] = edit.t === 'weight' ? edit.weight : edit.reps
  }
  const maxEx = Math.max(0, state.workout.exercises.length - 1)
  state.exIdx = Math.max(0, Math.min(Number(snapshot.exIdx) || 0, maxEx))
  const curRows = state.workout.rows[state.exIdx] || []
  state.setIdx = Math.max(0, Math.min(Number(snapshot.setIdx) || 0, Math.max(0, curRows.length - 1)))
  state.restUntil = snapshot.restUntil || 0
  if (snapshot.profile) state.profile = snapshot.profile
  state.rev = Math.max(state.rev || 0, snapshot.rev || 0)
  persist(state)
  return state
}
export function nextUndone(s) {
  for (let i = 0; i < s.workout.rows.length; i++) {
    const startJ = i === s.exIdx ? s.setIdx + 1 : 0
    for (let j = startJ; j < s.workout.rows[i].length; j++) {
      if (!s.workout.rows[i][j].done) return { exIdx: i, setIdx: j }
    }
  }
  for (let i = 0; i <= s.exIdx && i < s.workout.rows.length; i++) {
    for (let j = 0; j < s.workout.rows[i].length; j++) {
      if (!s.workout.rows[i][j].done) return { exIdx: i, setIdx: j }
    }
  }
  return null
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
    state.restUntil = now() + (ex.restSec || 60) * 1000
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
    edits.push({ t: field === 'w' ? 'weight' : 'reps', sid: state.sid, ex: exIdx, set: setIdx + 1,
      [field === 'w' ? 'weight' : 'reps']: row[field], at })
    state.pendingEdits = edits
  }
  save(state)
}

// 当前动作加一组（末尾追加，继承最后一组的重量；次数回到计划目标）
export function addSet(state, exIdx) {
  const ex = state.workout.exercises[exIdx]
  const rows = state.workout.rows[exIdx]
  if (!ex || !rows) return
  const last = rows[rows.length - 1]
  rows.push({ w: last ? last.w : initWeight(ex), r: initReps(ex), done: false, at: 0 })
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
  state.hr.sum += bpm
  state.hr.count += 1
  if (bpm > state.hr.max) state.hr.max = bpm
}

export function flushHr(state) { save(state) }

// 热量估算：有心率走 Keytel；没有心率用 MET 5.0（力量训练）兜底。
export function calories(state, profile, minutes) {
  const w = (profile && profile.weight) || 70
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

// 结束会话：结算（含每组实际录的 w/r、总时长、卡路里）→ 待上传队列 → 清空当前状态
export function endSession(state, profile, endedAt = now()) {
  const end = Math.min(now(), Math.max(state.segmentStartedAt || state.startedAt, Number(endedAt) || now()))
  const minutes = Math.max(0, (end - (state.segmentStartedAt || state.startedAt)) / 60000)
  const flat = []
  ;(state.workout.rows || []).forEach((rows, ex) => rows.forEach((row, set) => {
    if (row.done) flat.push({ ex, set: set + 1, reps: row.r != null ? String(row.r) : '', weight: row.w != null ? String(row.w) : '', at: row.at || now() })
  }))
  const session = {
    id: state.sid || 's' + state.startedAt,
    sid: state.sid || 's' + state.startedAt,
    workout: state.workout ? state.workout.name : '',
    startedAt: state.startedAt,
    endedAt: end,
    minutes,
    avgHr: state.hr.count ? Math.round(state.hr.sum / state.hr.count) : 0,
    maxHr: state.hr.max,
    calories: calories(state, profile, minutes),
    volume: flat.reduce((sum, s) => {
      const w = parseFloat(s.weight)
      const r = parseFloat(s.reps)
      return sum + (Number.isFinite(w) && Number.isFinite(r) ? w * r : 0)
    }, 0),
    sets: flat,
  }
  const s = blankState()
  const closed = storage.getSync({ key: 'closed_sessions' }) || []
  storage.set({ key: 'closed_sessions', value: [...closed.filter(id => id !== session.sid), session.sid].slice(-100), fail() {} })
  storage.set({ key: 'summary_last', value: { ...session, sets: session.sets.length }, fail() {} })
  save(s)
  return session
}
