// BLE（GATT 服务端）：手表做外围设备广播，手机做中心设备连上来。
// 手机把今天的训练计划写进"计划"特征值；手表每完成一组 / 结束训练，
// 通过"完成"特征值 notify 回传。协议见 ../DESIGN.md 第 4 节。
//
// 两条铁律：
// 1. 手表从不假设手机在线 —— 所有外发事件先进本地待发队列（落盘），
//    连接可用时发出，收到手机 ack（upto 时间戳）后才清除；
// 2. BLE 单包可能只有 20 字节 —— 收发都按字节流处理，一条 UTF-8 JSON
//    以 \n 结尾，写入可能被 MTU 切成多包，必须重组（最容易踩的坑）。
import bluetooth from '@blueos.bluetooth.ble'
import storage from '@blueos.storage.storage'

// 自定义 UUID（避开 SIG 保留段），与 DESIGN.md 约定一致
const SVC = '0000a100-0000-1000-8000-00805f9b34fb' // 主服务
const C_PLAN = '0000a101-0000-1000-8000-00805f9b34fb' // 手机 → 手表：今天的计划（write）
const C_EVENT = '0000a102-0000-1000-8000-00805f9b34fb' // 手表 → 手机：完成一组/结束（notify）
const C_STATUS = '0000a103-0000-1000-8000-00805f9b34fb' // 双向：握手/ack（read + write）
const CCCD = '00002902-0000-1000-8000-00805f9b34fb' // notify 特征值的客户端配置描述符

const K_OUTBOX = 'ble_outbox'
const CHUNK = 20 // 保守单包大小（默认 MTU 23 − 3 字节 ATT 头）
const STATE_CONNECTED = 2

let server = null
let handlers = {}
let deviceId = null
let connected = false
let outbox = [] // [{ at, json }]，按发生时间排序
let rxbuf = {} // characteristicUuid → 尚未拼完的字节（number 数组）

// ---- UTF-8 手工编解码：蓝河运行时不保证有 TextEncoder/TextDecoder ----
function utf8Encode(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    const c = str.codePointAt(i)
    if (c > 0xffff) i++ // 代理对整体跳过
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

function utf8Decode(bytes) {
  let s = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    let c
    if (b < 0x80) { c = b; i += 1 } else if (b < 0xe0) { c = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2 } else if (b < 0xf0) { c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3 } else { c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); i += 4 }
    s += String.fromCodePoint(c)
  }
  return s
}

// 启动 GATT 服务端并开始广播。幂等：Index / Workout 页都会调，只有第一次生效。
// handlers: { onPlan(msg), onState(connected) }
export function startServer(h) {
  if (h) handlers = h
  if (server) return
  outbox = loadOutbox()
  try {
    server = bluetooth.BLE.createGattServer()

    // 连接状态：连上后立刻把积压的事件补发出去
    server.subscribeConnectStateChange({
      callback: (data) => {
        if (data.state === STATE_CONNECTED) {
          deviceId = data.deviceId
          connected = true
          flush()
        } else {
          connected = false
          deviceId = null
          outbox.forEach((entry) => { entry.sent = false })
          persistOutbox()
        }
        if (handlers.onState) handlers.onState(connected)
      },
      fail: (msg, code) => console.log('ble conn sub failed', msg, code),
    })

    // 写请求：计划/状态消息都走这里，按 \n 重组出完整 JSON
    server.subscribeCharacteristicWrite({
      callback: (data) => {
        respond(data, data.value)
        if (data.isPrep) return // 可靠写（prepared write）不处理，直接回成功
        feed(data.characteristicUuid, new Uint8Array(data.value), (line) => onLine(line, data.characteristicUuid))
      },
      fail: (msg, code) => console.log('ble write sub failed', msg, code),
    })

    // 读请求：手机握手时读"状态"特征值，报告积压条数
    server.subscribeCharacteristicRead({
      callback: (data) => {
        const hello = utf8Encode(JSON.stringify({ t: 'hello', v: 1, pending: outbox.length }))
        respond(data, hello.buffer)
      },
      fail: (msg, code) => console.log('ble read sub failed', msg, code),
    })

    // 先有服务，再开广播（顺序不能反）
    const ok = server.addService({
      serviceUuid: SVC,
      isPrimary: true,
      characteristics: [
        // write(5) + write-no-response(7)，手机写计划用
        { serviceUuid: SVC, characteristicUuid: C_PLAN, characteristicValue: new ArrayBuffer(0), descriptors: [], properties: [5, 7] },
        // notify(3)，必须带 CCCD 描述符，Android 侧才能订阅通知
        { serviceUuid: SVC, characteristicUuid: C_EVENT, characteristicValue: new ArrayBuffer(0), descriptors: [cccd(C_EVENT)], properties: [3] },
        // read(4) + write(5)，握手与 ack
        { serviceUuid: SVC, characteristicUuid: C_STATUS, characteristicValue: new ArrayBuffer(0), descriptors: [], properties: [4, 5] },
      ],
      includeServices: [],
    })
    if (!ok) {
      console.log('ble addService failed')
      server = null
      return
    }

    // interval 150 slot ≈ 94ms；txPower 文档范围是 -127~1（DESIGN 草稿里的 60 超范围，不能用）
    server.startAdvertising({ interval: 150, connectable: true }, { serviceUuids: [SVC] })
  } catch (e) {
    console.log('ble start failed', e)
    server = null
  }
}

export function stopServer() {
  try {
    if (server) {
      server.stopAdvertising()
      server.close()
    }
  } catch (e) { /* 已关闭时忽略 */ }
  server = null
  connected = false
  deviceId = null
}

// 回传一条事件（完成一组 / 结束训练）。失败不丢：留在待发队列，
// 重连后 flush() 补发；手机按 sid+ex+set 幂等去重。
export function sendEvent(obj) {
  if (!obj.at) obj.at = Date.now()
  outbox.push({ at: obj.at, json: JSON.stringify(obj), sent: false })
  persistOutbox()
  flush()
}

// 控制类消息（手表本地调整休息 {t:'rest', leftSec}）：尽力而为，发不出去就算了——
// 不进待发队列，否则积压的旧倒计时重连后回放反而错。
export function sendControl(obj) {
  if (!connected || !deviceId || !server) return
  try {
    const bytes = utf8Encode(JSON.stringify(obj) + '\n')
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const slice = bytes.subarray(off, Math.min(off + CHUNK, bytes.length))
      server.notifyCharacteristicChanged(deviceId, {
        serviceUuid: SVC,
        characteristicUuid: C_EVENT,
        characteristicValue: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
        confirm: false,
      })
    }
  } catch (e) { /* 下次调整再同步 */ }
}

export function pendingCount() {
  return outbox.length
}

export function isConnected() {
  return connected
}

// 把待发队列尽量清空。第一条发不出去就停（连接有问题），下次再试。
export function flush() {
  if (!connected || !deviceId || !server) return
  let changed = false
  for (const entry of outbox) {
    if (entry.sent) continue
    if (!notifyOne(entry.json)) break
    entry.sent = true
    changed = true
  }
  if (changed) persistOutbox()
}

function notifyOne(json) {
  // 外发同样按 CHUNK 分片、最后一片以 \n 收尾，手机端按同一套字节流规则重组
  const bytes = utf8Encode(json + '\n')
  try {
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const slice = bytes.subarray(off, Math.min(off + CHUNK, bytes.length))
      const ok = server.notifyCharacteristicChanged(deviceId, {
        serviceUuid: SVC,
        characteristicUuid: C_EVENT,
        characteristicValue: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
        confirm: false,
      })
      if (!ok) return false
    }
    return true
  } catch (e) {
    return false
  }
}

// 按字节流喂入，遇到 \n 交出一条完整消息
function feed(uuid, bytes, onLine) {
  const buf = rxbuf[uuid] || []
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      onLine(utf8Decode(buf))
      buf.length = 0
    } else {
      buf.push(bytes[i])
      if (buf.length > 4096) buf.length = 0 // 脏数据兜底：超长直接丢弃重收
    }
  }
  rxbuf[uuid] = buf
}

function onLine(line, uuid) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch (e) {
    return
  }
  if (uuid === C_PLAN) {
    // plan：今天的计划 / 训练中途手机改了计划的重推；rest：手机调整休息时间
    if (msg && msg.t === 'plan' && msg.workout && handlers.onPlan) handlers.onPlan(msg)
    else if (msg && msg.t === 'rest' && handlers.onRest) handlers.onRest(msg)
    else if (msg && msg.t === 'unset' && handlers.onUnset) handlers.onUnset(msg)
  } else if (uuid === C_STATUS) {
    if (msg && msg.t === 'ack') ackUpto(msg.upto)
  }
}

// 手机确认收到 upto 之前的事件 → 清掉对应积压
function ackUpto(upto) {
  const keep = outbox.filter((e) => e.at > upto)
  if (keep.length !== outbox.length) {
    outbox = keep
    persistOutbox()
  }
}

function respond(data, value) {
  try {
    server.sendResponse({
      deviceId: data.deviceId,
      transId: data.transId,
      status: 0,
      offset: data.offset,
      value: value || new ArrayBuffer(0),
    })
  } catch (e) { /* 响应失败不影响主流程 */ }
}

function cccd(charUuid) {
  return { serviceUuid: SVC, characteristicUuid: charUuid, descriptorUuid: CCCD, descriptorValue: new ArrayBuffer(2) }
}

function persistOutbox() {
  storage.set({ key: K_OUTBOX, value: outbox, fail: (d, c) => console.log('outbox save failed', c) })
}

function loadOutbox() {
  try {
    const l = storage.getSync({ key: K_OUTBOX })
    return Array.isArray(l) ? l.map((entry) => ({ ...entry, sent: !!entry.sent })) : []
  } catch (e) { return [] }
}
