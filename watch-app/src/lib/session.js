// 会话状态机 + 持久化。防闪退的关键：每一个动作（完成一组、休息开始、心率累计）
// 都立刻写入本地存储；应用启动时读回状态继续，而不是从头开始。
//
// 存储结构：
//   session_state    当前会话的紧凑状态（训练位置、休息截止的绝对时间戳、心率累计）
//   session_journal  已完成组的流水（每组一条，崩溃最多丢最后一条未落盘的）
//   pending_sessions 已结束但还没上传成功的会话，下次启动重试
import storage from '@blueos.storage.storage'

const K_STATE = 'session_state'
const K_PENDING = 'pending_sessions'

const now = () => Date.now()

export function blankState() {
  return {
    active: false,
    startedAt: 0,
    workout: null,      // { name, exercises: [{ name, sets, restSec, weight }] }
    exIdx: 0,
    setIdx: 0,
    restUntil: 0,       // 绝对时间戳；0 表示不在休息
    sets: [],           // [{ ex, set, reps, weight, at }]
    hr: { sum: 0, count: 0, max: 0 },
  }
}

// 同步读（启动路径上不能等异步回调，闪退恢复要立刻拿到状态）
export function loadState() {
  try {
    const s = storage.getSync({ key: K_STATE })
    if (s && typeof s === 'object' && s.workout) return s
  } catch (e) { /* 首次运行没有记录 */ }
  return blankState()
}

// 每次改动立即落盘。storage.set 是异步的，失败回调必须给（文档要求）。
export function save(state) {
  storage.set({
    key: K_STATE,
    value: state,
    fail: (data, code) => console.log('save state failed', code),
  })
}

export function startSession(workout) {
  const s = blankState()
  s.active = true
  s.startedAt = now()
  s.workout = workout
  save(s)
  return s
}

// 完成当前这一组：记录 → 推进到下一组 → 开休息倒计时（绝对时间戳，重启也能算对）
export function completeSet(state) {
  const ex = state.workout.exercises[state.exIdx]
  if (!ex) return state
  state.sets.push({
    ex: ex.name,
    set: state.setIdx + 1,
    reps: ex.reps || '',
    weight: ex.weight === '' || ex.weight == null ? '' : ex.weight,
    at: now(),
  })
  state.restUntil = now() + (ex.restSec || 60) * 1000

  if (state.setIdx + 1 >= (ex.sets || 1)) {
    state.exIdx += 1
    state.setIdx = 0
  } else {
    state.setIdx += 1
  }
  if (state.exIdx >= state.workout.exercises.length) {
    state.exIdx = state.workout.exercises.length - 1
    state.setIdx = (state.workout.exercises[state.exIdx].sets || 1) - 1
    state.finished = true
  }
  save(state)
  return state
}

// 心率累计（增量保存，崩溃最多丢几秒的心率）
export function addHr(state, bpm) {
  if (!bpm || bpm < 30 || bpm > 220) return
  state.hr.sum += bpm
  state.hr.count += 1
  if (bpm > state.hr.max) state.hr.max = bpm
}

export function flushHr(state) { save(state) }

// 热量估算：Keytel 公式（按心率/体重/年龄/时长），够"大概数据"用
export function calories(state, profile, minutes) {
  const hr = state.hr.count ? Math.round(state.hr.sum / state.hr.count) : 0
  if (!hr || !minutes) return 0
  const w = (profile && profile.weight) || 70
  const a = (profile && profile.age) || 30
  const male = !profile || profile.sex !== 'female'
  const kcalPerMin = male
    ? (-55.0969 + 0.6309 * hr + 0.1988 * a + 0.2017 * w) / 4.184
    : (-20.4022 + 0.4472 * hr - 0.1263 * a + 0.074 * w) / 4.184
  return Math.max(0, Math.round(kcalPerMin * minutes))
}

// 结束会话：结算 → 放进待上传队列 → 清空当前状态
export function endSession(state, profile) {
  const minutes = Math.max(1, Math.round((now() - state.startedAt) / 60000))
  const session = {
    id: 's' + state.startedAt,
    workout: state.workout ? state.workout.name : '',
    startedAt: state.startedAt,
    endedAt: now(),
    minutes,
    avgHr: state.hr.count ? Math.round(state.hr.sum / state.hr.count) : 0,
    maxHr: state.hr.max,
    calories: calories(state, profile, minutes),
    sets: state.sets,
  }
  queuePending(session)
  const s = blankState()
  save(s)
  return session
}

export function queuePending(session) {
  const list = listPending()
  list.push(session)
  storage.set({ key: K_PENDING, value: list, fail: (d, c) => console.log('queue failed', c) })
}

export function listPending() {
  try {
    const l = storage.getSync({ key: K_PENDING })
    return Array.isArray(l) ? l : []
  } catch (e) { return [] }
}

export function clearPending() {
  storage.set({ key: K_PENDING, value: [], fail: () => {} })
}
