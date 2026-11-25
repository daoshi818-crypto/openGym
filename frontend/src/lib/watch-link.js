import { createCommandStateCache } from './watch-command-state.js'
import { createWatchDevices } from './watch-devices.js'
import { phoneWatchLog } from './watch-diagnostic-log.js'
import { persistentSender } from '../../../watch-app/src/lib/persistent-transfer.js'
// 手表连接（vivo 智能终端 SDK）：设置页的「连接手表」与训练页的自动推计划都走这里。
//
// 物理通道由运动健康管理；应用用带随机编号的探测确认当前安装，不展示安装历史。
// SDK 已绑定/发送成功与当前手表应用的双向确认是两种不同状态。
// 协议仍是 plan / set / end / rest / weight / unset / ack，只是底层从 GATT 换成 RPC。
import { MOBILE, isAndroid } from './mobile.js'
import { isWarmupRow } from './workout-model.js'
import { splitWire, compactWire, canonicalWire, wireHash, wireBytes } from '../../../watch-app/src/lib/sync-wire.js'
import { watchPlanOf, watchSnapshotOf, watchWorkoutDTOOf } from './watch-workout.js'

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
const devices = createWatchDevices()
const connectionListeners = new Set()
let peerId = '', identifiedPeer = false, lastVerifiedAt = 0, connectionProbe = null
let currentPeerProof = null, keepaliveTimer = null
let lastDiscoveryAt = -Infinity
function requestCurrentDiscovery() {
  if (!['ready', 'connected'].includes(state) || Date.now() - lastDiscoveryAt < 1500) return
  lastDiscoveryAt = Date.now()
  sendWatchEvent({ t: 'link_discover' }).catch(() => {})
}
let catalogSupported = false, catalogTimer = null, catalogBusy = false, latestCatalog = null
let catalogStatus = { phase: 'idle', count: 0, date: '', confirmedAt: 0, error: '' }
const catalogListeners = new Set(), snapshotSenders = new Map(), catalogSenders = new Map()
let selectionEpoch = 0
export function watchConnection() {
  const preference = devices.read()
  const appConnected = state === 'connected' && !!lastVerifiedAt && Date.now() - lastVerifiedAt < 15000 && (!preference.selectedId || preference.selectedId === peerId)
  return { ...preference, peerId, sdkConnected: state === 'connected', lastVerifiedAt, appConnected,
    canStartWorkout: !!preference.selectedId && preference.selectedId === peerId && appConnected && syncProtocol === 4 &&
      !!v4Current(v4Link) && v4Link.snapshot?.active === false && !v4Start,
    selectionRequired: identifiedPeer && !preference.selectedId,
    differentDevice: !!preference.selectedId && !!peerId && peerId !== preference.selectedId,
    catalogSupported }
}
function emitConnection() { for (const cb of connectionListeners) { try { cb(watchConnection()) } catch { /* subscriber */ } } }
export function onWatchConnection(cb) { connectionListeners.add(cb); cb(watchConnection()); return () => connectionListeners.delete(cb) }
export function watchSessionPresenceReady() {
  const preference = devices.read()
  const active = trainingStore?.getState()?.active
  return MOBILE && peerNegotiated && sessionPresenceSupported && targetReady() &&
    (syncProtocol !== 4 || v4MatchesSession(String(active?.watchSid || active?.start || ''))) &&
    ['connected', 'ready'].includes(state) && (!preference.selectedId || preference.selectedId === peerId)
}
export function preparePhoneWatchPresence(snapshot) {
  // v4 keeps the watch state on reconnect; the lease does not need a phone baseline.
  return syncProtocol === 4 ? v4Current(v4Link) && v4MatchesSession(snapshot?.sid) : pushSyncToWatch(snapshot)
}
export function pushPhoneSessionPresence(message) {
  if (!watchSessionPresenceReady() || message?.t !== 'session_presence' || !message.sid || !message.sessionGeneration) return Promise.resolve(false)
  const active = trainingStore?.getState()?.active
  if (message.active && (!active || String(active.watchSid || active.start) !== message.sid || active.editingWorkoutId ||
      active.watchSessionGeneration !== message.sessionGeneration)) return Promise.resolve(false)
  return sendWatchEvent(message)
}
export function watchCatalogStatus() { return { ...catalogStatus } }
export function onWatchCatalogStatus(cb) { catalogListeners.add(cb); cb(watchCatalogStatus()); return () => catalogListeners.delete(cb) }
function setCatalogStatus(patch) { catalogStatus = { ...catalogStatus, ...patch }; for (const cb of catalogListeners) { try { cb(watchCatalogStatus()) } catch { /* subscriber */ } } }
const targetReady = () => !currentPeerProof && (!devices.read().selectedId ? !identifiedPeer : peerId === devices.read().selectedId)
const routed = msg => msg.t === 'link_probe' && msg.targetInstallationId ? msg : devices.read().selectedId && msg.t !== 'link_discover' ? { ...msg, targetInstallationId: devices.read().selectedId } : msg
function transferStore(channel, owner) {
  return {
    read: async () => { const p = await watchPlugin(); if (!p) throw Error('transfer_unavailable'); return JSON.parse((await p.WatchRpc.loadSyncTransfer({ channel, deviceId: owner })).json) },
    write: async (_, value) => { const p = await watchPlugin(); if (!p) return false; await p.WatchRpc.saveSyncTransfer({ channel, deviceId: owner, json: JSON.stringify(value) }); return true },
  }
}
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
let watchLogProbe = null, watchLogRequest = null
let lastPlanClear = null
let lastPublishedPlan = null
let onWatchLifecycle = () => false
let trainingStore = null
let peerNegotiated = false
let sessionPresenceSupported = false
let negotiationKey = ''
let syncProtocol = 2
let v4Link = null, v4Start = null
const liveEdits = new Set(['weight', 'reps', 'set', 'unset', 'effort', 'rest', 'pause', 'focus', 'add_set', 'remove_set'])
const legacySessionWire = obj => ['plan', 'sync', 'sync_delta', 'sync_inline'].includes(obj.t) ||
  (obj.t.startsWith('sync_') && !/^(?:c:|start:)/.test(obj.transferId || ''))
const v4MatchesSession = sid => !!sid && !!v4Link?.snapshot?.active && v4Link.snapshot.sid === sid
function v4Current(link) {
  return link && v4Link === link && peerNegotiated && targetReady() && ['ready', 'connected'].includes(state)
}
function resetV4() {
  clearTimeout(v4Link?.timer); v4Link = null
  if (v4Start) finishV4Plan(v4Start.plan, 'rejected', 'watch_disconnected')
  if (pendingPlan?.v4Link) {
    const plan = pendingPlan
    pendingPlan = null
    finishV4Plan(plan, 'rejected', 'watch_disconnected')
  }
}
function refreshV4(link) {
  if (!v4Current(link)) return
  clearTimeout(link.timer)
  link.id = 'state-' + Date.now().toString(36) + '-' + (++planSequence)
  link.snapshot = null; link.tries = 0
  emitConnection()
  queryV4(link)
}
function queryV4(link, reason) {
  if (!v4Current(link) || link.snapshot || link.tries >= 4) return
  clearTimeout(link.timer)
  link.tries++
  void sendWatchEvent({ t: 'STATE_QUERY', protocolVersion: 4, requestId: link.id, ...(reason ? { reason } : {}) }, () => v4Current(link) && !link.snapshot)
  link.timer = setTimeout(() => queryV4(link, 'snapshot_timeout'), 3000)
  link.timer.unref?.()
}
function completeLinkInbox(ev) {
  if (!ev._inboxId || claimedInboxIds.has(ev._inboxId)) return
  claimedInboxIds.add(ev._inboxId)
  void completeWatchInbox(ev._inboxId).catch(() => {})
}
function receiveV4Snapshot(ev) {
  const link = v4Link
  if (!v4Current(link) || link.snapshot || ev.protocolVersion !== 4 || ev.requestId !== link.id || typeof ev.active !== 'boolean') return
  // The watch hashes its payload before adding installation routing; Capacitor adds its own envelope fields.
  const { wireHash: hash, sourceInstallationId, _kind, _inboxId, ...value } = ev
  if (wireHash(value) !== hash) { queryV4(link, 'snapshot_checksum'); return }
  clearTimeout(link.timer)
  link.snapshot = value
  link.snapshotReceipt = { requestId: value.requestId, sid: value.sid, wireHash: hash }
  onWatchLifecycle({ ...value, wireHash: hash, sourceInstallationId, _inboxId })
  emitConnection()
  if (pendingPlan) void flushPendingPlan()
}
function finishV4Plan(plan, status, reason = '') {
  if (v4Start?.plan === plan) { clearTimeout(v4Start.timer); v4Start = null }
  plan.delivery = status === 'applied' || status === 'retained' ? 'confirmed' : reason || status
  if (reason) lastError = reason
  const receipt = { t: 'SESSION_ACCEPTED', protocolVersion: 4, requestId: plan.planId, sid: plan.sid,
    status, ...(reason ? { reason } : {}), receivedAt: Date.now() }
  lastPlanReceipt = receipt
  publishPlanReceipt(plan, receipt)
  emitConnection()
}
function receiveV4Acceptance(ev) {
  const attempt = v4Start
  if (!attempt || !v4Current(attempt.link) || ev.protocolVersion !== 4 || ev.requestId !== attempt.plan.planId || ev.sid !== attempt.plan.sid) return
  if (ev.status === 'accepted') {
    attempt.link.snapshot = { ...attempt.link.snapshot, active: true, sid: ev.sid }
    finishV4Plan(attempt.plan, 'applied')
  } else if (ev.status === 'rejected') {
    if (ev.reason === 'watch_active_session' || ev.reason === 'session_closed') refreshV4(attempt.link)
    finishV4Plan(attempt.plan, 'rejected', ev.reason || 'watch_start_rejected')
  } else return
  if (pendingPlan) void flushPendingPlan()
}
async function startV4Plan(plan, link) {
  const peek = link.snapshot
  if (plan.v4Link !== link) { finishV4Plan(plan, 'rejected', 'watch_disconnected'); return }
  if (peek.active) {
    finishV4Plan(plan, 'rejected', 'watch_active_session')
    return
  }
  if (!watchConnection().canStartWorkout) { finishV4Plan(plan, 'rejected', 'watch_not_verified'); return }
  if (peek.terminal?.sid === plan.sid) { finishV4Plan(plan, 'rejected', 'session_closed'); return }
  const current = trainingStore?.getState()
  const snapshot = current && watchSnapshotOf(current, trainingStore.getTimer?.())
  if (trainingStore && snapshot?.sid !== plan.sid) { finishV4Plan(plan, 'rejected', 'phone_session_changed'); return }
  const workout = snapshot ? { ...snapshot, name: snapshot.workout } : plan.workout
  const dto = watchWorkoutDTOOf({ ...workout, weightUnit: workout.weightUnit || plan.profile?.weightUnit }, plan.sid, plan.planId)
  if (!dto) { finishV4Plan(plan, 'rejected', 'watch_start_dto_invalid'); return }
  let frames
  try { frames = splitWire(dto, 'start:' + dto.requestId) }
  catch (e) { finishV4Plan(plan, 'rejected', e.message); return }
  const attempt = { plan, link }
  v4Start = attempt
  // Once any start frame is sent, reconnect reconciles state instead of replaying the start.
  plan.delivery = 'awaiting_receipt'
  emitConnection()
  attempt.timer = setTimeout(() => {
    if (v4Start !== attempt) return
    refreshV4(link)
    finishV4Plan(plan, 'rejected', 'watch_start_timeout')
    if (pendingPlan) void flushPendingPlan()
  }, 10000)
  attempt.timer.unref?.()
  const currentAttempt = () => v4Start === attempt && !plan.cancelled && v4Current(link) && link.snapshot === peek &&
    latestPlan?.sid === plan.sid && (!trainingStore || String(trainingStore.getState()?.active?.watchSid || trainingStore.getState()?.active?.start || '') === plan.sid)
  for (const frame of frames) {
    if (!currentAttempt()) return
    if (!(await sendWatchEvent(frame, currentAttempt))) {
      if (currentAttempt()) {
        refreshV4(link)
        finishV4Plan(plan, 'rejected', 'watch_start_transport')
      }
      return
    }
  }
}
let syncBase = null
const sentSnapshots = new Map()
const commandStates = createCommandStateCache()
let commandReceiptsEnabled = false
let coveredCommandPlan = null
function planContentKey(workout, sid, profile) {
  return JSON.stringify({ sid, name: workout.name, exercises: workout.exercises, profile,
    weightUnit: workout.weightUnit, structureRevision: workout.structureRevision,
    effortScale: workout.effortScale, capabilities: workout.capabilities })
}
function coverPlan(plan, snapshot) {
  plan.snapshotHash = snapshot.wireHash
  plan.coveredByCommand = true
  plan.delivery = 'awaiting_receipt'
  if (pendingPlan === plan) pendingPlan = null
}
function commandPlanCurrent(plan) {
  const active = trainingStore?.getState()?.active
  return coveredCommandPlan && plan.sid === coveredCommandPlan.snapshot.sid &&
    (!trainingStore || (String(active?.watchSid || active?.start) === plan.sid && (active?.syncRev || 0) === coveredCommandPlan.snapshot.commitRev))
}
// Called only after the entire command decision and correction are on disk.
// The durable reply/outbox owns retry; this suppresses only App's derived echo.
export function coverWatchCommandPlan(state) {
  const snapshot = state && commandStates.lookup({ sid: state.sid, wireHash: state.wireHash, commitRev: state.commitRev })
  if (!snapshot || !commandReceiptsEnabled) return
  const active = trainingStore?.getState()?.active
  if (trainingStore && (String(active?.watchSid || active?.start) !== snapshot.sid || (active?.syncRev || 0) !== snapshot.commitRev)) return
  const key = planContentKey({ ...snapshot, name: snapshot.workout }, snapshot.sid, snapshot.profile)
  coveredCommandPlan = { key, snapshot }
  if (latestPlan?.automatic && planContentKey(latestPlan.workout, latestPlan.sid, latestPlan.profile) === key) coverPlan(latestPlan, snapshot)
}
export function prepareWatchCommandState(event, snapshot) {
  return commandReceiptsEnabled ? commandStates.prepare(event, snapshot) : null
}
let pendingSync = null, syncRetryTimer = null, syncQueue = Promise.resolve()
let snapshotGenerations = false
let inlineSnapshots = false
let persistentEnabled = false, persistentPumpTimer = null, persistentPumping = false, persistentAgain = false
let persistentHasWork = false
function snapshotSender() {
  const owner = devices.read().selectedId
  if (!snapshotSenders.has(owner)) snapshotSenders.set(owner, persistentSender(transferStore('sync', owner),
    snapshot => { if (devices.read().selectedId === owner) { adoptSyncBase(snapshot); confirmSnapshotPlan(snapshot) } }, () => Date.now(), null, snapshot => compactWire(syncBase, snapshot), { fenced: () => snapshotGenerations && devices.read().selectedId === owner, inline: () => inlineSnapshots && devices.read().selectedId === owner }))
  return snapshotSenders.get(owner)
}
function catalogSender() {
  const owner = devices.read().selectedId
  if (!catalogSenders.has(owner)) catalogSenders.set(owner, persistentSender(transferStore('catalog', owner), message => {
    if (devices.read().selectedId !== owner || latestCatalog?.catalogId !== message.catalogId) return
    setCatalogStatus({ phase: 'synced', confirmedAt: Date.now(), error: '' })
  }, () => Date.now(), null, null, { channel: 'catalog', types: ['plan_catalog'], fenced: () => snapshotGenerations && devices.read().selectedId === owner, onRetained(message) {
    if (devices.read().selectedId === owner && latestCatalog?.catalogId === message.catalogId) setCatalogStatus({ phase: 'failed', error: '手表保留了更新目录，请校准手机时间后重试' })
  } }))
  return catalogSenders.get(owner)
}
function kickCatalog(delay = 0) {
  clearTimeout(catalogTimer)
  if (!catalogSupported || !targetReady() || state !== 'connected' || catalogBusy) return
  catalogTimer = setTimeout(pumpCatalog, delay); catalogTimer.unref?.()
}
async function pumpCatalog() {
  if (syncProtocol === 4 && v4Link?.snapshot?.active) return
  if (catalogBusy || !catalogSupported || !targetReady() || state !== 'connected') return
  catalogBusy = true
  let delay = null
  try {
    // Active training and exact business receipts retain priority over the plan library.
    if (commitStatus.pending || pendingPlan || planPushInFlight || v4Start || (syncProtocol === 4 && !v4Link?.snapshot) || pendingSync || persistentHasWork || outboundBarrier) { delay = 1000; return }
    const epoch = selectionEpoch, sender = catalogSender(), message = await sender.next()
    if (message && epoch === selectionEpoch) await sendWatchEvent(message)
    delay = await sender.wakeIn()
  } catch (e) { setCatalogStatus({ phase: 'failed', error: e.message }); delay = 6000 }
  finally { catalogBusy = false; if (delay != null) kickCatalog(Math.max(40, delay)) }
}
export async function pushWatchCatalog(catalog, force = false) {
  const { at, catalogId, contentHash, commitRev, sid, contentKey, ...body } = catalog
  const key = JSON.stringify(body)
  if (!force && latestCatalog?.contentKey === key && catalogStatus.phase === 'synced') return true
  if (!force && latestCatalog?.contentKey === key && ['queued', 'syncing'].includes(catalogStatus.phase)) { kickCatalog(); return true }
  const same = latestCatalog?.contentKey === key
  const stamp = Math.max(Date.now(), (latestCatalog?.at || 0) + 1)
  const message = same ? (({ contentKey, ...rest }) => rest)(latestCatalog)
    : { ...body, at: stamp, sid: 'catalog', commitRev: stamp, catalogId: 'catalog:' + stamp.toString(36) }
  if (!same) message.contentHash = wireHash(message)
  latestCatalog = { ...message, contentKey: key }
  setCatalogStatus({ phase: 'queued', count: body.plans?.length || 0, date: body.date || '', confirmedAt: 0, error: '' })
  await bindNative()
  if (!catalogSupported || !targetReady()) return false
  try {
    // A directory that exceeds the bounded watch transport is reported, never silently truncated.
    if (wireBytes(JSON.stringify(message)) > 131072) throw Error('catalog_too_large')
    if (!(await catalogSender().enqueue(message))) throw Error('catalog_revision')
    setCatalogStatus({ phase: 'syncing' }); kickCatalog(); return true
  } catch (e) { setCatalogStatus({ phase: 'failed', error: e.message }); return false }
}
function adoptSyncBase(snapshot) {
  // Delayed transfer receipts must not roll back a newer inline receipt baseline.
  if (!syncBase || syncBase.sid !== snapshot.sid || snapshot.commitRev >= syncBase.commitRev) syncBase = snapshot
}
function confirmSnapshotPlan(snapshot) {
  if (latestPlan?.sid !== snapshot.sid || latestPlan.snapshotHash !== snapshot.wireHash) return
  publishPlanReceipt(latestPlan, { t: 'sync_applied', sid: snapshot.sid, wireHash: snapshot.wireHash, commitRev: snapshot.commitRev, status: 'applied', receivedAt: Date.now() })
}
function kickPersistent(delay = 0) {
  if (!persistentEnabled) return
  if (persistentPumping) { persistentAgain = true; return }
  clearTimeout(persistentPumpTimer)
  persistentPumpTimer = setTimeout(pumpPersistent, delay)
  persistentPumpTimer.unref?.()
}
async function pumpPersistent() {
  if (!persistentEnabled || persistentPumping || !targetReady() || !peerNegotiated) return
  persistentPumping = true; persistentAgain = false
  let delay = null
  try {
    const epoch = selectionEpoch, sender = snapshotSender(), message = await sender.next()
    if (message && epoch === selectionEpoch) await sendWatchEvent(message)
    delay = await sender.wakeIn()
    persistentHasWork = delay != null
  } catch (error) { lastError = 'snapshot: ' + error.message; delay = 6000 }
  finally { persistentPumping = false; if (persistentAgain) kickPersistent(); else if (delay != null) kickPersistent(Math.max(20, delay)) }
}
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
    const message = compactWire(syncBase, attempt.snapshot)
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
export function hasPendingWatchWork() { return commitStatus.pending > 0 || commitStatus.phase === 'saving' || (!!pendingSync || persistentHasWork) || planPushInFlight || !!pendingPlan || !!v4Start }
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
export function setWatchCommitStatus(status) { phoneWatchLog.record('phone_commit', status); commitStatus = status; for (const cb of commitListeners) { try { cb(status) } catch { /* isolated subscriber */ } } }
let drainingInbox = false, inboxDrainTimer = null
const claimedInboxIds = new Set()
function scheduleInboxDrain(delay = 100) {
  if (inboxDrainTimer != null) return
  inboxDrainTimer = setTimeout(() => { inboxDrainTimer = null; drainWatchInbox() }, delay)
  inboxDrainTimer.unref?.()
}
export async function drainWatchInbox() {
  if (drainingInbox || !trainingStore) return
  drainingInbox = true
  try {
    const p = await watchPlugin()
    if (!p?.WatchRpc.drainInbox) return
    const selectedId = devices.read().selectedId
    const batch = await p.WatchRpc.drainInbox(selectedId ? { deviceId: selectedId } : {})
    for (const ev of batch?.events || []) onNativeWatchEvent(ev, true)
  } catch (e) { listenerError = 'watch inbox: ' + (e?.message || String(e)) }
  finally { drainingInbox = false }
}
export async function completeWatchInbox(id) {
  const p = await watchPlugin()
  try {
    if (p?.WatchRpc.completeInbox) await p.WatchRpc.completeInbox({ id })
  } catch (error) {
    // Its decision is already durable. Permit replay rather than permanently
    // suppressing an inbox entry that native storage could not delete.
    claimedInboxIds.delete(id)
    scheduleInboxDrain(1000)
    throw error
  }
  claimedInboxIds.delete(id)
  // Coalesce completions and yield to rendering; do not bridge the same 32 entries per ACK.
  scheduleInboxDrain()
}
export function bindWatchLifecycle(cb, store = null) {
  claimedInboxIds.clear()
  trainingStore = store
  onWatchLifecycle = cb
  Promise.resolve().then(drainWatchInbox)
  return () => { if (onWatchLifecycle === cb) { onWatchLifecycle = () => false; trainingStore = null; claimedInboxIds.clear(); clearTimeout(inboxDrainTimer); inboxDrainTimer = null } }
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
function publishPlanReceipt(plan, receipt) {
  plan.receipt = receipt
  for (const cb of receiptListeners) { try { cb(plan, receipt) } catch { /* Status subscribers must not interrupt delivery. */ } }
}

export function watchState() { return state }
export function onWatchState(cb) {
  listeners.add(cb)
  try { cb(state) } catch { /* 单个订阅者出错不影响别人 */ }
  return () => listeners.delete(cb)
}

function setState(s, error = '') {
  phoneWatchLog.record('connection', { status: s, code: error ? 'connection_error' : '' })
  state = s
  lastError = error
  if (s !== 'connected') lastVerifiedAt = 0
  emitConnection()
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
function verifyCurrentPeer(hello, source) {
  if (currentPeerProof?.source === source) return
  currentPeerProof?.finish(false)
  // A late keepalive from the previous installation must not prune the newly
  // discovered candidate or restore a stale connected indication during proof.
  connectionProbe?.finish(false)
  lastVerifiedAt = 0; identifiedPeer = true; emitConnection()
  let resolve
  const proof = { source, epoch: selectionEpoch,
    id: 'current:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10),
    promise: new Promise(done => { resolve = done }),
    finish(ok) {
      if (currentPeerProof !== proof) return
      clearTimeout(proof.timer); currentPeerProof = null
      if (!ok || proof.epoch !== selectionEpoch) { resolve(false); return }
      if (!devices.useCurrent(source)) { resolve(false); return }
      resetWatchSelection(false).then(() => {
        peerId = source; identifiedPeer = true
        setState('connected')
        onNativeWatchEvent({ ...hello, _routeConfirmed: true })
        lastVerifiedAt = Date.now(); emitConnection(); resolve(true)
      }).catch(() => resolve(false))
    } }
  currentPeerProof = proof
  proof.timer = setTimeout(() => proof.finish(false), 5000); proof.timer.unref?.()
  sendWatchEvent({ t: 'link_probe', targetInstallationId: source, requestId: proof.id }).then(ok => { if (!ok) proof.finish(false) })
}
async function bindNative() {
  if (!MOBILE) return
  keepaliveTimer ||= setInterval(() => {
    if (!peerNegotiated || !peerId) requestCurrentDiscovery()
    else if (state === 'connected' && devices.read().selectedId && targetReady() && !currentPeerProof) probeWatchConnection().catch(() => {})
  }, 5000)
  keepaliveTimer.unref?.()
  if (listenerHandles.length) return
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
  if (next === 'disconnected' || next === 'off' || next === 'error' || ev?.connected === false) {
    resetV4()
    peerNegotiated = false; sessionPresenceSupported = false; catalogSupported = false; lastVerifiedAt = 0; peerId = ''; identifiedPeer = false
    persistentEnabled = false; snapshotGenerations = false; clearTimeout(persistentPumpTimer)
    connectionProbe?.finish(false); clearTimeout(catalogTimer)
    currentPeerProof?.finish(false)
    emitConnection()
  }
  if (next === 'ready' || next === 'connected') {
    if (!peerNegotiated) Promise.resolve().then(requestCurrentDiscovery)
    if (!pendingPlan && latestPlan && syncProtocol < 4) pendingPlan = latestPlan
    Promise.resolve().then(flushPendingPlan)
  }
}

function onNativeWatchEvent(ev, fromInbox = false) {
  try {
    if (!ev) return
    const source = ev.sourceInstallationId || ev.installationId
    if (fromInbox && ev.protocolVersion >= 4 && (ev.t === 'hello' || ev.phoneLed === true)) {
      // The native inbox can outlive the RPC generation. Let the current route's query reconcile v4 progress.
      completeLinkInbox(ev)
      return
    }
    if (!['hello', 'device', 'link_probe_ack'].includes(ev.t) && devices.read().selectedId && source !== devices.read().selectedId) return
    if (source && !['hello', 'device', 'link_probe_ack'].includes(ev.t) && (!peerNegotiated || !targetReady())) return
    if (ev.t === 'watch_log') {
      if (watchLogProbe?.id === ev.requestId && watchLogProbe.offset === ev.offset) watchLogProbe.finish(ev)
      return
    }
    phoneWatchLog.record('receive', ev)
    if (ev._inboxId && claimedInboxIds.has(ev._inboxId)) return
    if (ev.t === 'device') {
      device = { ...(device || {}), ...ev }
      emitConnection()
      return
    }
    if (ev.t === 'hello' && ev.capabilities?.deviceSelection === true && source) {
      if (!devices.discover(source, { ...(device || {}), watchVersion: ev.watchVersion })) return
      if (!devices.accepts(source)) { verifyCurrentPeer(ev, source); return }
      if (peerId !== source) { connectionProbe?.finish(false); persistentEnabled = false; snapshotGenerations = false; peerNegotiated = false; catalogSupported = false; resetV4() }
      identifiedPeer = true; peerId = source
      emitConnection()
      if (!ev._routeConfirmed) Promise.resolve().then(probeWatchConnection)
    } else if (ev.t !== 'link_probe_ack' && devices.read().selectedId && source !== devices.read().selectedId) return
    if (ev.t === 'link_probe_ack') {
      if (currentPeerProof?.id === ev.requestId && currentPeerProof.source === source) { currentPeerProof.finish(true); return }
      if (connectionProbe?.id === ev.requestId && devices.accepts(source) && source === peerId && state === 'connected') { devices.useCurrent(source); connectionProbe.finish(true) }
      return
    }
    if (ev.watchVersion) watchVersion = String(ev.watchVersion)
    if (ev.t === 'STATE_SNAPSHOT') { receiveV4Snapshot(ev); return }
    if (ev.t === 'SESSION_ACCEPTED') { receiveV4Acceptance(ev); return }
    if (syncProtocol === 4 && ev.phoneLed === true && ev.protocolVersion >= 4 && (!v4Current(v4Link) || !v4MatchesSession(ev.sid))) {
      completeLinkInbox(ev)
      return
    }
    if (syncProtocol === 4 && ['plan_ack', 'sync_ack', 'sync_request'].includes(ev.t)) return
    if (syncProtocol === 4 && (ev.t === 'watch_start' || (v4MatchesSession(ev.sid) &&
        (ev.t === 'session_close_ack' || (ev.t === 'session_close' && ev.phoneLed === true && ev.protocolVersion === 4))))) {
      // A watch start or close can change button availability without a transport reconnect.
      const link = v4Link
      queueMicrotask(() => refreshV4(link))
    }
    if (['sync_begin_ack', 'sync_chunk_ack', 'sync_resume', 'sync_applied', 'sync_cancel_ack', 'unknown_transfer', 'sync_error'].includes(ev.t) && ev.transferId?.startsWith('c:')) {
      if (ev.t === 'sync_error' && catalogSupported) setCatalogStatus({ phase: 'failed', error: ev.reason || 'transfer_failed' })
      if (catalogSupported) catalogSender().receipt(ev).then(() => kickCatalog()).catch(e => setCatalogStatus({ phase: 'failed', error: e.message }))
      return
    }
    if (['sync_begin_ack', 'sync_chunk_ack', 'sync_resume', 'sync_applied', 'sync_cancel_ack', 'unknown_transfer', 'sync_error'].includes(ev.t) && ev.transferId?.startsWith('p:')) {
      if (persistentEnabled) snapshotSender().receipt(ev).then(() => kickPersistent()).catch(error => { lastError = error.message; kickPersistent(6000) })
      return
    }
    if (ev.t === 'hello') {
      const key = JSON.stringify([source || '', ev.linkEpoch || ev.helloId || '', ev.protocolVersion, ev.capabilities])
      const fresh = !peerNegotiated || negotiationKey !== key
      const modern = ev.protocolVersion >= 4 && ev.capabilities?.stateSnapshot === true
      if (modern && !fresh && syncProtocol === 4) { completeLinkInbox(ev); return }
      resetV4()
      negotiationKey = key
      peerNegotiated = true
      syncProtocol = modern ? 4 : ev.protocolVersion >= 3 && ev.capabilities?.durableCommit && ev.capabilities?.snapshotChunks ? 3 : 2
      sessionPresenceSupported = ev.capabilities?.sessionPresence === true
      inlineSnapshots = ev.capabilities?.inlineSnapshots === true
      catalogSupported = ev.capabilities?.planCatalogChunks === true
      snapshotGenerations = ev.capabilities?.snapshotGenerations === true
      watchVersion = ev.watchVersion ? String(ev.watchVersion) : 'not_reported'
      watchReceiptsSupported = ev.receipts === true
      persistentEnabled = !modern && ev.protocolVersion >= 3 && ev.capabilities?.durableCommit === true && ev.capabilities?.snapshotChunks === true && ev.capabilities?.selectiveChunkAck === true && ev.capabilities?.persistentTransfers === true
      commandReceiptsEnabled = !modern && ev.protocolVersion >= 3 && ev.capabilities?.commandReceipts === true && ev.capabilities?.durableCommit === true
      const helloAck = { t: 'hello_ack', protocolVersion: modern ? 4 : 3, capabilities: { stateSnapshot: modern, sessionConflict: true, inlineSnapshots: !modern && inlineSnapshots, deviceSelection: ev.capabilities?.deviceSelection === true, planCatalogChunks: catalogSupported, snapshotGenerations, narrowDependencies: ev.capabilities?.narrowDependencies === true, causalFrontier: ev.capabilities?.causalFrontier === true, durableCommit: true, snapshotChunks: !modern, watchEventChunks: true, commandReceipts: commandReceiptsEnabled, sessionPresence: true, dependencyEvents: ev.capabilities?.dependencyEvents === true, selectiveChunkAck: ev.capabilities?.selectiveChunkAck === true, persistentTransfers: !modern && ev.capabilities?.persistentTransfers === true } }
      if (!modern) void sendWatchEvent(helloAck)
      if (!modern && latestCatalog && catalogSupported) pushWatchCatalog(latestCatalog, true)
      if (!modern && fresh && catalogSupported) catalogSender().resume().then(() => kickCatalog()).catch(e => setCatalogStatus({ phase: 'failed', error: e.message }))
      if (fresh && persistentEnabled) snapshotSender().resume().then(() => kickPersistent()).catch(error => { lastError = error.message; kickPersistent(6000) })
      else if (!persistentEnabled) clearTimeout(persistentPumpTimer)
      if (fresh) {
        syncBase = null; sentSnapshots.clear(); coveredCommandPlan = null
        clearTimeout(syncRetryTimer); pendingSync = null
        // Early native inbox delivery is held until the route has negotiated.
        // Replay it now even if the watch has no new live event to trigger work.
        scheduleInboxDrain()
      }
      if (modern) {
        persistentHasWork = false
        const link = v4Link = { id: 'state-' + Date.now().toString(36) + '-' + (++planSequence), tries: 0 }
        if (pendingPlan?.delivery !== 'queued' || pendingPlan.automatic || pendingPlan.legacyShortcut) pendingPlan = null
        // Advertise the selected-device envelope before querying. The snapshot hash excludes it.
        void sendWatchEvent(helloAck, () => v4Current(link)).then(() => queryV4(link))
        completeLinkInbox(ev)
        emitConnection()
        return
      }
      emitConnection()
    }
    if (ev.t === 'plan_ack') {
      lastPlanReceipt = { ...ev, receivedAt: Date.now() }
      if (latestPlan && ev.sid === latestPlan.sid && ev.planId === latestPlan.planId) {
        publishPlanReceipt(latestPlan, lastPlanReceipt)
      }
      return
    }
    if (ev.t === 'sync_ack') {
      lastSyncReceipt = { ...ev, receivedAt: Date.now() }
      const snapshot = sentSnapshots.get(ev.wireHash) || commandStates.lookup(ev)
      const exact = snapshot && ev.sid === snapshot.sid && ev.commitRev === snapshot.commitRev
      if (exact && ev.status === 'applied') { adoptSyncBase(snapshot); confirmSnapshotPlan(snapshot) }
      if (exact && pendingSync?.snapshot.wireHash === ev.wireHash && ['applied', 'retained', 'closed', 'conflict'].includes(ev.status)) {
        clearTimeout(syncRetryTimer); pendingSync = null
      }
      return
    }
    if (ev.t === 'sync_request') {
      syncBase = null
      const snapshot = trainingStore && watchSnapshotOf(trainingStore.getState(), trainingStore.getTimer?.()) || [...sentSnapshots.values()].at(-1)
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
    if (ev.t === 'hello' && pendingPlan) Promise.resolve().then(flushPendingPlan)
    if (claimed) { if (ev._inboxId) claimedInboxIds.add(ev._inboxId); return }
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
    if (!peerNegotiated) Promise.resolve().then(requestCurrentDiscovery)
    return true
  } catch (e) {
    setState('error', e && e.message ? e.message : 'connect failed')
    return false
  }
}

export async function disconnectWatch() {
  resetV4()
  lastDiscoveryAt = -Infinity
  currentPeerProof?.finish(false)
  clearInterval(keepaliveTimer); keepaliveTimer = null
  coveredCommandPlan = null
  peerNegotiated = false
  catalogSupported = false; lastVerifiedAt = 0; peerId = ''; identifiedPeer = false
  clearTimeout(catalogTimer); connectionProbe?.finish(false)
  clearTimeout(persistentPumpTimer); persistentEnabled = false; snapshotGenerations = false
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
        if (info.connected) setState('connected')
        else onNativeWatchState({ state: 'ready', connected: false })
      }
      return info
    } catch { return { raw: r.data } }
  } catch { return null }
}

export function watchDevice() { return device ? { ...device } : null }
export async function selectWatchDevice(id) {
  const previous = devices.read().selectedId
  if (previous === id) return { ok: true }
  if (previous && (trainingStore?.getState()?.active || hasPendingWatchWork() || catalogBusy || persistentPumping)) return { ok: false, reason: '请先结束训练并等待待保存记录处理完成，再切换手表' }
  if (!devices.select(id)) return { ok: false, reason: '尚未识别这块手表，请先在运动健康中连接并打开手表应用' }
  return resetWatchSelection()
}
async function resetWatchSelection(discover = true) {
  resetV4()
  currentPeerProof?.finish(false)
  selectionEpoch++; connectionProbe?.finish(false)
  lastVerifiedAt = 0; syncBase = null; sentSnapshots.clear(); commandStates.clear?.()
  coveredCommandPlan = null; persistentEnabled = false; snapshotGenerations = false; persistentHasWork = false; clearTimeout(persistentPumpTimer)
  clearTimeout(syncRetryTimer); pendingSync = null
  setCatalogStatus({ phase: latestCatalog ? 'queued' : 'idle', confirmedAt: 0, error: '' })
  clearTimeout(catalogTimer); catalogSupported = false; peerNegotiated = false
  emitConnection()
  scheduleInboxDrain()
  // Health owns the current physical route. A fresh discovery proves it, never a label switch.
  if (discover) await sendWatchEvent({ t: 'link_discover' })
  return { ok: true }
}
export async function openWatchHealth() {
  const p = await watchPlugin()
  try { await p.WatchRpc.openHealth(); return true } catch { return false }
}
export async function discoverWatchDevices() {
  await bindNative()
  if (state === 'off' || state === 'error') await connectWatch()
  // Device metadata can time out in Health. It must not delay app discovery.
  getWatchDeviceInfo().catch(() => {})
  return sendWatchEvent({ t: 'link_discover' })
}
export async function probeWatchConnection() {
  await bindNative()
  if (currentPeerProof) return currentPeerProof.promise
  if (state !== 'connected') getWatchDeviceInfo().catch(() => {})
  if (state !== 'connected' || !devices.read().selectedId || !targetReady()) { lastVerifiedAt = 0; emitConnection(); return false }
  if (connectionProbe) return connectionProbe.promise
  const id = 'probe:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8)
  let resolve
  const promise = new Promise(done => { resolve = done })
  const probe = { id, promise, finish(ok) {
    if (connectionProbe !== probe) return
    clearTimeout(probe.timer); connectionProbe = null; lastVerifiedAt = ok ? Date.now() : 0
    emitConnection(); resolve(ok)
  } }
  connectionProbe = probe
  probe.timer = setTimeout(() => probe.finish(false), 5000); probe.timer.unref?.()
  sendWatchEvent({ t: 'link_probe', requestId: id }).then(ok => { if (!ok) probe.finish(false) })
  return promise
}
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
  Promise.resolve().then(() => p.WatchRpc.sendEvent({ json: JSON.stringify(routed({ t: 'watch_diagnostics_request', requestId: id })) }))
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
      commitStatus, connection: watchConnection(), catalogStatus: watchCatalogStatus(),
      syncProtocol, syncCommitRev: syncBase?.commitRev || 0,
      ...(v4Link ? { stateQueryId: v4Link.id, stateQueryAttempts: v4Link.tries,
        watchStateSnapshot: v4Link.snapshot ? { active: v4Link.snapshot.active, sid: v4Link.snapshot.sid, rev: v4Link.snapshot.rev } : null } : {}),
      lastPublishedPlan, lastPlanClear }
  } catch (e) {
    return { lastError: e && e.message ? e.message : String(e) }
  }
}

/** Explicit paged metadata read, separate from training ACKs and durable queues. */
export function requestWatchLog() {
  if (watchLogRequest) return watchLogRequest
  watchLogRequest = readWatchLog().finally(() => { watchLogRequest = null })
  return watchLogRequest
}
async function readWatchLog() {
  await bindNative()
  const p = await watchPlugin()
  if (!p) return { status: 'unavailable', events: [] }
  const id = 'log-' + Date.now() + '-' + (++diagnosticSequence), events = []
  let offset = 0, header = null
  for (let page = 0; page < 64; page++) {
    let reply = null
    for (let attempt = 0; attempt < 2 && !reply; attempt++) {
      reply = await new Promise(resolve => {
        let timer
        const probe = { id, offset, finish(value) {
          if (watchLogProbe !== probe) return
          clearTimeout(timer); watchLogProbe = null; resolve(value)
        } }
        watchLogProbe = probe
        timer = setTimeout(() => probe.finish(null), 2500)
        Promise.resolve().then(() => p.WatchRpc.sendEvent({ json: JSON.stringify(routed({ t: 'watch_log_request', requestId: id, offset })) }))
          .then(r => { if (!r?.ok) probe.finish(null) }, () => probe.finish(null))
      })
    }
    if (!reply) return { status: events.length ? 'partial' : 'timeout', events, collectedAt: Date.now() }
    if (reply.status !== 'ok' || !Array.isArray(reply.events) || !Number.isSafeInteger(reply.total) || reply.total < 0 || reply.total > 128 ||
        !Number.isSafeInteger(reply.nextOffset) || reply.nextOffset !== offset + reply.events.length || reply.nextOffset > reply.total ||
        reply.events.length > 12 || reply.nextOffset === offset && offset < reply.total ||
        header && (header.boot !== reply.boot || header.total !== reply.total))
      return { status: 'invalid_reply', events, collectedAt: Date.now() }
    header ||= { watchVersion: String(reply.watchVersion || '').slice(0, 40), boot: String(reply.boot || '').slice(0, 32),
      storageFailed: !!reply.storageFailed, unflushed: !!reply.unflushed, total: reply.total,
      dropped: Number.isSafeInteger(reply.dropped) && reply.dropped >= 0 ? reply.dropped : null,
      droppedInteractions: Number.isSafeInteger(reply.droppedInteractions) && reply.droppedInteractions >= 0 ? reply.droppedInteractions : null }
    // Keep only scalar diagnostic fields, even if an incompatible peer sends extra data.
    for (const e of reply.events) {
      if (!e || typeof e !== 'object') return { status: 'invalid_reply', events }
      const clean = {}
      for (const key of ['at', 'stage', 'boot', 'count', 'firstAt', 'sid', 'eventId', 'entryInstanceId', 'setId', 'type', 'code', 'detail', 'version', 'status', 'phase', 'page', 'kind', 'reason', 'ex', 'set', 'rev', 'pending', 'rest', 'paused', 'ok', 'restUntil', 'restVersion', 'restId', 'attempts', 'receivedAt', 'nextAttemptAt', 'durable', 'readyState', 'connectionGeneration', 'headEventId', 'crownDirty', 'dotPending', 'duration', 'actionDuration', 'sampleCount', 'sessionAt', 'bytes', 'active', 'storageFailed', 'unflushed']) {
        const value = e[key]
        if (typeof value === 'string') clean[key] = value.slice(0, 80)
        else if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) clean[key] = value
      }
      events.push(clean)
    }
    offset = reply.nextOffset
    if (offset === reply.total) {
      const log = { ...header, status: 'received', collectedAt: Date.now(), events }
      phoneWatchLog.cacheWatch(log)
      return log
    }
  }
  return { status: 'partial', events, collectedAt: Date.now() }
}

// ---- 训练页 API：把今天的训练推给手表 ----

/** 训练开始时调用一次；训练中途计划变了（加/删动作）再调一次，手表整包热替换。 */
export async function pushPlanToWatch(workout, sid, profile = null, { automatic = false, legacyShortcut = false } = {}) {
  if (!MOBILE || !workout || syncProtocol === 4) return
  const planId = Date.now() + '-' + (++planSequence)
  latestPlan = { workout, sid: String(sid || ''), profile, planId, automatic, legacyShortcut, delivery: 'queued', receipt: null }
  lastPublishedPlan = { sid: latestPlan.sid, planId, exercises: workout.exercises?.length || 0, at: Date.now() }
  pendingPlan = latestPlan
  if (automatic && commandPlanCurrent(latestPlan) && coveredCommandPlan.key === planContentKey(workout, latestPlan.sid, profile)) {
    coverPlan(latestPlan, coveredCommandPlan.snapshot)
    if (syncBase?.wireHash === coveredCommandPlan.snapshot.wireHash) confirmSnapshotPlan(syncBase)
    return true
  }
  await bindNative()
  if (state === 'off' || state === 'error') await connectWatch()
  return flushPendingPlan()
}

export function clearWatchPlan(sid, reason = 'no_active_session', endedAt = Date.now()) {
  if (sid && latestPlan?.sid !== sid) return
  if (!sid || pendingSync?.snapshot.sid === sid) { clearTimeout(syncRetryTimer); pendingSync = null }
  if (v4Start && v4Start.plan.sid === latestPlan?.sid) {
    v4Start.plan.cancelled = true
    finishV4Plan(v4Start.plan, 'rejected', 'phone_session_changed')
  }
  if (latestPlan) lastPlanClear = { sid: latestPlan.sid, planId: latestPlan.planId, reason, at: Date.now() }
  if (syncProtocol !== 4 && latestPlan?.sid) pushEndedToWatch({ sid: latestPlan.sid, reason, endedAt })
  latestPlan = null
  pendingPlan = null
  coveredCommandPlan = null
}

async function flushPendingPlan() {
  if (outboundBarrier) return
  if (planPushInFlight || !pendingPlan) return
  if (state !== 'ready' && state !== 'connected') return
  if (!targetReady()) return
  // A training session must start from a complete, negotiated phone baseline.
  if ((trainingStore || syncProtocol === 4) && !peerNegotiated) return
  if (syncProtocol === 4 && (!v4Link?.snapshot || v4Start)) return
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
        if (next.coveredByCommand && commandPlanCurrent(next) && next.snapshotHash === coveredCommandPlan.snapshot.wireHash) continue
      } catch (error) {
        lastError = 'watch state save: ' + (error?.message || String(error))
        pendingPlan ||= next
        break
      }
      if (syncProtocol === 4) {
        const link = v4Link
        if (!v4Current(link) || !link.snapshot || v4Start) { pendingPlan ||= next; break }
        if (next.cancelled || next.automatic || next.legacyShortcut || !next.v4Link) continue
        await startV4Plan(next, link)
        if (v4Start) break
        continue
      }
      if (trainingStore && syncProtocol >= 3) {
        const snapshot = watchSnapshotOf(trainingStore.getState(), trainingStore.getTimer?.())
        if (!snapshot || snapshot.sid !== next.sid || latestPlan !== next) continue
        const sent = await pushSyncToWatch(snapshot)
        // hello reconciliation may supersede this send with the same/newer baseline.
        // That is not a transport failure and must not resurrect the old manual plan.
        const superseded = pendingSync?.snapshot.sid === snapshot.sid && pendingSync.snapshot.commitRev >= snapshot.commitRev
        if (!sent && !superseded && latestPlan === next && next.receipt?.status !== 'applied') { pendingPlan ||= next; break }
        continue
      }
      const msg = {
        t: 'plan',
        v: 2, protocolVersion: next.workout.protocolVersion || 1, weightUnit: next.workout.weightUnit || next.profile?.weightUnit || 'kg', structureRevision: next.workout.structureRevision,
        sid: next.sid || '',
        planId: next.planId,
        workout: next.workout.name || '',
        profile: next.profile || null,
        effortScale: next.workout.effortScale,
        capabilities: next.workout.capabilities,
        exercises: (next.workout.exercises || []).map(e => ({
          ...(e.id ? { id: e.id } : {}), entryInstanceId: e.entryInstanceId, setIds: e.setIds, weightUnit: e.weightUnit,
          name: e.name || '',
          lastTime: e.lastTime,
          ...(e.muscles ? { muscles: e.muscles } : {}),
          sets: e.sets || 1,
          reps: e.reps != null ? String(e.reps) : '',
          restSec: e.restSec || 60,
          weight: e.weight != null ? String(e.weight) : '',
        })),
      }
      let failed = false
      next.delivery = 'awaiting_receipt'
      try {
        const r = await p.WatchRpc.sendPlan({ json: JSON.stringify(routed(msg)) })
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
    if (syncProtocol === 4 && pendingPlan && v4Link?.snapshot && !v4Start && !outboundBarrier) {
      // A receipt can arrive while the SDK's send callback is still settling.
      const next = pendingPlan
      if (next !== latestPlan) pendingPlan = null
      else if (next.delivery !== 'queued') pendingPlan = null
    }
  }
}

async function sendWatchEvent(obj, stillCurrent = () => true) {
  if (!MOBILE || !obj || !stillCurrent()) return false
  if (obj.t === 'plan_catalog') return pushWatchCatalog(obj)
  if (!targetReady() && !['link_probe', 'link_discover'].includes(obj.t)) return false
  const epoch = selectionEpoch
  while (outboundBarrier && ['sync', 'sync_chunk', 'sync_delta', 'sync_begin', 'sync_inline'].includes(obj.t)) await outboundBarrier.promise
  const S = trainingStore?.getState(), A = S?.active
  const modern = syncProtocol === 4, link = v4Link
  const snapshotAck = obj.t === 'STATE_SNAPSHOT_ACK'
  const currentSnapshotAck = () => modern && v4Current(link) && obj.requestId === link.id && obj.sid === link.snapshotReceipt?.sid && obj.wireHash === link.snapshotReceipt?.wireHash
  if (snapshotAck && !currentSnapshotAck()) return false
  const sessionMessage = liveEdits.has(obj.t) || ['ended', 'session_close', 'session_presence'].includes(obj.t)
  const live = modern && sessionMessage
  if (modern && (legacySessionWire(obj) || (live && (!v4Current(link) || !v4MatchesSession(obj.sid))))) return false
  if (A?.watchPhoneSession && !['session_presence', 'START_SESSION', 'STATE_SNAPSHOT_ACK'].includes(obj.t) && obj.sid === String(A.watchSid || A.start)) obj = { ...obj, phoneSessionGeneration: A.watchSessionGeneration }
  if (A && obj.sid === String(A.watchSid || A.start) && Number.isInteger(obj.ex)) {
    const entry = A.entries[obj.ex], rows = entry?.sets.filter(r => !isWarmupRow(r)) || [], row = rows[obj.set - 1]
    obj = { ...obj, protocolVersion: modern ? 4 : 2, entryInstanceId: entry?.entryInstanceId, setId: row?.setId,
      weightUnit: S.unit || 'kg', structureRevision: A.structureRevision, at: obj.editAt || obj.at || Date.now() }
    if (['add_set','remove_set'].includes(obj.t)) obj.setIds = rows.map(r => r.setId)
    const field = obj.t === 'weight' ? 'weight' : obj.t === 'reps' ? 'reps' : ['set','unset'].includes(obj.t) ? 'done' : null
    if (field && row) trainingStore.update(s => { const a = s.active; if (!a || a.start !== A.start) return; a.watchVersions ||= {}; a.watchVersions[[entry.entryInstanceId || obj.ex, row.setId || obj.set, field].join(':')] = obj.at })
  }
  if (syncProtocol === 3 && trainingStore && obj.sid === String(A?.watchSid || A?.start) && liveEdits.has(obj.t)) {
    const snapshot = watchSnapshotOf(trainingStore.getState(), trainingStore.getTimer?.())
    if (snapshot) return pushSyncToWatch(snapshot)
  }
  await bindNative()
  const p = await watchPlugin()
  if (!p) return false
  try {
    if (!obj.t.startsWith('sync') && !['link_probe', 'link_discover', 'hello_ack', 'ack', 'committed', 'received', 'effort_ack', 'event_rejected', 'watch_start_ack', 'session_presence', 'STATE_QUERY', 'STATE_SNAPSHOT_ACK', 'START_SESSION'].includes(obj.t)) await trainingStore?.checkpoint?.()
    if (epoch !== selectionEpoch || !stillCurrent() || !targetReady() && !['link_probe', 'link_discover'].includes(obj.t)) return false
    if (sessionMessage && modern !== (syncProtocol === 4)) return false
    if (syncProtocol === 4 && (legacySessionWire(obj) || (live && (!v4Current(link) || !v4MatchesSession(obj.sid))))) return false
    if ((live && !v4Current(link)) || (snapshotAck && !currentSnapshotAck())) return false
    if (live && liveEdits.has(obj.t)) obj = { ...obj, protocolVersion: 4 }
    const r = await p.WatchRpc.sendEvent({ json: JSON.stringify(routed(obj)) })
    phoneWatchLog.record('send_result', { ...obj, ok: !!r?.ok })
    if (r && !r.ok) lastError = r.data || 'send event failed'
    return !!(r && r.ok)
  } catch (e) {
    phoneWatchLog.record('send_exception', { t: obj.t, sid: obj.sid, code: 'sdk_exception' })
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

async function continueOnV4Watch(snapshot, onStatus) {
  if (!watchConnection().canStartWorkout || !snapshot?.sid) {
    onStatus(v4Link?.snapshot?.active ? '手表已有训练进行中' : '手表未确认，请检查连接')
    return false
  }
  onStatus('请求已发，等待手表确认')
  const plan = { workout: { ...snapshot, name: snapshot.workout }, sid: snapshot.sid, profile: snapshot.profile,
    planId: Date.now() + '-' + (++planSequence), v4Link, automatic: false, delivery: 'queued', receipt: null }
  latestPlan = pendingPlan = plan
  lastPublishedPlan = { sid: plan.sid, planId: plan.planId, exercises: plan.workout.exercises?.length || 0, at: Date.now() }
  const receipt = await new Promise(resolve => {
    let timer
    const listener = (current, ev) => { if (current === plan) settle(ev) }
    const settle = ev => { receiptListeners.delete(listener); clearTimeout(timer); resolve(ev) }
    receiptListeners.add(listener)
    timer = setTimeout(() => {
      plan.cancelled = true
      if (pendingPlan === plan) pendingPlan = null
      if (v4Start?.plan === plan) {
        refreshV4(plan.v4Link)
        finishV4Plan(plan, 'rejected', 'watch_start_timeout')
      }
      settle(null)
    }, 10000)
    void flushPendingPlan()
  })
  const accepted = receipt?.status === 'applied'
  onStatus(accepted ? '手表已确认，可继续训练' : receipt?.reason === 'watch_active_session' ? '手表已有训练进行中' : '手表未确认，请检查连接')
  return accepted
}

export async function continueOnWatch(snapshot, onStatus) {
  if (syncProtocol === 4) return continueOnV4Watch(snapshot, onStatus)
  const available = await watchAvailable()
  if (!available.available) { onStatus('手表不可用：' + available.reason); return false }
  onStatus('正在连接手表')
  let timer, requestedPlan
  const confirmation = new Promise(resolve => {
    const listener = (plan, ev) => {
      if (plan === requestedPlan && plan === latestPlan && ev.sid === snapshot.sid && ['applied', 'retained'].includes(ev.status)) {
        clearTimeout(timer); receiptListeners.delete(listener); resolve(true)
      }
    }
    receiptListeners.add(listener)
    timer = setTimeout(() => { receiptListeners.delete(listener); resolve(false) }, 10000)
  })
  const result = await openWatchApp()
  if (result.ok) {
    onStatus('请求已发，等待手表确认')
    if (syncProtocol === 4) return continueOnV4Watch(snapshot, onStatus)
    const publication = pushPlanToWatch({ name: snapshot.workout, exercises: snapshot.exercises }, snapshot.sid, snapshot.profile, { legacyShortcut: true })
    requestedPlan = latestPlan
    await publication
    if (!trainingStore) await pushSyncToWatch(snapshot)
  }
  const confirmed = await confirmation
  onStatus(confirmed ? '手表已确认，可继续训练' : result.ok ? '手表未确认，请检查连接' : '手表未连接：' + (result.data || result.code))
  return confirmed
}

/** 重连后的权威快照。snapshot 由训练页从活动会话生成。 */
export async function pushSyncToWatch(snapshot) {
  if (!MOBILE || !snapshot) return false
  if (syncProtocol === 4) return false
  if (syncProtocol < 3) return sendWatchEvent({ ...snapshot, t: 'sync' })
  // Hash and delta against an acknowledged phone baseline, never against optimistic watch edits.
  const next = canonicalWire(snapshot)
  commandStates.remember(next)
  const plan = latestPlan?.sid === snapshot.sid ? latestPlan : null
  if (persistentEnabled) {
    if (!(await snapshotSender().enqueue(next))) return false
    if (plan) { plan.snapshotHash = next.wireHash; plan.delivery = 'awaiting_receipt' }
    if (plan && pendingPlan === plan) pendingPlan = null
    persistentHasWork = true; kickPersistent(); return true
  }
  if (plan) { plan.snapshotHash = next.wireHash; plan.delivery = 'awaiting_receipt' }
  sentSnapshots.set(next.wireHash, next)
  while (sentSnapshots.size > 8) sentSnapshots.delete(sentSnapshots.keys().next().value)
  clearTimeout(syncRetryTimer)
  pendingSync = { snapshot: next, tries: 0 }
  if (plan && pendingPlan === plan) pendingPlan = null
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
