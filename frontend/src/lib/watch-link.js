// 手表连接（vivo 智能终端 SDK）：设置页的「连接手表」与训练页的自动推计划都走这里。
//
// 手机侧不再扫描/选择设备。DeviceRpcManager 绑定 vivo 运动健康后，
// 手表应用用手机包名 + 证书指纹创建 interconnect 实例，连接由 SDK 完成。
// 协议仍是 plan / set / end / rest / weight / unset / ack，只是底层从 GATT 换成 RPC。
import { MOBILE, isAndroid } from './mobile.js'

let pluginP = null
const watchPlugin = () => pluginP || (pluginP = (async () => {
  if (!(await isAndroid())) return null
  try {
    const { registerPlugin } = await import('@capacitor/core')
    return { WatchRpc: registerPlugin('WatchRpc') }
  } catch { return null }
})().catch(() => null))

// ---- 状态广播：设置页与训练页都订阅这一个 ----
let state = 'off' // off | connecting | connected | ready | error
let lastError = ''
let device = null
const listeners = new Set()
let pendingPlan = null
let latestPlan = null
let planPushInFlight = false
let bound = false
let planSequence = 0
let watchVersion = 'not_reported'
let watchReceiptsSupported = false
let lastPlanReceipt = null
let lastSyncReceipt = null
let lastWatchRx = null
let lastPlanClear = null
let lastPublishedPlan = null
let onWatchLifecycle = () => false
export function bindWatchLifecycle(cb) {
  onWatchLifecycle = cb
  return () => { if (onWatchLifecycle === cb) onWatchLifecycle = () => false }
}
export const pushEndedToWatch = msg => sendWatchEvent({ ...msg, t: 'ended' })

export function watchState() { return state }
export function onWatchState(cb) {
  listeners.add(cb)
  try { cb(state) } catch { /* 单个订阅者出错不影响别人 */ }
  return () => listeners.delete(cb)
}

function setState(s, error = '') {
  state = s
  lastError = error
  for (const cb of listeners) {
    try { cb(state) } catch { /* 单个订阅者出错不影响别人 */ }
  }
}

// 原生侧的连接/事件回调
async function bindNative() {
  if (bound || !MOBILE) return
  const p = await watchPlugin()
  if (!p) return
  bound = true

  p.WatchRpc.addListener('watchState', (ev) => {
    const next = ev && ev.state ? ev.state : 'off'
    if (typeof ev?.connected === 'boolean') device = { ...(device || {}), connected: ev.connected }
    setState(next === 'disconnected' ? 'off' : next, ev && ev.reason ? ev.reason : '')
    if (next === 'ready' || next === 'connected') {
      if (!pendingPlan && latestPlan) pendingPlan = latestPlan
      Promise.resolve().then(flushPendingPlan)
    }
  })

  p.WatchRpc.addListener('watchEvent', (ev) => {
    try {
      if (!ev) return
      if (ev.t === 'device') {
        device = { ...(device || {}), ...ev }
        return
      }
      if (ev.watchVersion) watchVersion = String(ev.watchVersion)
      if (ev.t === 'hello') {
        watchVersion = ev.watchVersion ? String(ev.watchVersion) : 'not_reported'
        watchReceiptsSupported = ev.receipts === true
      }
      if (ev.t === 'plan_ack') {
        lastPlanReceipt = { ...ev, receivedAt: Date.now() }
        if (latestPlan && ev.sid === latestPlan.sid && ev.planId === latestPlan.planId) {
          latestPlan.receipt = lastPlanReceipt
        }
        return
      }
      if (ev.t === 'sync_ack') { lastSyncReceipt = { ...ev, receivedAt: Date.now() }; return }
      if (ev.t === 'watch_rx') { lastWatchRx = { ...ev, receivedAt: Date.now() }; return }
      if (onWatchLifecycle(ev)) return
      // 手表刚打开：如果计划之前没送到，借这次握手立刻补推。
      if (ev.t === 'hello' && latestPlan) {
        pendingPlan = latestPlan
        Promise.resolve().then(flushPendingPlan)
      }
      // 这些是“状态/结构调整”，训练页通过 bindWatchSync 落库；其余是完成/结束事件。
      if (ev.t === 'rest' || ev.t === 'weight' || ev.t === 'reps' ||
          ev.t === 'add_set' || ev.t === 'remove_set' || ev.t === 'focus' ||
          ev.t === 'hello' || ev.t === 'sync') {
        onWatchSync(ev)
      } else {
        onWatchEvent(ev)
      }
    } catch (e) { console.log('watch event failed', e) }
  })
}

// ---- 设置页 API ----

/** vivo 手机 + 运动健康就绪时可用；连接由 SDK 完成，不需要蓝牙权限。 */
export async function watchAvailable() {
  if (!MOBILE) return { available: false, reason: 'web' }
  const p = await watchPlugin()
  if (!p) return { available: false, reason: 'web' }
  try {
    const r = await p.WatchRpc.isSupported()
    if (typeof r?.connected === 'boolean') device = { ...(device || {}), connected: r.connected }
    if (!r || !r.available) return { available: false, reason: (r && r.reason) || 'notVivo' }
    return { available: true }
  } catch { return { available: false, reason: 'web' } }
}

/** 初始化 SDK 并绑定运动健康。手表端打开应用后即可收发。 */
export async function connectWatch() {
  await bindNative()
  const p = await watchPlugin()
  if (!p) { setState('error', 'web'); return false }
  setState('connecting')
  try {
    const r = await p.WatchRpc.connect()
    device = { ...(device || {}), connected: !!r?.connected }
    setState(r && r.connected ? 'connected' : 'ready')
    return true
  } catch (e) {
    setState('error', e && e.message ? e.message : 'connect failed')
    return false
  }
}

export async function disconnectWatch() {
  const p = await watchPlugin()
  if (p) {
    try { await p.WatchRpc.disconnect() } catch { /* 已经断开 */ }
  }
  device = { ...(device || {}), connected: false }
  setState('off')
}

/** 请求运动健康拉起手表应用；ok 表示 RPC 请求成功，实际启动看手表/hello。 */
export async function openWatchApp() {
  await bindNative()
  if ((state === 'off' || state === 'error') && !(await connectWatch())) {
    return { ok: false, code: -1, data: lastError }
  }
  const p = await watchPlugin()
  if (!p) return { ok: false, code: -1, data: 'web' }
  try {
    const result = await p.WatchRpc.openWatchApp()
    return result || { ok: false, code: -1, data: 'empty response' }
  } catch (e) {
    return { ok: false, code: -1, data: e?.message || 'open watch app failed' }
  }
}

/** 读设备信息（名称、电量、存储、连接状态）。 */
export async function getWatchDeviceInfo() {
  const p = await watchPlugin()
  if (!p) return null
  try {
    const r = await p.WatchRpc.getDeviceInfo()
    if (!r || !r.ok || !r.data) return null
    try {
      const parsed = JSON.parse(r.data)
      const info = parsed.device || parsed
      device = { ...(device || {}), ...info }
      if ((state === 'ready' || state === 'connected') && typeof info.connected === 'boolean') {
        setState(info.connected ? 'connected' : 'ready')
      }
      return info
    } catch { return { raw: r.data } }
  } catch { return null }
}

export function watchDevice() { return device ? { ...device } : null }
export function watchLastError() { return lastError }

/** 原生 SDK 日志（最近 300 行），用于设置页排查连接问题。 */
export async function getWatchLogs() {
  const p = await watchPlugin()
  if (!p) return { logs: '', lastError: 'web', initialized: false }
  try {
    return await p.WatchRpc.getLogs()
  } catch (e) {
    return { logs: '', lastError: e && e.message ? e.message : String(e), initialized: false }
  }
}

/** 版本/环境诊断：vivo、健康应用、SDK 初始化、设备版本。 */
export async function getWatchDiagnostics() {
  const p = await watchPlugin()
  if (!p) return null
  try {
    return { ...await p.WatchRpc.getVersion(), planSid: latestPlan?.sid || '',
      planId: latestPlan?.planId || '',
      planPending: !!pendingPlan, planPushInFlight, planLastError: lastError,
      planDelivery: !latestPlan ? 'idle' : latestPlan.receipt?.status || latestPlan.delivery,
      watchVersion, watchReceiptsSupported, lastPlanReceipt, lastSyncReceipt, lastWatchRx,
      lastPublishedPlan, lastPlanClear }
  } catch (e) {
    return { lastError: e && e.message ? e.message : String(e) }
  }
}

// ---- 训练页 API：把今天的训练推给手表 ----

/** 训练开始时调用一次；训练中途计划变了（加/删动作）再调一次，手表整包热替换。 */
export async function pushPlanToWatch(workout, sid, profile = null) {
  if (!MOBILE || !workout) return
  const planId = Date.now() + '-' + (++planSequence)
  latestPlan = { workout, sid: String(sid || ''), profile, planId, delivery: 'queued', receipt: null }
  lastPublishedPlan = { sid: latestPlan.sid, planId, exercises: workout.exercises?.length || 0, at: Date.now() }
  pendingPlan = latestPlan
  await bindNative()
  if (state === 'off' || state === 'error') await connectWatch()
  return flushPendingPlan()
}

export function clearWatchPlan(sid, reason = 'no_active_session', endedAt = Date.now()) {
  if (sid && latestPlan?.sid !== sid) return
  if (latestPlan) lastPlanClear = { sid: latestPlan.sid, planId: latestPlan.planId, reason, at: Date.now() }
  if (latestPlan?.sid) pushEndedToWatch({ sid: latestPlan.sid, reason, endedAt })
  latestPlan = null
  pendingPlan = null
}

async function flushPendingPlan() {
  if (planPushInFlight || !pendingPlan) return
  if (state !== 'ready' && state !== 'connected') return
  // 在第一个 await 前占用发送位，ready/hello/新计划共用同一串行队列。
  planPushInFlight = true
  try {
    const p = await watchPlugin()
    if (!p) return
    while (pendingPlan && (state === 'ready' || state === 'connected')) {
      const next = pendingPlan
      pendingPlan = null
      const msg = {
        t: 'plan',
        v: 2,
        sid: next.sid || '',
        planId: next.planId,
        workout: next.workout.name || '',
        profile: next.profile || null,
        exercises: (next.workout.exercises || []).map(e => ({
          name: e.name || '',
          sets: e.sets || 1,
          reps: e.reps != null ? String(e.reps) : '',
          restSec: e.restSec || 60,
          weight: e.weight != null ? String(e.weight) : '',
        })),
      }
      let failed = false
      next.delivery = 'awaiting_receipt'
      try {
        const r = await p.WatchRpc.sendPlan({ json: JSON.stringify(msg) })
        failed = !r?.ok
        if (failed) next.delivery = 'transport_failed'
        lastError = failed ? `send plan code=${r?.code ?? -1}: ${r?.data || ''}` : ''
      } catch (e) {
        failed = true
        next.delivery = 'transport_failed'
        lastError = e?.message || 'send plan failed'
      }
      if (failed && !pendingPlan && latestPlan === next) {
        // 等下一次 hello/连接事件再试；不覆盖更新、不复活已结束的会话、不热循环。
        pendingPlan = next
        break
      }
    }
  } finally {
    planPushInFlight = false
  }
}

async function sendWatchEvent(obj) {
  if (!MOBILE || !obj) return false
  await bindNative()
  const p = await watchPlugin()
  if (!p) return false
  try {
    const r = await p.WatchRpc.sendEvent({ json: JSON.stringify(obj) })
    if (r && !r.ok) lastError = r.data || 'send event failed'
    return !!(r && r.ok)
  } catch (e) {
    lastError = e && e.message ? e.message : 'send event failed'
    return false
  }
}

// ---- 实时同步：手机 → 手表 ----

let restSeq = 0
const lastSentRest = { leftSec: -1, at: 0 }

/** 手机调整了休息（±15s、暂停续跑、跳过）：立即推给手表。 */
export async function pushRestToWatch(sid, leftSec) {
  if (!MOBILE || !sid) return
  const now = Date.now()
  if (leftSec === lastSentRest.leftSec && now - lastSentRest.at < 1000) return
  lastSentRest.leftSec = leftSec
  lastSentRest.at = now
  restSeq += 1
  await sendWatchEvent({ t: 'rest', sid, leftSec, totalSec: leftSec, seq: restSeq })
}

/** 手机改了某组的重量（ex=动作下标，set=第几组，1 起）。 */
export async function pushWeightToWatch(sid, ex, set, weight, editAt) {
  if (!MOBILE || !sid) return
  await sendWatchEvent({ t: 'weight', sid, ex, set, weight: String(weight ?? ''), editAt })
}

/** 手机改了某组的次数。 */
export async function pushRepsToWatch(sid, ex, set, reps, editAt) {
  if (!MOBILE || !sid) return
  await sendWatchEvent({ t: 'reps', sid, ex, set, reps: String(reps ?? ''), editAt })
}

/** 手机上完成某组：手表端同步完成态。 */
export async function pushSetToWatch(sid, ex, set) {
  if (!MOBILE || !sid) return
  await sendWatchEvent({ t: 'set', sid, ex, set })
}

/** 手机上取消勾选了某组：手表端把那组的完成态抹掉。 */
export async function pushUnsetToWatch(sid, ex, set) {
  if (!MOBILE || !sid) return
  await sendWatchEvent({ t: 'unset', sid, ex, set })
}

/** 手机加组：手表端同步追加一组。 */
export async function pushAddSetToWatch(sid, ex, sets) {
  if (!MOBILE || !sid) return
  await sendWatchEvent({ t: 'add_set', sid, ex, sets, at: Date.now() })
}

/** 手机减组：手表端同步删除最后一组。 */
export async function pushRemoveSetToWatch(sid, ex, sets) {
  if (!MOBILE || !sid) return
  await sendWatchEvent({ t: 'remove_set', sid, ex, sets, at: Date.now() })
}

/** 手机切换当前动作：手表跟着换焦点。 */
export async function pushFocusToWatch(sid, ex, set) {
  if (!MOBILE || !sid) return
  await sendWatchEvent({ t: 'focus', sid, ex, set })
}

/** 确认收到手表事件；手表用 upto 清理 outbox。 */
export async function pushAckToWatch(upto) {
  if (!MOBILE || upto == null) return
  await sendWatchEvent({ t: 'ack', upto })
}

/** 重连后的权威快照。snapshot 由训练页从活动会话生成。 */
export async function pushSyncToWatch(snapshot) {
  if (!MOBILE || !snapshot) return false
  return sendWatchEvent({ ...snapshot, t: 'sync' })
}

// ---- 手表事件 → 训练页 ----

let onWatchSync = () => {}
/** 训练页注册：收到手表 rest/weight/reps/加组/减组/切换动作/hello 时怎么应用。 */
export function bindWatchSync(cb) {
  const fn = cb || (() => {})
  onWatchSync = fn
  return () => { if (onWatchSync === fn) onWatchSync = () => {} }
}

let onWatchEvent = () => {}
/** 训练页注册：收到手表“完成一组/撤销/结束”时怎么写进会话。 */
export function bindWatchEvents(cb) {
  const fn = cb || (() => {})
  onWatchEvent = fn
  return () => { if (onWatchEvent === fn) onWatchEvent = () => {} }
}
