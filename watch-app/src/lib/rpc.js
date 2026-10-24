import { runtime } from './runtime.js'
import { readStored, writeStored, retryStorage } from './persistence.js'
// 手表侧传输层：vivo 智能终端 SDK（穿戴业务 Kit）。
//
// 手机是唯一权威；手表只做辅助显示与记录。所有动作先进本地 outbox，
// 连接可用时按顺序发送，收到手机 ack 后清除。闪退重开后继续补发。
//
// 三条提交边界必须分清（这里是历史 bug 的来源）：
//  - 传输层 code:0 只代表收包；业务的“已保存”要等手机对同一 eventId 回 ack。
//  - session_close_ack 只代表关闭消息被处理，不代表本段热量已写进手机训练记录。
//  - 最终汇总先冻结进 close-journal（独立 key，可确认写盘），再入 outbox；重开手表时从
//    日志重建 outbox，而不是依赖打烊前是否调用过 sendEvent。
import interconnect from '@blueos.bluexlink.connectionManager'
import storage from '@blueos.storage.storage'
import { loadState, buildSessionSummary, summaryEventOf, closeSession, save } from './session.js'
import { allocateEventIdentity, rememberEventAt } from './event-id.js'
import { pendingSummaries, pendingEntry, journalEntry, prepareClose, releaseCandidate, markPhase, markEntry, markDelivered } from './close-journal.js'
import { WATCH_VERSION } from './version.js'

const PHONE_PACKAGE = 'ch.duartesantos.opengym'
const PHONE_FINGERPRINT = '8bf64970048540fe913005d05becee1ecad819e7171518dabcd15817301a0149'
const K_OUTBOX = 'rpc_outbox'
const WRITE_TIMEOUT_MS = 5000
const rpcState = () => runtime().rpc ||= { ...{"connect":null,"handlers":{},"connected":false,"outbox":[],"sending":false,"retryTimer":null,"lastEventAt":0,"initialized":false,"connectionGeneration":0,"sendingTimer":null,"writeBusy":false,"writeDirty":false,"persistFailed":false}, durable: new Set(), lifecycleQueue: null }


function initialize() {
  if (rpcState().initialized) return
  rpcState().outbox = loadOutbox()
  // 已冻结的最终汇总可能只存在日志里（关闭时 outbox 还没写成功）：先并进来。
  for (const entry of pendingSummaries()) enqueue(entry.summaryEvent, { persistOutbox: false })
  markDurable()
  rpcState().initialized = true
}

// 日志里的汇总也已经是可靠数据：把它连同 outbox 现有内容一起视为可发送。
function markDurable() {
  const ids = new Set(rpcState().outbox.map(e => e.msg.eventId))
  for (const entry of pendingSummaries()) if (entry.summaryEvent?.eventId) ids.add(entry.summaryEvent.eventId)
  rpcState().durable = ids
}

function enqueue(msg, { persistOutbox = true } = {}) {
  if (!msg || !msg.eventId) return false
  if (rpcState().outbox.some(e => e.msg.eventId === msg.eventId)) return true
  if (rpcState().outbox.some(e => e.msg.sid === msg.sid && e.msg.t === msg.t && e.msg.set === msg.set && e.at === msg.at)) return true
  rpcState().outbox.push({ at: msg.at || Date.now(), msg, sent: false })
  if (persistOutbox) persist()
  return true
}

function persist() {
  const r = rpcState()
  r.writeDirty = true
  if (r.writeBusy) return
  r.writeBusy = true; r.writeDirty = false
  const value = JSON.parse(JSON.stringify(r.outbox))
  let settled = false, timer = null
  const done = ok => {
    if (settled) return
    settled = true
    try { if (timer != null) clearTimeout(timer) } catch { /* 无定时器 */ }
    r.writeBusy = false
    if (ok) {
      r.persistFailed = false
      markDurable()
      if (r.writeDirty) persist()
      else flush()
    } else {
      r.persistFailed = true; r.writeDirty = true
      r.handlers.onError?.({ code: 'outbox_storage' })
    }
  }
  try {
    // 回调丢失不能把写链永久卡死：超时按失败处理，flush() 的定时器会重试。
    timer = setTimeout(() => done(false), WRITE_TIMEOUT_MS)
    storage.set({ key: K_OUTBOX, value,
      success: () => done(true),
      fail: () => done(false),
    })
  } catch { done(false) }
}

function loadOutbox() {
  try {
    const list = storage.getSync({ key: K_OUTBOX })
    return Array.isArray(list) ? list : []
  } catch (e) { return [] }
}

function parseMessage(data) {
  const diagnostics = { decodePath: 'event', layers: [] }
  const fail = reason => ({ message: null, ...diagnostics, reason })
  let value = data
  // SDK 回调的 data 与手机示例的 msg 都是传输包裹。只拆这些已知字段，
  // 不递归搜索训练内容；遇到业务 t 就停止，保留业务自己的 data/msg。
  for (let depth = 0; depth < 8; depth++) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const layer = { type }
    if (value && type === 'object') {
      layer.keys = Object.keys(value).slice(0, 8).map(k => k.slice(0, 40))
      layer.objectType = Object.prototype.toString.call(value).slice(0, 48)
    }
    if (type === 'string' || type === 'array') layer.length = value.length
    diagnostics.layers.push(layer)
    if (type === 'string') {
      // 不记录原文或 JSON.parse 的异常文本，避免把训练内容带入诊断。
      if (value.length > 131072) return fail('message_too_large')
      try { value = JSON.parse(value.replace(/^\uFEFF/, '').trim()) }
      catch (e) { return fail('invalid_json') }
      diagnostics.decodePath += '.json'
      continue
    }
    if (!value || type !== 'object') return fail('unsupported_value')
    if (value.isFileType) return { message: { ...value, t: 'file' }, ...diagnostics }
    if (typeof value.t === 'string' && value.t) return { message: value, ...diagnostics }
    if (value.t != null) return fail('invalid_type')
    // 二进制格式尚未获真机证实，先明确报告，避免错误地当作普通对象。
    if (typeof value.byteLength === 'number') return fail('unsupported_binary')
    const key = value.data != null ? 'data' : value.msg != null ? 'msg' : ''
    if (!key) return fail('missing_type')
    value = value[key]
    diagnostics.decodePath += '.' + key
  }
  return fail('envelope_depth_limit')
}

function sendHello() {
  const s = loadState()
  sendControl({
    t: 'hello',
    watchVersion: WATCH_VERSION, protocolVersion: 2, stableIds: true,
    receipts: true,
    sid: s.sid || '',
    rev: s.rev || 0,
    pending: rpcState().outbox.length,
    active: !!s.active,
    pendingStart: !!s.pendingStart,
  })
}

function flush() {
  initialize()
  const expired = runtime().expiredEvents || []
  if (expired.length) { runtime().expiredEvents = []; for (const event of expired) sendEvent(event) }
  retryStorage()
  if (rpcState().persistFailed && !rpcState().writeBusy) persist()
  if (!rpcState().connected || !rpcState().connect || rpcState().sending) return
  const next = rpcState().outbox.find(e => rpcState().durable.has(e.msg.eventId) && (!e.sent || Date.now() - (e.sentAt || 0) > 4000))
  if (!next) return
  const token = { generation: rpcState().connectionGeneration, eventId: next.msg.eventId }
  rpcState().sending = token
  const release = () => { if (rpcState().sending !== token || token.generation !== rpcState().connectionGeneration) return false; clearTimeout(rpcState().sendingTimer); rpcState().sending = false; return true }
  rpcState().sendingTimer = setTimeout(() => { if (release()) flush() }, 6000)
  try {
    rpcState().connect.send({ data: next.msg,
      success: () => { if (!release()) return; const item = rpcState().outbox.find(e => e.msg.eventId === token.eventId); if (item) { item.sent = true; item.sentAt = Date.now() }; flush() },
      fail: () => { if (release() && rpcState().connected) setTimeout(flush, 2000) }
    })
  } catch { release() }
}

// 精确回执：eventId 匹配时只删那一条。日志里的最终汇总要先持久化 delivered，
// 再清 outbox；顺序反了，重启会从日志重建一条已确认的消息。
function ackEvent(upto, eventId) {
  if (upto == null && !eventId) return
  initialize()
  const before = rpcState().outbox.length
  if (eventId) {
    const entry = summaryForEvent(eventId)
    if (entry) {
      const drop = () => {
        rpcState().outbox = rpcState().outbox.filter(e => e.msg.eventId !== eventId)
        if (rpcState().outbox.length !== before) persist()
      }
      const p = markDelivered(entry.sid)
      if (p && typeof p.then === 'function') p.then(ok => { if (ok) drop() }, () => {})
      else drop()
      return
    }
    rpcState().outbox = rpcState().outbox.filter(e => e.msg.eventId !== eventId)
  } else {
    // 旧式时间戳回执：只清理普通事件；最终汇总必须精确确认，否则“较晚的 focus 时间戳”
    // 会把还没保存成功的汇总一起删掉。
    rpcState().outbox = rpcState().outbox.filter(e => e.at > upto || e.msg.t === 'summary')
  }
  if (rpcState().outbox.length !== before) persist()
}

function summaryForEvent(eventId) {
  for (const entry of pendingSummaries()) if (entry.summaryEvent && entry.summaryEvent.eventId === eventId) return entry
  return null
}

// 关闭/结束两类消息串行消费：乱序或重复到达时只会得到同一条冻结汇总，也不会并发建两份日志。
function serial(task) {
  const prev = rpcState().lifecycleQueue || Promise.resolve()
  const next = prev.then(() => { try { return task() } catch (e) { return null } }).catch(() => null)
  rpcState().lifecycleQueue = next
  return next
}

function summaryEventFor(state, endedAt) {
  const session = buildSessionSummary(state, state.profile, endedAt)
  const identity = allocateEventIdentity(state.sid)
  rememberEventAt(identity.seq)
  return { session, event: summaryEventOf(session, identity, state, true) }
}

/**
 * 手机说“这场训练已经结束了（saved）”。顺序固定为：
 *   冻结日志（原始状态还在）→ 入 outbox → 标记 closed → 清会话 → 回 session_close_ack。
 * 任一步失败都保留原始数据，重开手表时从日志继续，不需要用户重新开始或再次保存。
 */
async function handleSavedClose(msg) {
  const s = loadState()
  let entry = pendingEntry(msg.sid) || (journalEntry(msg.sid)?.delivery === 'candidate' ? await releaseCandidate(msg.sid) : null)
  if (!entry && s.active && s.sid === msg.sid) {
    const { session, event } = summaryEventFor(s, msg.closedAt)
    entry = await prepareClose({ ...msg, sid: msg.sid, disposition: 'saved' }, event)
    rememberEventAt(event.seq)
    if (!entry) {
      // 日志没写成功：保留会话与热量，下一次 hello/session_close 再试。
      rpcState().handlers.onError?.({ code: 'close_journal_storage', sid: msg.sid })
      return { entry: null, session, error: 'journal_storage' }
    }
  }
  if (entry) {
    enqueue(entry.summaryEvent)
    await markPhase(msg.sid, 'closed')
    if (s.active && s.sid === msg.sid) closeSession(msg.sid)
    rpcState().handlers.onEnded?.(msg)
    flush()
  } else if (!s.active || s.sid !== msg.sid) {
    const closed = readStored('closed_sessions') || []
    writeStored('closed_sessions', [...closed.filter(id => id !== msg.sid), msg.sid].slice(-500))
  }
  return { entry }
}

/** 旧式 ended。active 时冻结并发送；已 inactive 时仍要检查按 sid 保存的待传汇总并重发。 */
async function handleEnded(msg) {
  const s = loadState()
  let entry = pendingEntry(msg.sid) || (journalEntry(msg.sid)?.delivery === 'candidate' ? await releaseCandidate(msg.sid) : null)
  if (!entry && msg.reason === 'finished' && s.active && s.sid === msg.sid) {
    const { event } = summaryEventFor(s, msg.endedAt)
    entry = await prepareClose({ sid: msg.sid, disposition: 'saved', closedAt: msg.endedAt, eventId: msg.eventId }, event)
    if (!entry) return { entry: null, error: 'journal_storage' }
  }
  if (entry) {
    enqueue(entry.summaryEvent)
    await markPhase(msg.sid, 'closed')
    if (s.active && s.sid === msg.sid) closeSession(msg.sid)
    rpcState().handlers.onEnded?.(msg)
    flush()
  } else if (msg.reason !== 'finished' && s.active && s.sid === msg.sid) {
    closeSession(s.sid)
    rpcState().handlers.onEnded?.(msg)
  }
  return { entry }
}

export function startServer(h) {
  if (h) rpcState().handlers = h
  if (!rpcState().retryTimer) rpcState().retryTimer = setInterval(flush, 4000)
  if (!rpcState().connect) {
    initialize()
    try {
      rpcState().connect = interconnect.instance({ package: PHONE_PACKAGE, fingerprint: PHONE_FINGERPRINT })
    } catch (e) {
      rpcState().connect = null
      if (rpcState().handlers.onError) rpcState().handlers.onError({ code: 1000, data: String(e) })
      return
    }
  }

  // 页面模块共享 application runtime；当前页面只接管 UI 回调。
  rpcState().connect.onOpen = () => {
    rpcState().connected = true
    rpcState().connectionGeneration++; rpcState().sending = false; clearTimeout(rpcState().sendingTimer)
    initialize()
    rpcState().outbox.forEach(e => { e.sent = false })
    persist()
    if (rpcState().handlers.onState) rpcState().handlers.onState(true)
    flush()
    sendHello()
  }
  rpcState().connect.onClose = () => {
    rpcState().connected = false
    rpcState().connectionGeneration++; rpcState().sending = false; clearTimeout(rpcState().sendingTimer)
    if (rpcState().handlers.onState) rpcState().handlers.onState(false)
  }
  rpcState().connect.onError = (err) => {
    rpcState().connected = false
    if (rpcState().handlers.onState) rpcState().handlers.onState(false)
    if (rpcState().handlers.onError) rpcState().handlers.onError(err || {})
  }
  rpcState().connect.onMessage = (data) => {
    const decoded = parseMessage(data)
    const msg = decoded.message
    if (!msg) {
      sendControl({ t: 'watch_rx', watchVersion: WATCH_VERSION, status: 'invalid_message',
        envelopeType: typeof data, keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 8) : [],
        reason: decoded.reason, decodePath: decoded.decodePath, layers: decoded.layers })
      return
    }
    if (msg.t === 'event_rejected') {
      const state = loadState(); state.pendingEdits = (state.pendingEdits || []).filter(e => e.eventId !== msg.eventId); save(state)
      ackEvent(null, msg.eventId)
      storage.set({ key: 'last_notice', value: '手机训练结构已改变，一条离线操作未应用，请核对训练记录', fail() {} })
      if (rpcState().handlers.onError) rpcState().handlers.onError({ code: 'target_changed' })
      return
    }
    if (msg.t === 'ack') { ackEvent(msg.upto, msg.eventId); return }
    if (msg.t === 'plan_catalog') {
      storage.set({ key: 'plan_catalog', value: msg, fail() {} })
      if (rpcState().handlers.onCatalog) rpcState().handlers.onCatalog(msg)
      sendControl({ t: 'plan_catalog_ack', at: msg.at })
      return
    }
    if (msg.t === 'watch_start_ack') {
      const s = loadState()
      if (s.sid === msg.sid && msg.status === 'started') { s.pendingStart = false; save(s) }
      if (msg.status === 'started') ackEvent(msg.at, msg.eventId)
      if (rpcState().handlers.onStartAck) rpcState().handlers.onStartAck(msg)
      return
    }
    if (msg.t === 'session_close') {
      // 关闭与汇总分成两个状态机：这里只保证“已冻结并尝试入队”，回执不代表热量到了手机。
      serial(async () => {
        try {
          if (msg.disposition === 'saved') await handleSavedClose(msg)
          else {
            const s = loadState()
            if (s.active && s.sid === msg.sid) { closeSession(msg.sid); rpcState().handlers.onEnded?.(msg) }
            // 手机明确放弃/丢弃：候选也要一起作废，否则它会永远等一个不会到来的裁决。
            const entry = journalEntry(msg.sid)
            if (entry && entry.delivery !== 'delivered') {
              Promise.resolve(markEntry(msg.sid, { delivery: 'discarded', phase: 'discarded' })).catch(() => {})
            }
          }
        } finally {
          sendControl({ t: 'session_close_ack', sid: msg.sid, eventId: msg.eventId })
        }
      })
      return
    }
    if (msg.t === 'ended') {
      serial(async () => {
        try { await handleEnded(msg) } finally {
          sendControl({ t: 'ended_ack', sid: msg.sid, watchVersion: WATCH_VERSION })
        }
      })
      return
    }
    if (msg.t === 'plan' || msg.t === 'sync') {
      const active = loadState()
      if (active.active && active.sid !== msg.sid) {
        sendControl({ t: msg.t + '_ack', sid: msg.sid, status: 'conflict', activeSid: active.sid })
        return
      }
      const closed = readStored('closed_sessions') || []
      if (closed.indexOf(msg.sid) >= 0) {
        sendControl({ t: msg.t + '_ack', sid: msg.sid, planId: msg.planId || '', status: 'closed', watchVersion: WATCH_VERSION })
        return
      }
      const handler = msg.t === 'plan' ? rpcState().handlers.onPlan : rpcState().handlers.onSync
      let result = { status: 'no_handler' }
      try {
        if (handler) result = handler(msg) || { status: 'handled' }
      } catch (e) {
        result = { status: 'error', error: String(e && e.message || e).slice(0, 160) }
      }
      // code=0 仅代表手机 RPC 成功；此回执在页面实际处理后发出。
      sendControl({ ...result, t: msg.t + '_ack', watchVersion: WATCH_VERSION,
        sid: msg.sid || '', planId: msg.planId || '', rev: msg.rev || 0,
        decodePath: decoded.decodePath })
      return
    }
    if (msg.t === 'rest' && rpcState().handlers.onRest) { rpcState().handlers.onRest(msg); return }
    if (msg.t === 'pause' && rpcState().handlers.onPause) { rpcState().handlers.onPause(msg); return }
    if (msg.t === 'set' && rpcState().handlers.onSet) { rpcState().handlers.onSet(msg); return }
    if (msg.t === 'unset' && rpcState().handlers.onUnset) { rpcState().handlers.onUnset(msg); return }
    if (msg.t === 'effort_ack') {
      // 手机拒绝了这次评分（并发修改）：把手机现值当作权威，提示用户重新登记，
      // 并清掉这条待确认事件，避免反复重放覆盖。
      ackEvent(null, msg.eventId)
      storage.set({ key: 'last_notice', value: '手机已修改本组强度，请重新登记', fail() {} })
      rpcState().handlers.onError?.({ code: 'effort_conflict', sid: msg.sid })
      return
    }
    if (msg.t === 'effort' && rpcState().handlers.onEffort) { rpcState().handlers.onEffort(msg); return }
    if (msg.t === 'weight' && rpcState().handlers.onWeight) { rpcState().handlers.onWeight(msg); return }
    if (msg.t === 'reps' && rpcState().handlers.onReps) { rpcState().handlers.onReps(msg); return }
    if (msg.t === 'add_set' && rpcState().handlers.onAddSet) { rpcState().handlers.onAddSet(msg); return }
    if (msg.t === 'remove_set' && rpcState().handlers.onRemoveSet) { rpcState().handlers.onRemoveSet(msg); return }
    if (msg.t === 'focus' && rpcState().handlers.onFocus) { rpcState().handlers.onFocus(msg); return }
    if (msg.t === 'ended' && rpcState().handlers.onEnded) { rpcState().handlers.onEnded(msg); return }
    if (msg.t === 'file' && rpcState().handlers.onFile) { rpcState().handlers.onFile(msg); return }
    sendControl({ t: 'watch_rx', watchVersion: WATCH_VERSION, status: 'unhandled_type', messageType: msg.t })
  }
  // 不同固件文档里大小写不一致，两种都挂上。
  rpcState().connect.onopen = rpcState().connect.onOpen
  rpcState().connect.onclose = rpcState().connect.onClose
  rpcState().connect.onerror = rpcState().connect.onError
  rpcState().connect.onmessage = rpcState().connect.onMessage

  try {
    rpcState().connect.getReadyState({
      success: (data) => {
        rpcState().connected = !!(data && data.status === 1)
        if (rpcState().handlers.onState) rpcState().handlers.onState(rpcState().connected)
        if (rpcState().connected) { sendHello(); flush() }
      },
      fail: () => {},
    })
  } catch (e) { /* 旧固件没有 getReadyState 时等 onOpen */ }
}

export function stopServer() {
  if (rpcState().retryTimer) clearInterval(rpcState().retryTimer)
  rpcState().retryTimer = null
  try { if (rpcState().connect) rpcState().connect.close({ success() {}, fail() {} }) } catch (e) { /* 已关闭 */ }
  rpcState().connect = null
  rpcState().connected = false
  rpcState().connectionGeneration++; rpcState().sending = false; clearTimeout(rpcState().sendingTimer)
}

/** 事件类：进 outbox，保证闪退/断线不丢。返回是否已在队列里（不代表手机已保存）。 */
export function sendEvent(obj) {
  if (!obj) return false
  initialize()
  if (obj.at == null) obj.at = Date.now()
  if (!obj.eventId) {
    const identity = allocateEventIdentity(obj.sid)
    rpcState().lastEventAt = identity.seq
    if (obj.seq == null) obj.seq = identity.seq
    obj.source = 'watch'
    obj.eventId = identity.eventId
  } else {
    rememberEventAt(Number(obj.seq || obj.at) || 0)
  }
  const s = loadState()
  if (s.active && s.sid === obj.sid && Number.isInteger(obj.ex)) {
    const exercise = s.workout?.exercises?.[obj.ex], row = s.workout?.rows?.[obj.ex]?.[obj.set - 1]
    obj.protocolVersion = s.protocolVersion || 1
    obj.entryInstanceId ||= exercise?.entryInstanceId
    obj.setId ||= row?.setId
    obj.structureRevision ||= s.structureRevision
    obj.weightUnit ||= s.weightUnit || 'kg'
    if (obj.t === 'add_set') obj.newSetIds = (s.workout.rows[obj.ex] || []).map(r => r.setId)
  }
  if (s.active && s.sid === obj.sid && ['set', 'unset', 'weight', 'reps', 'add_set', 'remove_set', 'effort'].includes(obj.t)) {
    s.pendingEdits = (s.pendingEdits || []).filter(e => !(e.t === obj.t && e.ex === obj.ex && e.set === obj.set && e.at === obj.at))
    s.pendingEdits.push(obj); save(s)
  }
  const queued = enqueue(obj)
  if (queued) {
    // 手表自己保存结束时，也把本段汇总冻结进关闭日志：关闭消息丢了、手机没回执、
    // 或应用在回执前被关闭，重开时从日志重建，而不是只剩一条 summary_last。
    freezeOwnClose(obj)
    flush()
  }
  return queued
}

function freezeOwnClose(obj) {
  if (obj.t !== 'session_close' || obj.disposition !== 'saved' || !obj.summary || !obj.sid) return
  const event = {
    t: 'summary', sid: obj.sid, eventId: obj.eventId + ':summary', seq: (Number(obj.at) || Date.now()) + 1,
    at: obj.at || Date.now(), endedAt: obj.closedAt, calories: obj.summary.calories,
    avgHr: obj.summary.avgHr, maxHr: obj.summary.maxHr, minutes: obj.summary.minutes, volume: obj.summary.volume,
    weightUnit: obj.weightUnit, algorithmVersion: 1, sets: (obj.completedSets || []).length,
    source: 'watch', final: true,
  }
  Promise.resolve(prepareClose({ sid: obj.sid, disposition: 'saved', closedAt: obj.closedAt, eventId: obj.eventId }, event))
    .then(entry => { if (!entry) rpcState().handlers.onError?.({ code: 'close_journal_storage', sid: obj.sid }) }, () => {})
}

/** 控制类：尽力而为，不进 outbox（休息倒计时等旧消息重连后回放反而错）。 */
export function sendControl(obj) {
  if (!rpcState().connected || !rpcState().connect || !obj) return
  try {
    rpcState().connect.send({ data: obj, success() {}, fail() {} })
  } catch (e) { /* 下次再同步 */ }
}

export function pendingCount() { initialize(); return rpcState().outbox.length }
export function persistenceStatus() { return { pending: rpcState().writeBusy || rpcState().writeDirty, failed: rpcState().persistFailed } }
export function isConnected() { return rpcState().connected }
