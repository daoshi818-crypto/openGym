// 手表侧传输层：vivo 智能终端 SDK（穿戴业务 Kit）。
//
// 手机是唯一权威；手表只做辅助显示与记录。所有动作先进本地 outbox，
// 连接可用时按顺序发送，收到手机 ack 后清除。闪退重开后继续补发。
import interconnect from '@blueos.bluexlink.connectionManager'
import storage from '@blueos.storage.storage'
import { loadState } from './session.js'

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
  if (!data) return null
  if (data.isFileType) return { t: 'file', ...data }
  let value = data.data != null ? data.data : data
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch (e) { return null }
  }
  return value && typeof value === 'object' ? value : null
}

function sendHello() {
  const s = loadState()
  sendControl({
    t: 'hello',
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
  if (connect) {
    // 页面重复调用时只更新 handlers，不重复建实例。
    if (connected && handlers.onState) handlers.onState(true)
    return
  }
  outbox = loadOutbox()
  try {
    connect = interconnect.instance({ package: PHONE_PACKAGE, fingerprint: PHONE_FINGERPRINT })
  } catch (e) {
    connect = null
    if (handlers.onError) handlers.onError({ code: 1000, data: String(e) })
    return
  }

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
    const msg = parseMessage(data)
    if (!msg) return
    if (msg.t === 'ack') { ackUpto(msg.upto); return }
    if (msg.t === 'plan' && handlers.onPlan) { handlers.onPlan(msg); return }
    if (msg.t === 'sync' && handlers.onSync) { handlers.onSync(msg); return }
    if (msg.t === 'rest' && handlers.onRest) { handlers.onRest(msg); return }
    if (msg.t === 'unset' && handlers.onUnset) { handlers.onUnset(msg); return }
    if (msg.t === 'weight' && handlers.onWeight) { handlers.onWeight(msg); return }
    if (msg.t === 'reps' && handlers.onReps) { handlers.onReps(msg); return }
    if (msg.t === 'add_set' && handlers.onAddSet) { handlers.onAddSet(msg); return }
    if (msg.t === 'remove_set' && handlers.onRemoveSet) { handlers.onRemoveSet(msg); return }
    if (msg.t === 'focus' && handlers.onFocus) { handlers.onFocus(msg); return }
    if (msg.t === 'ended' && handlers.onEnded) { handlers.onEnded(msg); return }
    if (msg.t === 'file' && handlers.onFile) { handlers.onFile(msg); return }
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
