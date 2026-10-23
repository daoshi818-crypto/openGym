import { runtime } from './runtime.js'
import { readStored, writeStored, retryStorage } from './persistence.js'
// 手表侧传输层：vivo 智能终端 SDK（穿戴业务 Kit）。
//
// 手机是唯一权威；手表只做辅助显示与记录。所有动作先进本地 outbox，
// 连接可用时按顺序发送，收到手机 ack 后清除。闪退重开后继续补发。
import interconnect from '@blueos.bluexlink.connectionManager'
import storage from '@blueos.storage.storage'
import { loadState, endSession, closeSession, save } from './session.js'
import { WATCH_VERSION } from './version.js'

const PHONE_PACKAGE = 'ch.duartesantos.opengym'
const PHONE_FINGERPRINT = '8bf64970048540fe913005d05becee1ecad819e7171518dabcd15817301a0149'
const K_OUTBOX = 'rpc_outbox'
const rpcState = () => runtime().rpc ||= { ...{"connect":null,"handlers":{},"connected":false,"outbox":[],"sending":false,"retryTimer":null,"lastEventAt":0,"initialized":false,"connectionGeneration":0,"sendingTimer":null,"writeBusy":false,"writeDirty":false,"persistFailed":false}, durable: new Set() }


function initialize() {
  if (rpcState().initialized) return
  rpcState().outbox = loadOutbox()
  rpcState().durable = new Set(rpcState().outbox.map(e => e.msg.eventId))
  rpcState().initialized = true
}
function persist() {
  rpcState().writeDirty = true
  if (rpcState().writeBusy) return
  rpcState().writeBusy = true; rpcState().writeDirty = false
  const value = JSON.parse(JSON.stringify(rpcState().outbox))
  try { storage.set({ key: K_OUTBOX, value,
    success: () => {
      rpcState().writeBusy = false; rpcState().persistFailed = false
      rpcState().durable = new Set(value.map(e => e.msg.eventId))
      if (rpcState().writeDirty) persist()
      else flush()
    },
    fail: () => { rpcState().writeBusy = false; rpcState().persistFailed = true; rpcState().writeDirty = true; if (rpcState().handlers.onError) rpcState().handlers.onError({ code: 'outbox_storage' }) }
  }) } catch { rpcState().writeBusy = false; rpcState().persistFailed = true; rpcState().writeDirty = true; rpcState().handlers.onError?.({ code: 'outbox_storage' }) }
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

function ackUpto(upto, eventId) {
  if (upto == null && !eventId) return
  initialize()
  const before = rpcState().outbox.length
  rpcState().outbox = rpcState().outbox.filter(e => eventId ? e.msg.eventId !== eventId : e.at > upto)
  if (rpcState().outbox.length !== before) persist()
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
      ackUpto(null, msg.eventId)
      storage.set({ key: 'last_notice', value: '手机训练结构已改变，一条离线操作未应用，请核对训练记录', fail() {} })
      if (rpcState().handlers.onError) rpcState().handlers.onError({ code: 'target_changed' })
      return
    }
    if (msg.t === 'ack') { ackUpto(msg.upto, msg.eventId); return }
    if (msg.t === 'plan_catalog') {
      storage.set({ key: 'plan_catalog', value: msg, fail() {} })
      if (rpcState().handlers.onCatalog) rpcState().handlers.onCatalog(msg)
      sendControl({ t: 'plan_catalog_ack', at: msg.at })
      return
    }
    if (msg.t === 'watch_start_ack') {
      const s = loadState()
      if (s.sid === msg.sid && msg.status === 'started') { s.pendingStart = false; save(s) }
      if (msg.status === 'started') ackUpto(msg.at, msg.eventId)
      if (rpcState().handlers.onStartAck) rpcState().handlers.onStartAck(msg)
      return
    }
    if (msg.t === 'session_close') {
      const s = loadState()
      if (s.sid === msg.sid && s.active) {
        if (msg.disposition === 'saved') endSession(s, s.profile, msg.closedAt)
        else closeSession(msg.sid)
        if (rpcState().handlers.onEnded) rpcState().handlers.onEnded(msg)
      } else {
        const closed = readStored('closed_sessions') || []
        writeStored('closed_sessions', [...closed.filter(id => id !== msg.sid), msg.sid].slice(-500))
      }
      sendControl({ t: 'session_close_ack', sid: msg.sid, eventId: msg.eventId })
      return
    }
    if (msg.t === 'ended') {
      const s = loadState()
      if (s.active && s.sid === msg.sid) {
        if (msg.reason === 'finished') {
          const summary = endSession(s, s.profile, msg.endedAt)
          sendEvent({ ...summary, t: 'summary', sets: summary.sets.length, at: Date.now() })
        } else closeSession(s.sid)
        if (rpcState().handlers.onEnded) rpcState().handlers.onEnded(msg)
      }
      sendControl({ t: 'ended_ack', sid: msg.sid, watchVersion: WATCH_VERSION })
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

/** 事件类：进 outbox，保证闪退/断线不丢。 */
export function sendEvent(obj) {
  if (!obj) return
  initialize()
  if (obj.at == null) obj.at = Date.now()
  if (!obj.eventId) {
    rpcState().lastEventAt = Math.max(Date.now(), rpcState().lastEventAt + 1, Number(storage.getSync({ key: 'event_clock' })) + 1 || 0)
    storage.set({ key: 'event_clock', value: rpcState().lastEventAt, fail() {} })
    if (obj.seq == null) obj.seq = rpcState().lastEventAt
    obj.source = 'watch'
    obj.eventId = 'watch:' + obj.sid + ':' + rpcState().lastEventAt
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
  if (s.active && s.sid === obj.sid && ['set', 'unset', 'weight', 'reps', 'add_set', 'remove_set'].includes(obj.t)) {
    s.pendingEdits = (s.pendingEdits || []).filter(e => !(e.t === obj.t && e.ex === obj.ex && e.set === obj.set && e.at === obj.at))
    s.pendingEdits.push(obj); save(s)
  }
  if (rpcState().outbox.some(e => e.msg.eventId === obj.eventId || e.msg.sid === obj.sid && e.msg.t === obj.t && e.msg.ex === obj.ex &&
      e.msg.set === obj.set && e.at === obj.at)) return
  rpcState().outbox.push({ at: obj.at, msg: obj, sent: false })
  persist()
  flush()
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
