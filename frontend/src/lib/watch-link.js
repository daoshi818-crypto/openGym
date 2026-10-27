// 手表连接（vivo 智能终端 SDK）：设置页的「连接手表」与训练页的自动推计划都走这里。
//
// 手机侧不再扫描/选择设备。DeviceRpcManager 绑定 vivo 运动健康后，
// 手表应用用手机包名 + 证书指纹创建 interconnect 实例，连接由 SDK 完成。
// 协议仍是 plan / set / end / rest / weight / unset / ack，只是底层从 GATT 换成 RPC。
import { MOBILE, isAndroid } from './mobile.js'
import { isWarmupRow } from './workout-model.js'
import { wireHash, splitWire, diffWire } from '../../../watch-app/src/lib/sync-wire.js'
import { watchSnapshotOf } from './watch-workout.js'

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
let lastWatchTransport = null, watchDiagnosticProbe = null
let watchDiagnosticRequest = null, diagnosticSequence = 0
let lastPlanClear = null
let lastPublishedPlan = null
let onWatchLifecycle = () => false
let trainingStore = null
let syncProtocol = 2
let syncBase = null
const sentSnapshots = new Map()
let pendingSync = null, syncRetryTimer = null, syncQueue = Promise.resolve()
function scheduleSyncRetry(attempt) {
  clearTimeout(syncRetryTimer)
  if (pendingSync !== attempt) return
  syncRetryTimer = setTimeout(() => {
    if (pendingSync !== attempt) return
    transmitSync(attempt)
  }, Math.min(60000, 6000 * Math.pow(2, Math.min(4, Math.max(0, attempt.tries - 1)))) + Math.floor(Math.random() * 500))
  syncRetryTimer.unref?.()
}
function transmitSync(attempt) {
  const task = syncQueue.catch(() => {}).then(async () => {
    if (pendingSync !== attempt) return false
    attempt.tries++
    const delta = diffWire(syncBase, attempt.snapshot)
    const message = delta && JSON.stringify(delta).length < JSON.stringify(attempt.snapshot).length ? delta : attempt.snapshot
    try {
      for (const chunk of splitWire(message, attempt.snapshot.sid + ':' + attempt.snapshot.wireHash)) {
        if (pendingSync !== attempt) return false
        if (!(await sendWatchEvent(chunk))) return false
      }
      return true
    } catch (error) { lastError = error.message; return false }
    finally { scheduleSyncRetry(attempt) }
  })
  syncQueue = task
  return task
}
let outboundBarrier = null
let commitStatus = { phase: 'idle', pending: 0, error: '' }
const commitListeners = new Set()
export function onWatchCommitStatus(cb) { commitListeners.add(cb); cb(commitStatus); return () => commitListeners.delete(cb) }
export function holdWatchOutbound() {
  if (outboundBarrier) return () => {}
  let resolve
  const promise = new Promise(done => { resolve = done })
  const barrier = { promise, resolve }
  outboundBarrier = barrier
  return () => {
    if (outboundBarrier !== barrier) return
    outboundBarrier = null; resolve()
    Promise.resolve().then(flushPendingPlan)
  }
}
export function setWatchCommitStatus(status) { commitStatus = status; for (const cb of commitListeners) { try { cb(status) } catch { /* isolated subscriber */ } } }
let drainingInbox = false
export async function drainWatchInbox() {
  if (drainingInbox || !trainingStore) return
  drainingInbox = true
  try {
    const p = await watchPlugin()
    if (!p?.WatchRpc.drainInbox) return
    const batch = await p.WatchRpc.drainInbox()
    for (const ev of batch?.events || []) onNativeWatchEvent(ev)
  } catch (e) { listenerError = 'watch inbox: ' + (e?.message || String(e)) }
  finally { drainingInbox = false }
}
export async function completeWatchInbox(id) {
  const p = await watchPlugin()
  if (p?.WatchRpc.completeInbox) await p.WatchRpc.completeInbox({ id })
  // A bounded drain advances only as committed entries leave the native inbox.
  Promise.resolve().then(drainWatchInbox)
}
export function bindWatchLifecycle(cb, store = null) {
  trainingStore = store
  onWatchLifecycle = cb
  Promise.resolve().then(drainWatchInbox)
  return () => { if (onWatchLifecycle === cb) onWatchLifecycle = () => false }
}
export const pushEndedToWatch = msg => sendWatchEvent({ ...msg, t: 'ended' })
export const sendToWatch = msg => sendWatchEvent(msg)
export function retryWatchConflict(key, record) {
  return onWatchLifecycle({ ...record.event, _inboxId: undefined, resolutionOf: key,
    eventId: record.event.eventId + ':resolve:' + Date.now(),
    baseCommitRev: trainingStore?.getState()?.active?.syncRev || 0,
    at: Date.now() }) === true
}
const receiptListeners = new Set()

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

// 原生侧的连接/事件回调。
//
// 注册要么全部成功，要么全部撤掉再重试：以前先写 bound=true 再 addListener，任一失败就
// 永久处于“已绑定但没有监听”的状态 —— 手机能推计划（sendPlan 不需要监听），
// 却收不到手表发来的完成组事件，正是“手表完成组手机不更新、反向正常”的形状。
let binding = null
const listenerHandles = []
// Kept apart from lastError: connectWatch's setState() blanks that on every attempt, and a
// failed listener registration is exactly what must stay visible until it is fixed.
let listenerError = ''
async function bindNative() {
  if (!MOBILE || listenerHandles.length) return
  if (binding) return binding
  binding = (async () => {
    const p = await watchPlugin()
    if (!p) return
    const added = []
    try {
      added.push(await p.WatchRpc.addListener('watchState', onNativeWatchState))
      added.push(await p.WatchRpc.addListener('watchEvent', onNativeWatchEvent))
      listenerHandles.push(...added)
      bound = true
      listenerError = ''
      Promise.resolve().then(drainWatchInbox)
    } catch (e) {
      for (const handle of added) { try { await handle?.remove?.() } catch { /* 已经失效 */ } }
      bound = false
      listenerError = 'watch listeners: ' + (e && e.message ? e.message : String(e))
    } finally {
      binding = null
    }
  })().catch(() => { binding = null })
  return binding
}

function onNativeWatchState(ev) {
  const next = ev && ev.state ? ev.state : 'off'
  if (typeof ev?.connected === 'boolean') device = { ...(device || {}), connected: ev.connected }
  setState(next === 'disconnected' ? 'off' : next, ev && ev.reason ? ev.reason : '')
  if (next === 'ready' || next === 'connected') {
    if (!pendingPlan && latestPlan) pendingPlan = latestPlan
    Promise.resolve().then(flushPendingPlan)
  }
}

function onNativeWatchEvent(ev) {
  try {
    if (!ev) return
    for (const cb of receiptListeners) { try { cb(ev) } catch { /* Status subscribers must not interrupt delivery. */ } }
    if (ev.t === 'device') {
      device = { ...(device || {}), ...ev }
      return
    }
    if (ev.watchVersion) watchVersion = String(ev.watchVersion)
    if (ev.t === 'hello') {
      watchVersion = ev.watchVersion ? String(ev.watchVersion) : 'not_reported'
      watchReceiptsSupported = ev.receipts === true
      syncProtocol = ev.protocolVersion >= 3 && ev.capabilities?.durableCommit && ev.capabilities?.snapshotChunks ? 3 : 2
      syncBase = null; sentSnapshots.clear()
      clearTimeout(syncRetryTimer); pendingSync = null
    }
    if (ev.t === 'plan_ack') {
      lastPlanReceipt = { ...ev, receivedAt: Date.now() }
      if (latestPlan && ev.sid === latestPlan.sid && ev.planId === latestPlan.planId) {
        latestPlan.receipt = lastPlanReceipt
      }
      return
    }
    if (ev.t === 'sync_ack') {
      lastSyncReceipt = { ...ev, receivedAt: Date.now() }
      const snapshot = sentSnapshots.get(ev.wireHash)
      if (snapshot && ['applied', 'retained'].includes(ev.status) && ev.commitRev === snapshot.commitRev) syncBase = snapshot
      if (pendingSync?.snapshot.wireHash === ev.wireHash && ['applied', 'retained', 'closed', 'conflict'].includes(ev.status)) {
        clearTimeout(syncRetryTimer); pendingSync = null
      }
      return
    }
    if (ev.t === 'sync_request') {
      syncBase = null
      const snapshot = [...sentSnapshots.values()].at(-1)
      if (snapshot) pushSyncToWatch(snapshot)
      return
    }
    if (ev.t === 'watch_diagnostics') {
      lastWatchTransport = { ...ev, receivedAt: Date.now() }
      if (watchDiagnosticProbe?.id === ev.requestId) watchDiagnosticProbe.finish('received')
      return
    }
    if (ev.t === 'watch_rx') { lastWatchRx = { ...ev, receivedAt: Date.now() }; return }
    // 生命周期消息（完成/撤销/结构/关闭/汇总）由全局协调器同步认领，其余仍交给训练页。
    // 认领必须保持同步布尔判断；异步执行在其内部完成，不能让 Promise 冒充 true。
    let claimed = false
    try { claimed = onWatchLifecycle(ev) === true } catch (e) {
      console.log('watch lifecycle failed', e)
      listenerError = 'watch lifecycle: ' + (e && e.message ? e.message : String(e))
      claimed = false
    }
    if (claimed) return
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
  } catch (e) {
    console.log('watch event failed', e)
    // 未消费的消息不能假装成功：手表保留 outbox，等下一次重放。
    listenerError = 'watch event: ' + (e && e.message ? e.message : String(e))
  }
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
  watchDiagnosticProbe?.finish('disconnected')
  clearTimeout(syncRetryTimer); pendingSync = null
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
export function watchLastError() { return lastError || listenerError }

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

/** Explicit read-only probe; no workout checkpoint, ACK, reconnect or queue mutation. */
export async function requestWatchDiagnostics() {
  await bindNative()
  const p = await watchPlugin()
  if (!p) return false
  if (watchDiagnosticProbe) return watchDiagnosticProbe.promise
  const id = Date.now() + '-' + (++diagnosticSequence)
  watchDiagnosticRequest = { id, sentAt: Date.now(), status: 'pending' }
  const probe = { id }
  let timer
  probe.promise = new Promise(resolve => {
    probe.finish = status => {
      if (watchDiagnosticProbe !== probe) return
      clearTimeout(timer)
      watchDiagnosticProbe = null
      watchDiagnosticRequest = { ...watchDiagnosticRequest, status, completedAt: Date.now() }
      resolve(status === 'received')
    }
  })
  watchDiagnosticProbe = probe
  timer = setTimeout(() => probe.finish('timeout'), 2500)
  Promise.resolve().then(() => p.WatchRpc.sendEvent({ json: JSON.stringify({ t: 'watch_diagnostics_request', requestId: id }) }))
    .then(result => { if (!result?.ok) probe.finish('send_failed') }, () => probe.finish('send_failed'))
  return probe.promise
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
      lastWatchTransport, watchDiagnosticRequest,
      commitStatus,
      syncProtocol, syncCommitRev: syncBase?.commitRev || 0,
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
  if (!sid || pendingSync?.snapshot.sid === sid) { clearTimeout(syncRetryTimer); pendingSync = null }
  if (latestPlan) lastPlanClear = { sid: latestPlan.sid, planId: latestPlan.planId, reason, at: Date.now() }
  if (latestPlan?.sid) pushEndedToWatch({ sid: latestPlan.sid, reason, endedAt })
  latestPlan = null
  pendingPlan = null
}

async function flushPendingPlan() {
  if (outboundBarrier) return
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
      try {
        await trainingStore?.checkpoint?.()
        if (outboundBarrier) { pendingPlan ||= next; break }
      } catch (error) {
        lastError = 'watch state save: ' + (error?.message || String(error))
        pendingPlan ||= next
        break
      }
      const msg = {
        t: 'plan',
        v: 2, protocolVersion: next.workout.protocolVersion || 1, weightUnit: next.workout.weightUnit || next.profile?.weightUnit || 'kg', structureRevision: next.workout.structureRevision,
        sid: next.sid || '',
        planId: next.planId,
        workout: next.workout.name || '',
        profile: next.profile || null,
        exercises: (next.workout.exercises || []).map(e => ({
          ...(e.id ? { id: e.id } : {}), entryInstanceId: e.entryInstanceId, setIds: e.setIds, weightUnit: e.weightUnit,
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
  while (outboundBarrier) await outboundBarrier.promise
  const S = trainingStore?.getState(), A = S?.active
  if (A && obj.sid === String(A.watchSid || A.start) && Number.isInteger(obj.ex)) {
    const entry = A.entries[obj.ex], rows = entry?.sets.filter(r => !isWarmupRow(r)) || [], row = rows[obj.set - 1]
    obj = { ...obj, protocolVersion: 2, entryInstanceId: entry?.entryInstanceId, setId: row?.setId,
      weightUnit: S.unit || 'kg', structureRevision: A.structureRevision, at: obj.editAt || obj.at || Date.now() }
    if (['add_set','remove_set'].includes(obj.t)) obj.setIds = rows.map(r => r.setId)
    const field = obj.t === 'weight' ? 'weight' : obj.t === 'reps' ? 'reps' : ['set','unset'].includes(obj.t) ? 'done' : null
    if (field && row) trainingStore.update(s => { const a = s.active; if (!a || a.start !== A.start) return; a.watchVersions ||= {}; a.watchVersions[[entry.entryInstanceId || obj.ex, row.setId || obj.set, field].join(':')] = obj.at })
  }
  if (syncProtocol >= 3 && trainingStore && obj.sid === String(A?.watchSid || A?.start) && ['weight', 'reps', 'set', 'unset', 'effort', 'rest', 'pause', 'focus', 'add_set', 'remove_set'].includes(obj.t)) {
    const snapshot = watchSnapshotOf(trainingStore.getState(), trainingStore.getTimer?.())
    if (snapshot) return pushSyncToWatch(snapshot)
  }
  await bindNative()
  const p = await watchPlugin()
  if (!p) return false
  try {
    if (!['ack', 'committed', 'received', 'effort_ack', 'event_rejected', 'watch_start_ack'].includes(obj.t)) await trainingStore?.checkpoint?.()
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
export async function pushRestToWatch(sid, leftSec, timer = null) {
  if (!MOBILE || !sid) return
  const now = Date.now()
  lastSentRest.leftSec = leftSec
  lastSentRest.at = now
  restSeq += 1
  await sendWatchEvent({ t: 'rest', sid, leftSec, totalSec: timer?.total || 0,
    restId: timer?.restId || '', startedAt: timer?.startedAt || 0,
    endsAt: timer && !timer.paused && !timer.ready ? timer.endsAt : 0,
    paused: !!timer?.paused, seq: timer?.seq || now, source: 'phone' })
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
  await sendWatchEvent({ t: 'focus', sid, ex, set, at: Date.now(), source: 'phone' })
}

/** 确认收到手表事件；eventId 精确到一条，没有 upto 时也要能单独确认。 */
export async function pushAckToWatch(upto, eventId) {
  if (!MOBILE || (upto == null && !eventId)) return
  await sendWatchEvent({ t: 'ack', upto, eventId })
}

export async function continueOnWatch(snapshot, onStatus) {
  const available = await watchAvailable()
  if (!available.available) { onStatus('手表不可用：' + available.reason); return false }
  onStatus('正在连接手表')
  let timer
  const confirmation = new Promise(resolve => {
    const listener = ev => {
      if (['plan_ack', 'sync_ack'].includes(ev.t) && ev.sid === snapshot.sid && ['applied', 'retained'].includes(ev.status)) {
        clearTimeout(timer); receiptListeners.delete(listener); resolve(true)
      }
    }
    receiptListeners.add(listener)
    timer = setTimeout(() => { receiptListeners.delete(listener); resolve(false) }, 10000)
  })
  const result = await openWatchApp()
  if (result.ok) {
    onStatus('请求已发，等待手表确认')
    await pushPlanToWatch({ name: snapshot.workout, exercises: snapshot.exercises }, snapshot.sid, snapshot.profile)
    await pushSyncToWatch(snapshot)
  }
  const confirmed = await confirmation
  onStatus(confirmed ? '手表已确认，可继续训练' : result.ok ? '手表未确认，请检查连接' : '手表未连接：' + (result.data || result.code))
  return confirmed
}

/** 重连后的权威快照。snapshot 由训练页从活动会话生成。 */
export async function pushSyncToWatch(snapshot) {
  if (!MOBILE || !snapshot) return false
  if (syncProtocol < 3) return sendWatchEvent({ ...snapshot, t: 'sync' })
  // Hash and delta against an acknowledged phone baseline, never against optimistic watch edits.
  const { wireHash: ignored, ...value } = { ...snapshot, t: 'sync', protocolVersion: 3, ackedEvents: (snapshot.ackedEvents || []).slice(-128) }
  const next = { ...value, wireHash: wireHash(value) }
  sentSnapshots.set(next.wireHash, next)
  while (sentSnapshots.size > 8) sentSnapshots.delete(sentSnapshots.keys().next().value)
  clearTimeout(syncRetryTimer)
  pendingSync = { snapshot: next, tries: 0 }
  return transmitSync(pendingSync)
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

/** 手机改了某组的强度（量表 + 数值；value=null 为清除）。 */
export async function pushEffortToWatch(sid, ex, set, scale, value, version) {
  if (!MOBILE || !sid) return
  if (scale !== 'rpe' && scale !== 'rir') return
  await sendWatchEvent({ t: 'effort', sid, ex, set, scale, value: value == null ? null : Number(value),
    clear: value == null, effortVersion: version, baseEffortVersion: 0 })
}
