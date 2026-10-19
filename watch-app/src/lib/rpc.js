// 手表侧传输层：vivo 智能终端 SDK（穿戴业务 Kit）。
//
// 手机是唯一权威；手表只做辅助显示与记录。所有动作先进本地 outbox，
// 连接可用时按顺序发送，收到手机 ack 后清除。闪退重开后继续补发。
import interconnect from '@blueos.bluexlink.connectionManager'
import storage from '@blueos.storage.storage'
import { loadState } from './session.js'
import { WATCH_VERSION } from './version.js'

const PHONE_PACKAGE = 'ch.duartesantos.opengym'
const PHONE_FINGERPRINT = '8bf64970048540fe913005d05becee1ecad819e7171518dabcd15817301a0149'
const K_OUTBOX = 'rpc_outbox'

let connect = null
let handlers = {}
let connected = false
let outbox = []
let sending = false

function persist() {
  storage.set({ key: K_OUTBOX, value: outbox, fail: (d, c) => console.log('rpc outbox save failed', c) })
}

function loadOutbox() {
  try {
    const list = storage.getSync({ key: K_OUTBOX })
    return Array.isArray(list) ? list.map(e => ({ ...e, sent: !!e.sent })) : []
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
    watchVersion: WATCH_VERSION,
    receipts: true,
    sid: s.sid || '',
    rev: s.rev || 0,
    pending: outbox.length,
    active: !!s.active,
  })
}

function flush() {
  if (!connected || !connect || sending) return
  const next = outbox.find(e => !e.sent)
  if (!next) return
  sending = true
  try {
    connect.send({
      data: next.msg,
      success: () => {
        next.sent = true
        sending = false
        persist()
        flush()
      },
      fail: () => {
        sending = false
        // 连接还在就稍后再试；真正断开时等 onOpen 再 flush。
        if (connected) setTimeout(flush, 2000)
      },
    })
  } catch (e) {
    sending = false
  }
}

function ackUpto(upto) {
  if (upto == null) return
  const before = outbox.length
  outbox = outbox.filter(e => e.at > upto)
  if (outbox.length !== before) persist()
}

export function startServer(h) {
  if (h) handlers = h
  if (!connect) {
    outbox = loadOutbox()
    try {
      connect = interconnect.instance({ package: PHONE_PACKAGE, fingerprint: PHONE_FINGERPRINT })
    } catch (e) {
      connect = null
      if (handlers.onError) handlers.onError({ code: 1000, data: String(e) })
      return
    }
  }

  // 页面包可能各有一份模块，但复用同一个 SDK 实例。每次显示都重新接管回调。
  connect.onOpen = () => {
    connected = true
    if (handlers.onState) handlers.onState(true)
    sendHello()
    flush()
  }
  connect.onClose = () => {
    connected = false
    if (handlers.onState) handlers.onState(false)
  }
  connect.onError = (err) => {
    connected = false
    if (handlers.onState) handlers.onState(false)
    if (handlers.onError) handlers.onError(err || {})
  }
  connect.onMessage = (data) => {
    const decoded = parseMessage(data)
    const msg = decoded.message
    if (!msg) {
      sendControl({ t: 'watch_rx', watchVersion: WATCH_VERSION, status: 'invalid_message',
        envelopeType: typeof data, keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 8) : [],
        reason: decoded.reason, decodePath: decoded.decodePath, layers: decoded.layers })
      return
    }
    if (msg.t === 'ack') { ackUpto(msg.upto); return }
    if (msg.t === 'plan' || msg.t === 'sync') {
      const handler = msg.t === 'plan' ? handlers.onPlan : handlers.onSync
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
    if (msg.t === 'rest' && handlers.onRest) { handlers.onRest(msg); return }
    if (msg.t === 'unset' && handlers.onUnset) { handlers.onUnset(msg); return }
    if (msg.t === 'weight' && handlers.onWeight) { handlers.onWeight(msg); return }
    if (msg.t === 'reps' && handlers.onReps) { handlers.onReps(msg); return }
    if (msg.t === 'add_set' && handlers.onAddSet) { handlers.onAddSet(msg); return }
    if (msg.t === 'remove_set' && handlers.onRemoveSet) { handlers.onRemoveSet(msg); return }
    if (msg.t === 'focus' && handlers.onFocus) { handlers.onFocus(msg); return }
    if (msg.t === 'ended' && handlers.onEnded) { handlers.onEnded(msg); return }
    if (msg.t === 'file' && handlers.onFile) { handlers.onFile(msg); return }
    sendControl({ t: 'watch_rx', watchVersion: WATCH_VERSION, status: 'unhandled_type', messageType: msg.t })
  }
  // 不同固件文档里大小写不一致，两种都挂上。
  connect.onopen = connect.onOpen
  connect.onclose = connect.onClose
  connect.onerror = connect.onError
  connect.onmessage = connect.onMessage

  try {
    connect.getReadyState({
      success: (data) => {
        connected = !!(data && data.status === 1)
        if (handlers.onState) handlers.onState(connected)
        if (connected) { sendHello(); flush() }
      },
      fail: () => {},
    })
  } catch (e) { /* 旧固件没有 getReadyState 时等 onOpen */ }
}

export function stopServer() {
  try { if (connect) connect.close({ success() {}, fail() {} }) } catch (e) { /* 已关闭 */ }
  connect = null
  connected = false
  sending = false
}

/** 事件类：进 outbox，保证闪退/断线不丢。 */
export function sendEvent(obj) {
  if (!obj) return
  if (obj.at == null) obj.at = Date.now()
  outbox.push({ at: obj.at, msg: obj, sent: false })
  persist()
  flush()
}

/** 控制类：尽力而为，不进 outbox（休息倒计时等旧消息重连后回放反而错）。 */
export function sendControl(obj) {
  if (!connected || !connect || !obj) return
  try {
    connect.send({ data: obj, success() {}, fail() {} })
  } catch (e) { /* 下次再同步 */ }
}

export function pendingCount() { return outbox.length }
export function isConnected() { return connected }
