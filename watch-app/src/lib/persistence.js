import storage from '@blueos.storage.storage'
import { runtime } from './runtime.js'
// 存储封装：内存缓存 + 按 key 串行写。
//
// 两个曾经被误当真的点（真机/测试都能复现）：
//  1) writeStored 立刻更新内存缓存，storage.set 是异步的 —— 马上 readStored 读到新值
//     不代表已经落盘；给 writeStored() 加 await 也不会等它。
//  2) storage.set 的回调如果永远不回来，旧的 drain 会把 q.busy 永久置为 true：
//     这个 key 之后所有写入都排在一条再也不会流动的链上，outbox 与 session 状态一起
//     停摆，且没有任何可见错误。现在加了超时看门狗，回调丢失按失败处理并允许重试。
//
// writeStoredConfirmed() 提供“该版本或更晚版本已写盘成功”的确认语义，
// 与 writeStored 共用同一条每 key 串行链（不另起第二条写链）。
const clone = v => JSON.parse(JSON.stringify(v))
const data = () => runtime().persistence ||= { values: {}, queues: {}, errors: {}, revisions: {} }
const WRITE_TIMEOUT_MS = 5000
const later = (fn, ms) => { try { return setTimeout(fn, ms) } catch { return null } }
const cancel = t => { try { if (t != null) clearTimeout(t) } catch { /* 无定时器 */ } }

export function readStored(key) {
  const state = data()
  if (Object.prototype.hasOwnProperty.call(state.values, key)) return clone(state.values[key])
  const value = storage.getSync({ key })
  if (value != null) state.values[key] = clone(value)
  return value
}

export function writeStored(key, value) {
  const state = data()
  state.values[key] = clone(value)
  state.revisions[key] = (state.revisions[key] || 0) + 1
  const q = state.queues[key] ||= { busy: false, dirty: false, confirmed: 0, waiters: [] }
  q.dirty = true
  drain(key, state, q)
  return state.revisions[key]
}

/** 写盘成功（该版本或更晚版本）后 resolve(true)；失败/超时 resolve(false)。 */
export function writeStoredConfirmed(key, value) {
  const state = data()
  // writeStored 可能已经同步写完（storage.set 的成功回调是同步的）：先登记等待者，
  // 再补一次结算，否则这个 promise 永远不会 settle。
  const revision = writeStored(key, value)
  const q = state.queues[key]
  return new Promise(resolve => {
    q.waiters.push({ revision, resolve })
    if (revision <= q.confirmed) settle(q, true)
  })
}

function settle(q, ok) {
  const keep = []
  for (const w of q.waiters) {
    if (w.revision <= q.confirmed) w.resolve(true)
    else if (ok) keep.push(w)
    else w.resolve(false)
  }
  q.waiters = keep
}

function drain(key, state, q) {
  if (q.busy || !q.dirty) return
  q.busy = true; q.dirty = false
  const revision = state.revisions[key] || 0
  const value = clone(state.values[key])
  let settled = false, timer = null
  const done = ok => {
    if (settled) return
    settled = true
    cancel(timer)
    q.busy = false
    if (ok) {
      delete state.errors[key]
      q.confirmed = Math.max(q.confirmed || 0, revision)
      settle(q, true)
      drain(key, state, q)
    } else {
      q.dirty = true
      state.errors[key] = 'write_failed'
      settle(q, false)
    }
  }
  try {
    timer = later(() => done(false), WRITE_TIMEOUT_MS)
    storage.set({ key, value, success: () => done(true), fail: () => done(false) })
  } catch { done(false) }
}

export function retryStorage() {
  const state = data()
  for (const key of Object.keys(state.queues)) drain(key, state, state.queues[key])
}

export function storageStatus() {
  const state = data()
  return { failed: Object.keys(state.errors).length > 0, pending: Object.values(state.queues).some(q => q.busy || q.dirty) }
}
