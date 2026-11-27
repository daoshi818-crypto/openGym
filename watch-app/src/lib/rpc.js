import { persistentReceiver } from './persistent-transfer.js'
import { compactStartEvent, createEventWire, nextEventFrame, EVENT_FRAME_BYTES } from './event-wire.js'
import { selectReadyEvent } from './event-dependencies.js'
import { appTimeout, cancelAppTimeout, appInterval, cancelAppInterval } from './app-timers.js'
import { runtime } from './runtime.js'
import { readStored, writeStored, writeStoredConfirmed, writeStoredAtomic, retryStorage } from './persistence.js'
import { wireHash, wireBytes, acceptWireChunk, expandWireDelta } from './sync-wire.js'
// 手表侧传输层：vivo 智能终端 SDK（穿戴业务 Kit）。
//
// 手机是唯一权威；手机发起的会话在同 sid 的 App 在线租约内实时同步。
// App 离线时，手表仍本地交互，但不把离线编辑变成恢复后逐项重放的 Outbox。
// 手表独立发起训练与既有关闭日志仍保留耐久补传。
//
// 三条提交边界必须分清（这里是历史 bug 的来源）：
//  - 传输层 code:0 只代表收包；业务的“已保存”要等手机对同一 eventId 回 ack。
//  - session_close_ack 只代表关闭消息被处理，不代表本段热量已写进手机训练记录。
//  - 最终汇总先冻结进 close-journal（独立 key，可确认写盘），再入 outbox；重开手表时从
//    日志重建 outbox，而不是依赖打烊前是否调用过 sendEvent。
import interconnect from '@blueos.bluexlink.connectionManager'
import storage from '@blueos.storage.storage'
import { commitPhoneStart, loadState, buildSessionSummary, summaryEventOf, closeSession, save, stageSessionEvent, recoverLocalClose, commitWireSnapshot, reconcileCommittedSnapshot, phoneConflict, recordPhoneConflict, completePhoneConflict } from './session.js'
import { allocateEventIdentity, rememberEventAt } from './event-id.js'
import { confirmPhoneSession, applyPhonePresence, isPhoneSessionLive } from './session-presence.js'
import { pendingSummaries, pendingCloseEvents, pendingEntry, journalEntry, prepareClose, releaseCandidate, markPhase, markEntry, markDelivered } from './close-journal.js'
import { WATCH_VERSION } from './version.js'
import { recordDiagnostic, diagnosticLog, diagnosticLogPage } from './diagnostic-log.js'

const PHONE_PACKAGE = 'ch.duartesantos.opengym'
const PHONE_FINGERPRINT = '8bf64970048540fe913005d05becee1ecad819e7171518dabcd15817301a0149'
const K_OUTBOX = 'rpc_outbox'
const WRITE_TIMEOUT_MS = 5000
const SEND_GAP_MS = 120
const REPLAY_BATCH = 2
const rpcState = () => runtime().rpc ||= { ...{"connect":null,"handlers":{},"connected":false,"outbox":[],"sending":false,"retryTimer":null,"lastEventAt":0,"initialized":false,"connectionGeneration":0,"sendingTimer":null,"writeBusy":false,"writeDirty":false,"persistFailed":false}, durable: new Set(), lifecycleQueue: null }
const isPhoneLedEvent = event => !!event?.phoneLed || journalEntry(event?.sid)?.closeEvent?.phoneLed === true


// Metadata only; the independent bounded journal never enters training storage/outbox.
function trace(stage, msg = {}, error = null, code = null, meta = {}) {
  try {
    const r = rpcState(), head = r.outbox[0]?.msg
    const text = value => value == null ? '' : String(value).slice(0, 80)
    const entry = { at: Date.now(), stage, type: text(msg.t),
      ...(error != null || code != null ? { code: text(code ?? error?.code) } : {}),
      ...(meta.bytes != null ? { bytes: meta.bytes } : {}), sid: text(msg.sid),
      eventId: text(msg.eventId), pending: r.outbox.length }
    if (head) entry.headEventId = text(head.eventId)
    if (error != null) {
      entry.code = text(code ?? error.code)
      entry.detail = text(error.message || error.data || (typeof error === 'string' ? error : ''))
      if (error.status != null) entry.status = typeof error.status === 'number' ? error.status : text(error.status)
    }
    const events = r.trace ||= []
    events.push(entry)
    if (events.length > 40) events.splice(0, events.length - 40)
    recordDiagnostic(stage, { ...entry, status: msg.status, attempts: meta.attempts, receivedAt: meta.receivedAt,
      nextAttemptAt: meta.nextAttemptAt, durable: meta.durable, readyState: meta.readyState,
      connectionGeneration: meta.connectionGeneration, headEventId: entry.headEventId })
    console.info?.('[watch-rpc] ' + JSON.stringify(entry))
  } catch { /* diagnostic failure must not affect delivery */ }
}

export function transportDiagnostics(limit = 40) {
  const r = rpcState(), head = r.outbox[0]
  return { connected: !!r.connected, readyState: r.lastReadyState ?? null,
    peerProtocol: r.peerProtocol || 0, pending: r.outbox.length,
    phonePending: r.outbox.filter(e => e.receivedAt).length,
    storageFailed: !!r.persistFailed,
    head: head ? { type: head.msg.t, sid: head.msg.sid, eventId: head.msg.eventId,
      durable: r.durable.has(head.msg.eventId), attempts: head.attempts || 0,
      receivedAt: head.receivedAt || 0, nextAttemptAt: head.nextAttemptAt || 0 } : null,
    events: (r.trace || []).slice(-Math.max(1, Math.min(40, limit))).map(e => ({ ...e })) }
}

function initialize() {
  if (runtime().destroyed) return
  if (rpcState().initialized) return
  rpcState().outbox = loadOutbox()
  // 已冻结的最终汇总可能只存在日志里（关闭时 outbox 还没写成功）：先并进来。
  const decisions = readStored('event_decisions') || {}
  for (const event of pendingCloseEvents()) if (!decisions[event.eventId]) enqueue(event, { persistOutbox: false })
  for (const entry of pendingSummaries()) enqueue(entry.summaryEvent, { persistOutbox: false })
  markDurable()
  rpcState().initialized = true
  if (typeof recoverLocalClose === 'function') serial(async () => { await recoverLocalClose(); replayPendingEvents(); flush() })
}

// 日志里的汇总也已经是可靠数据：把它连同 outbox 现有内容一起视为可发送。
function markDurable(batch = rpcState().outbox) {
  const ids = new Set(batch.map(e => e.msg.eventId))
  for (const event of pendingCloseEvents()) ids.add(event.eventId)
  for (const entry of pendingSummaries()) if (entry.summaryEvent?.eventId) ids.add(entry.summaryEvent.eventId)
  rpcState().durable = ids
}

function enqueue(msg, { persistOutbox = true } = {}) {
  if (!msg || !msg.eventId || runtime().destroyed) return false
  if (rpcState().outbox.some(e => e.msg.eventId === msg.eventId)) return true
  const entry = { at: msg.at || Date.now(), msg, sent: false }
  if (rpcState().outbox.length >= 4096 || wireBytes(JSON.stringify([...rpcState().outbox, entry])) > 2 * 1024 * 1024) {
    const r = rpcState()
    r.lastEnqueueCapacityRejected = true
    if (!r.capacityErrorReported) {
      r.capacityErrorReported = true
      r.handlers.onError?.({ code: 'outbox_capacity' })
    }
    return false
  }
  rpcState().outbox.push(entry)
  rpcState().lastEnqueueCapacityRejected = false
  rpcState().capacityErrorReported = false
  rpcState().replayCapacityBlockedAt = null
  trace('enqueue', msg)
  if (persistOutbox) persist()
  return true
}

function persist() {
  if (runtime().destroyed) return
  const r = rpcState()
  r.writeDirty = true
  if (r.writeBusy) return
  r.writeBusy = true; r.writeDirty = false
  const value = JSON.parse(JSON.stringify(r.outbox))
  let settled = false, timer = null
  const done = ok => {
    if (settled) return
    settled = true
    try { if (timer != null) cancelAppTimeout(timer) } catch { /* 无定时器 */ }
    r.writeBusy = false
    if (runtime().destroyed) return
    if (ok) {
      r.persistFailed = false
      markDurable(value)
      if (r.writeDirty) persist()
      else flush()
    } else {
      r.persistFailed = true; r.writeDirty = true
      r.handlers.onError?.({ code: 'outbox_storage' })
    }
  }
  try {
    // 回调丢失不能把写链永久卡死：超时按失败处理，flush() 的定时器会重试。
    timer = appTimeout(() => done(false), WRITE_TIMEOUT_MS)
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
  const s = loadState('rpc')
  rpcState().installationId ||= allocateEventIdentity('', 'link').installationId
  sendControl({
    t: 'hello',
    linkEpoch: rpcState().linkEpoch || (rpcState().linkEpoch = Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10)),
    installationId: rpcState().installationId,
    helloId: rpcState().linkEpoch, watchVersion: WATCH_VERSION, protocolVersion: 4, stableIds: true,
    capabilities: { stateSnapshot: true, sessionConflict: true, inlineSnapshots: true, deviceSelection: true, snapshotGenerations: true, narrowDependencies: true, causalFrontier: true, sessionPresence: true, durableCommit: true, snapshotChunks: true, deltas: true, dependencyEvents: true, selectiveChunkAck: true, persistentTransfers: true, commandReceipts: true, watchEventChunks: true },
    receipts: true,
    sid: s.sid || '',
    rev: s.rev || 0,
    commitRev: s.commitRev || 0, sessionEpoch: s.sid || '',
    pending: rpcState().outbox.length,
    active: !!s.active,
    pendingStart: !!s.pendingStart,
  })
}

function resetPeer(r) {
  runtime().phoneSessionPresence = null
  r.peerProtocol = 0; r.v4Ready = false; r.controls = []; r.transfers = {}; r.lastPhoneAt = 0
  r.liveLatest = Object.create(null)
  cancelAppTimeout(r.liveEventTimer); r.liveEventTimer = null; r.liveEventSending = null
  r.liveEventIds = []
}

const V4_EVENT_FIELDS = ['t', 'sid', 'eventId', 'rev', 'at', 'source', 'phoneLed', 'protocolVersion', 'phoneSessionGeneration']
const V4_EVENT_TARGET = ['entryInstanceId', 'setId', 'ex', 'set']
const V4_EVENT_PAYLOAD = Object.assign(Object.create(null), {
  set: V4_EVENT_TARGET,
  unset: V4_EVENT_TARGET,
  focus: V4_EVENT_TARGET,
  weight: [...V4_EVENT_TARGET, 'weight', 'weightUnit'],
  reps: [...V4_EVENT_TARGET, 'reps'],
  add_set: ['entryInstanceId', 'ex', 'sets', 'newSetIds', 'structureRevision', 'weight', 'reps', 'weightUnit'],
  remove_set: ['entryInstanceId', 'ex', 'sets', 'removedSetIds', 'structureRevision'],
  effort: [...V4_EVENT_TARGET, 'scale', 'value', 'clear', 'effortVersion', 'baseEffortVersion'],
  rest: ['restId', 'startedAt', 'endsAt', 'totalSec', 'leftSec', 'paused', 'seq'],
  pause: ['paused', 'seq'],
  session_close: ['disposition', 'closedAt'],
})

function sendLiveEvent(event) {
  const r = rpcState()
  if (!r.v4Ready || !r.connected || event.liveGeneration !== r.connectionGeneration || !isPhoneSessionLive({ sid: event.sid }, runtime().phoneSessionPresence)) return false
  // Completion is an edge: only its stable target and revision cross the wire.
  const fields = [...V4_EVENT_FIELDS, ...(V4_EVENT_PAYLOAD[event.t] || [])]
  const msg = Object.fromEntries(fields.filter(key => event[key] !== undefined).map(key => [key, event[key]]))
  return sendControl(msg)
}

const legacyPhoneEditTypes = new Set(['weight', 'reps', 'set', 'unset', 'effort', 'rest', 'pause', 'focus', 'add_set', 'remove_set'])
function discardLegacyPhoneEditsForV4() {
  const r = rpcState(), state = loadState('replay')
  const stale = event => event && event.protocolVersion !== 4 && legacyPhoneEditTypes.has(event.t) &&
    (event.phoneLed === true || state.sessionOrigin === 'phone' && event.sid === state.sid)
  const staleIds = new Set(r.outbox.filter(item => stale(item.msg)).map(item => item.msg.eventId).filter(Boolean))
  const before = r.outbox.length
  r.outbox = r.outbox.filter(item => !stale(item.msg))
  const removed = before - r.outbox.length
  if (removed) {
    persist()
    trace('v4_legacy_edits_discarded', { count: removed })
  }
  const pending = state.pendingEdits || []
  const kept = pending.filter(event => !stale(event) && !staleIds.has(event.eventId))
  if (kept.length !== pending.length) {
    state.pendingEdits = kept
    save(state)
  }
  return removed
}

function handleV4(msg) {
  const r = rpcState(), generation = r.connectionGeneration
  if (msg.t === 'STATE_SNAPSHOT_ACK') return true
  if (msg.t === 'STATE_QUERY') {
    if (typeof msg.requestId !== 'string' || !msg.requestId || msg.requestId.length > 128) return true
    r.peerProtocol = 4; r.v4Ready = true
    serial(() => {
      if (!r.connected || r.connectionGeneration !== generation) return
      discardLegacyPhoneEditsForV4()
      const s = loadState(), ex = s.workout?.exercises?.[s.exIdx], row = s.workout?.rows?.[s.exIdx]?.[s.setIdx]
      if (s.active && s.sessionOrigin === 'phone') confirmPhoneSession(runtime(), s.sid, s.phoneSession?.generation || s.sid)
      const closed = readStored('closed_sessions') || [], last = closed[closed.length - 1], entry = last && readStored('watch_close_journal_v1', { entries: { [last]: { closedAt: true, disposition: true } } })?.entries?.[last]
      const marker = readStored('phone_terminal_v4')
      const terminal = marker && (!entry || marker.closedAt >= entry.closedAt) ? marker : entry ? { sid: last, disposition: entry.disposition, closedAt: entry.closedAt || 0 } : null
      const value = { t: 'STATE_SNAPSHOT', protocolVersion: 4, requestId: msg.requestId, sid: s.active ? s.sid : terminal?.sid || last || '', active: !!s.active,
        terminal, workout: s.workout?.name || '', exercises: ex ? [{ id: ex.id, entryInstanceId: ex.entryInstanceId, name: ex.name }] : [], rows: row ? [[row]] : [],
        exIdx: s.exIdx || 0, setIdx: s.setIdx || 0, startedAt: s.startedAt || 0, pausedAt: s.pausedAt || 0, pausedMs: s.pausedMs || 0,
        restUntil: s.restUntil || 0, restTargetSec: s.restTargetSec || 0, restLeftSec: s.restLeftSec || 0,
        rev: Math.max(s.rev || 0, r.liveRevisionSid === s.sid ? r.liveRevision || 0 : 0), commitRev: s.commitRev || 0, structureRevision: s.structureRevision || null }
      sendControl({ ...value, wireHash: wireHash(value) })
    }); return true
  }
  if (msg.t === 'START_SESSION') {
    const reply = { t: 'SESSION_ACCEPTED', protocolVersion: 4, sid: msg.sid || '', requestId: msg.requestId || '' }
    if (!r.v4Ready || msg.protocolVersion !== 4) { sendControl({ ...reply, status: 'rejected', reason: 'query_required' }); return true }
    serial(async () => {
      if (!r.connected || r.connectionGeneration !== generation) return
      const result = await commitPhoneStart(msg)
      if (r.connected && r.connectionGeneration === generation) {
        if (result.status === 'accepted') confirmPhoneSession(runtime(), msg.sid, msg.sessionGeneration || msg.sid)
        sendControl({ ...reply, status: result.status, ...(result.reason ? { reason: result.reason } : {}) })
      }
      if (result.created) r.handlers.onPhoneStart?.()
    }); return true
  }
  return false
}

function resumeConnection() {
  const r = rpcState()
  if (r.connected || !r.connect) return
  resetPeer(r)
  r.connected = true
  r.lastPhoneAt = 0
  r.peerCapabilities = {} // Every connection must negotiate extension features again.
  r.nextProbeAt = 0; r.probeAttempts = 0
  r.connectionGeneration++; r.sending = false; cancelAppTimeout(r.sendingTimer)
  r.linkEpoch = ''
  r.outbox.forEach(e => { e.sent = false; if (!e.lastSendFailed) e.nextAttemptAt = 0 })
  trace('connection_resumed')
  r.handlers.onState?.(true)
  sendHello()
  flush()
}

// 错误/息屏恢复时固件不一定再次触发 onOpen。重试队列也检查真实状态，
// 否则一次 onError 就会令上行永久停在 connected=false，虽然下行仍然到达。
function probeConnection() {
  const r = rpcState(), connection = r.connect
  if (!connection || r.connected || Date.now() < (r.nextProbeAt || 0) || r.readyProbe && Date.now() - r.readyProbe.at < 6000) return
  const token = { at: Date.now(), generation: r.connectionGeneration }
  r.readyProbe = token
  r.nextProbeAt = Date.now() + Math.min(60000, 4000 * Math.pow(2, Math.min(4, r.probeAttempts || 0)))
  r.probeAttempts = (r.probeAttempts || 0) + 1
  const done = data => {
    if (r.readyProbe !== token) return
    r.readyProbe = null
    if (r.connect !== connection || r.connectionGeneration !== token.generation) return
    r.lastReadyState = data?.status ?? null
    trace('ready_state', {}, data)
    if (data?.status === 1) resumeConnection()
  }
  try { connection.getReadyState({ success: done, fail: (error, code) => { trace('ready_fail', {}, error, code); done(null) } }) }
  catch (error) { trace('ready_exception', {}, error); done(null) }
}

// One app-owned timer, never recursive draining from an SDK callback. The minimum gap
// also applies to clicks/persistence callbacks that ask to flush during this window.
function scheduleFlush(delay = SEND_GAP_MS) {
  const r = rpcState(), at = Date.now() + Math.max(1, delay)
  if (r.flushTimer != null && r.flushAt <= at) return
  cancelAppTimeout(r.flushTimer)
  r.flushAt = at
  r.flushTimer = appTimeout(() => { r.flushTimer = null; flush() }, Math.max(1, at - Date.now()))
}

// Session edits and close journals are already durable. Replay two per UI turn,
// including closes created while this App transport was already initialized.
export function replayPendingEvents() {
  if (runtime().destroyed || rpcState().stopped) return
  const r = rpcState()
  if (runtime().sessionDraft || !r.peerProtocol || r.peerProtocol >= 4) return
  initialize()
  // A failed capacity insertion stays journaled. Retry only after the outbox
  // changes or the transport reconnects, avoiding replay/flush retry loops.
  if (r.replayCapacityBlockedAt != null) {
    if (r.outbox.length === r.replayCapacityBlockedAt) return
    r.replayCapacityBlockedAt = null
  }
  let state
  try { state = loadState('replay') }
  catch (error) {
    // A transient storage read must not escape the UI/SDK callback. No replay
    // lock has been acquired yet, so a later wake can retry from durable state.
    trace('replay_failed', { reason: String(error?.message || error) })
    return
  }
  const phoneSession = state.sessionOrigin === 'phone' && state.phoneSession?.sid === state.sid ? state.phoneSession : null
  if (phoneSession && !isPhoneSessionLive(phoneSession, runtime().phoneSessionPresence)) return
  if (r.replaying) return
  r.replaying = true
  const step = () => {
    r.replayTimer = null
    try {
      const queued = new Set(r.outbox.map(e => e.msg.eventId))
      const decisions = readStored('event_decisions') || {}, seen = new Set()
      const rawCandidates = [...(state.pendingEdits || []), ...pendingCloseEvents(),
        ...pendingSummaries().map(e => e.summaryEvent)]
      const presence = runtime().phoneSessionPresence
      const candidates = rawCandidates.filter(e => {
        if (isPhoneLedEvent(e)) {
          if (e.t === 'session_close') return e.sid === presence?.sid && isPhoneSessionLive({ sid: e.sid }, presence)
          return state.active && state.sid === e.sid && e.phoneSessionGeneration != null &&
            e.phoneSessionGeneration === presence?.generation && isPhoneSessionLive({ sid: e.sid }, presence)
        }
        if (phoneSession) return e.sid === phoneSession.sid && e.phoneSessionGeneration != null &&
          e.phoneSessionGeneration === presence?.generation && isPhoneSessionLive(phoneSession, presence)
        return true
      })
      const missing = candidates.filter(e => {
        if (e.committedRev != null || decisions[e.eventId] || queued.has(e.eventId) || seen.has(e.eventId)) return false
        seen.add(e.eventId); return true
      })
      let accepted = 0
      for (const event of missing.slice(0, REPLAY_BATCH)) {
        r.lastEnqueueCapacityRejected = false
        if (sendEvent(event)) accepted++
        else {
          if (r.lastEnqueueCapacityRejected) r.replayCapacityBlockedAt = r.outbox.length
          break
        }
      }
      if (r.replayCapacityBlockedAt != null) { r.replaying = false; return }
      // Capacity/storage failures retain the journal. Let the normal transport
      // retry/receipt wake replay instead of spinning every 120ms without progress.
      if (missing.length > REPLAY_BATCH && accepted > 0) r.replayTimer = appTimeout(step, SEND_GAP_MS)
      else r.replaying = false
    } catch (error) {
      // Leave durable session edits intact and allow the next UI replay to retry.
      r.replaying = false
      trace('replay_failed', { reason: String(error?.message || error) })
    }
  }
  step()
}

export async function resumePhoneConflict() {
  const result = await completePhoneConflict()
  if (result.resolved) {
    rpcState().handlers.onConflictResolved?.()
    sendControl({ t: 'sync_request', reason: 'watch_conflict_closed' })
  }
  return result
}
export function canResolvePhoneConflict() { return rpcState().peerProtocol >= 3 && rpcState().peerCapabilities?.sessionConflict === true }

function flush() {
  if (runtime().destroyed || rpcState().stopped) return
  initialize()
  const decisions = rpcState().peerProtocol > 0 && rpcState().peerProtocol < 4 ? readStored('event_decisions') || {} : {}
  // A normal send/ACK turn must not clone the active workout just to discover
  // that its already queued edits are present. Only missing journals wake replay.
  const missing = event => !decisions[event.eventId] && !rpcState().outbox.some(e => e.msg.eventId === event.eventId)
  if (rpcState().peerProtocol > 0 && rpcState().peerProtocol < 4 && !rpcState().replaying && (pendingCloseEvents().some(missing) || pendingSummaries().some(e => missing(e.summaryEvent)))) replayPendingEvents()
  const expired = runtime().expiredEvents || []
  if (expired.length) { runtime().expiredEvents = []; for (const event of expired) sendEvent(event) }
  retryStorage()
  if (rpcState().persistFailed && !rpcState().writeBusy) persist()
  if (!rpcState().connected) { probeConnection(); return }
  if (!rpcState().connected || !rpcState().connect || rpcState().sending) return
  if (rpcState().v4Ready && dispatchNextLiveLatest()) return
  if (!(rpcState().controls || []).some(e => Date.now() >= (e.nextAttemptAt || 0)) && Date.now() < (rpcState().nextSendAt || 0)) { scheduleFlush(rpcState().nextSendAt - Date.now()); return }
  const r = rpcState()
  if (r.v4Ready && !isPhoneSessionLive(runtime().phoneSessionPresence, runtime().phoneSessionPresence)) r.controls = (r.controls || []).filter(e => !e.live)
  let control = (r.controls ||= []).find(e => Date.now() >= (e.nextAttemptAt || 0))
  const current = loadState('rpc'), phoneSession = current.phoneSession
  // Legacy/outstanding phone-led events are retained in place for history and
  // diagnostics, but never replayed into a reattached phone session. Only events
  // created under the currently confirmed same-sid lease can enter the send pump.
  const phoneLed = current.sessionOrigin === 'phone' && phoneSession?.sid === current.sid
  const presence = runtime().phoneSessionPresence
  const presenceLive = phoneLed && isPhoneSessionLive(phoneSession, presence)
  const sendableOutbox = !r.peerProtocol || r.peerProtocol >= 4 ? [] : r.outbox.filter(e => {
    if (isPhoneLedEvent(e.msg)) {
      if (e.msg.t === 'session_close') return e.msg.sid === presence?.sid && isPhoneSessionLive({ sid: e.msg.sid }, presence)
      return current.active && current.sid === e.msg.sid && e.msg.phoneSessionGeneration != null &&
        e.msg.phoneSessionGeneration === presence?.generation && isPhoneSessionLive({ sid: e.msg.sid }, presence)
    }
    if (phoneLed) return presenceLive && e.msg.sid === phoneSession.sid && e.msg.phoneSessionGeneration != null && e.msg.phoneSessionGeneration === presence.generation
    return true
  })
  const eligible = e => r.durable.has(e.msg.eventId) && Date.now() >= (e.nextAttemptAt || 0) && (!e.sent || Date.now() >= (e.nextAttemptAt || (e.sentAt || 0) + 4000))
  // Frozen extension intentions require head confirmation on old peers. Original v2
  // payloads retain their established FIFO send-order pipeline and exact ACK semantics.
  const business = r.peerProtocol >= 3 || sendableOutbox[0]?.msg.dependencyEvents
    ? selectReadyEvent(sendableOutbox, r.durable, decisions, Date.now(), r.peerProtocol >= 3 && !!r.peerCapabilities?.dependencyEvents)
    : (sendableOutbox.find(e => !e.sent && eligible(e)) || sendableOutbox.find(eligible))
  if ((r.controlBurst || 0) >= 8 && business) control = null
  const next = control || business
  if (!next) {
    const waiting = [...r.controls, ...sendableOutbox.filter(e => r.durable.has(e.msg.eventId))]
    if (waiting.length) scheduleFlush(Math.max(SEND_GAP_MS, Math.min(4000, ...waiting.map(e => Math.max(1000, (e.nextAttemptAt || 0) - Date.now())))))
    return
  }
  r.controlBurst = control ? (r.controlBurst || 0) + 1 : 0
  const token = { generation: rpcState().connectionGeneration, eventId: next.msg.eventId, control: control ? next : null }
  rpcState().sending = token
  if (!control) rpcState().nextSendAt = Date.now() + SEND_GAP_MS
  const release = () => { if (rpcState().sending !== token || token.generation !== rpcState().connectionGeneration) return false; cancelAppTimeout(rpcState().sendingTimer); rpcState().sending = false; return true }
  const backoff = () => {
    if (control?.live || control && r.v4Ready && ++control.failures >= 2) { r.controls = r.controls.filter(e => e !== control); return }
    if (!control) r.eventWire = null // Retry the entire event; partial SDK sends are never receipts.
    next.sent = true; next.lastSendFailed = true; next.attempts = (next.attempts || 0) + 1
    next.nextAttemptAt = Date.now() + Math.min(60000, 2000 * Math.pow(2, Math.min(5, next.attempts - 1)))
    if (!control) persist()
  }
  rpcState().sendingTimer = appTimeout(() => { if (release()) { trace('send_timeout', next.msg); backoff(); scheduleFlush() } }, 6000)
  try {
    // Transport proof describes the base actually applied NOW. It must not
    // rewrite the frozen event's causal baseCommitRev or durable identity.
    let data = compactStartEvent(next.msg)
    let frame = null
    if (!control && r.peerCapabilities?.watchEventChunks && wireBytes(JSON.stringify(data)) > EVENT_FRAME_BYTES) {
      if (!r.eventWire || r.eventWire.eventId !== next.msg.eventId || r.eventWire.generation !== r.connectionGeneration)
        // Optional applied-state transport proof may change during a retry. The
        // fragmented body must remain the SAME frozen event across all attempts.
        r.eventWire = { ...createEventWire(next.msg), generation: r.connectionGeneration }
      frame = nextEventFrame(r.eventWire)
      data = frame.data
    } else if (!control && r.peerCapabilities?.commandReceipts) {
      const state = loadState('rpc')
      const base = state.active && state.sid === next.msg.sid ? state.syncBase : null
      if (base?.wireHash) data = { ...data, appliedHash: base.wireHash, appliedRev: base.commitRev }
    }
    if (r.peerCapabilities?.deviceSelection && r.installationId) data = { ...data, sourceInstallationId: r.installationId }
    const bytes = wireBytes(JSON.stringify(data))
    trace('send_attempt', next.msg, null, null, { bytes, attempts: next.attempts || 0, receivedAt: next.receivedAt || 0,
      nextAttemptAt: next.nextAttemptAt || 0, durable: rpcState().durable.has(next.msg.eventId) })
    rpcState().connect.send({ data,
      success: () => {
        if (!release()) return
        trace('send_success', next.msg, null, null, { bytes, attempts: next.attempts || 0, receivedAt: next.receivedAt || 0,
        nextAttemptAt: next.nextAttemptAt || 0, durable: rpcState().durable.has(next.msg.eventId) })
        if (control) { r.controls = r.controls.filter(e => e !== control); scheduleFlush(); return }
        if (frame && r.eventWire) {
          r.eventWire.offset = frame.end
          if (frame.end < r.eventWire.text.length) { scheduleFlush(); return }
          r.eventWire = null
        }
        const item = rpcState().outbox.find(e => e.msg.eventId === token.eventId)
        if (item) { item.lastSendFailed = false; item.sent = true; item.sentAt = Date.now(); item.attempts = (item.attempts || 0) + 1; item.nextAttemptAt = Date.now() + Math.min(60000, 4000 * Math.pow(2, Math.min(4, item.attempts - 1))) + Math.floor(Math.random() * 1000) }
        scheduleFlush()
      },
      fail: (error, code) => { if (!release()) return; trace('send_fail', next.msg, error, code, { bytes, attempts: next.attempts || 0, receivedAt: next.receivedAt || 0,
        nextAttemptAt: next.nextAttemptAt || 0, durable: rpcState().durable.has(next.msg.eventId) }); backoff(); scheduleFlush() }
    })
  } catch (error) { if (release()) { trace('send_exception', next.msg, error); backoff(); scheduleFlush() } }
}

// 精确回执：eventId 匹配时只删那一条。日志里的最终汇总要先持久化 delivered，
// 再清 outbox；顺序反了，重启会从日志重建一条已确认的消息。
function ackEvent(upto, eventId) {
  if (!eventId) return // No cumulative timestamp/sequence acknowledgement, including legacy peers.
  initialize()
  const before = rpcState().outbox.length
  if (eventId) {
    const entry = summaryForEvent(eventId)
    if (entry) {
      const drop = () => {
        rpcState().outbox = rpcState().outbox.filter(e => e.msg.eventId !== eventId)
        if (rpcState().outbox.length !== before) {
          rpcState().replayCapacityBlockedAt = null
          persist()
        }
      }
      const p = markDelivered(entry.sid)
      if (p && typeof p.then === 'function') p.then(ok => { if (ok) drop() }, () => {})
      else drop()
      return
    }
    rpcState().outbox = rpcState().outbox.filter(e => e.msg.eventId !== eventId)
  }
  if (rpcState().outbox.length !== before) {
    rpcState().replayCapacityBlockedAt = null
    persist()
  }
}

function decisionPins() {
  return new Set([...rpcState().outbox.map(e => e.msg), ...(loadState().pendingEdits || []), ...pendingCloseEvents(), ...pendingSummaries().map(e => e.summaryEvent)].flatMap(e => e?.dependsOn || []))
}

async function acceptLegacyAck(eventId) {
  const event = rpcState().outbox.find(e => e.msg.eventId === eventId)?.msg
  if (!event) return
  const decision = await writeStoredAtomic('event_decisions', value => {
    const decisions = value || {}
    decisions[eventId] = { sid: event.sid, status: 'applied', legacy: true }
    const pins = decisionPins()
    let size = Object.keys(decisions).length
    for (const id of Object.keys(decisions)) { if (size <= 4096) break; if (!pins.has(id)) { delete decisions[id]; size-- } }
    if (size > 4096) throw new Error('event_decisions_full')
    return decisions
  })
  if (!decision.ok) return
  const saved = await writeStoredAtomic('session_state', state => {
    if (state) {
      state.pendingEdits = (state.pendingEdits || []).filter(e => e.eventId !== eventId)
      if (event.t === 'watch_start' && state.sid === event.sid) state.pendingStart = false
    }
    return state || {}
  })
  if (!saved.ok) return
  const journal = journalEntry(event.sid)
  if (journal?.localClose && event.t === 'session_close' && !(await markEntry(event.sid, { closeCommitted: true }))) return
  ackEvent(null, eventId)
  flush()
}

function summaryForEvent(eventId) {
  for (const entry of pendingSummaries()) if (entry.summaryEvent && entry.summaryEvent.eventId === eventId) return entry
  return null
}

// 关闭/结束两类消息串行消费：乱序或重复到达时只会得到同一条冻结汇总，也不会并发建两份日志。
function serial(task, queue = 'lifecycleQueue') {
  const prev = rpcState()[queue] || Promise.resolve()
  const next = prev.then(() => { if (runtime().destroyed || rpcState().stopped) return null; try { return task() } catch (e) { return null } }).catch(() => null)
  rpcState()[queue] = next
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
  runtime().sendLiveEvent = sendLiveEvent
  if (runtime().destroyed) return
  rpcState().stopped = false
  rpcState().stop = stopServer
  if (h) rpcState().handlers = h
  const subscriber = rpcState()
  // Destroyed Pages must release their UI closures without closing App transport.
  // An older Page cannot detach a newer subscriber installed during navigation.
  const detach = () => { if (h && subscriber.handlers === h) subscriber.handlers = {} }
  if (!rpcState().retryTimer) rpcState().retryTimer = appInterval(flush, 4000)
  if (!rpcState().connect) {
    initialize()
    try {
      rpcState().connect = interconnect.instance({ package: PHONE_PACKAGE, fingerprint: PHONE_FINGERPRINT })
    } catch (e) {
      rpcState().connect = null
      trace('connection_exception', {}, e)
      if (rpcState().handlers.onError) rpcState().handlers.onError({ code: 1000, data: String(e) })
      return detach
    }
  }

  // Page changes only replace subscribers. Rebinding/hello here restarted full sync
  // on every onShow even when the connection was already active.
  if (rpcState().boundConnection === rpcState().connect) return detach
  rpcState().boundConnection = rpcState().connect
  const connection = rpcState().connect, owner = rpcState(), callbacks = {}
  const binding = {}; owner.callbackBinding = binding
  // 页面模块共享 application runtime；当前页面只接管 UI 回调。
  callbacks.onOpen = () => {
    resetPeer(rpcState())
    rpcState().connected = true
    rpcState().lastPhoneAt = 0
    rpcState().peerCapabilities = {}
    trace('connection_open')
    rpcState().connectionGeneration++; rpcState().sending = false; cancelAppTimeout(rpcState().sendingTimer)
    rpcState().replayCapacityBlockedAt = null
    rpcState().linkEpoch = ''
    initialize()
    rpcState().nextSendAt = 0
    rpcState().outbox.forEach(e => { e.sent = false; if (!e.lastSendFailed) e.nextAttemptAt = 0 })
    sendHello()
    persist()
    if (rpcState().handlers.onState) rpcState().handlers.onState(true)
    flush()
  }
  callbacks.onClose = () => {
    resetPeer(rpcState()); trace('connection_close')
    rpcState().connected = false
    rpcState().connectionGeneration++; rpcState().sending = false; cancelAppTimeout(rpcState().sendingTimer)
    if (rpcState().handlers.onState) rpcState().handlers.onState(false)
  }
  callbacks.onError = (err) => {
    resetPeer(rpcState()); trace('connection_error', {}, err)
    rpcState().connected = false
    rpcState().connectionGeneration++; rpcState().sending = false; cancelAppTimeout(rpcState().sendingTimer)
    if (rpcState().handlers.onState) rpcState().handlers.onState(false)
    if (rpcState().handlers.onError) rpcState().handlers.onError(err || {})
  }
  callbacks.onMessage = (data) => {
    const decoded = parseMessage(data)
    let msg = decoded.message
    if (!msg) {
      sendControl({ t: 'watch_rx', watchVersion: WATCH_VERSION, status: 'invalid_message',
        envelopeType: typeof data, keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 8) : [],
        reason: decoded.reason, decodePath: decoded.decodePath, layers: decoded.layers })
      return
    }
    // Older phones can still send library traffic. Discard it before transport
    // bookkeeping or creating a receiver for an unrelated workout.
    if (msg.t === 'plan_catalog' || (typeof msg.transferId === 'string' && msg.transferId.startsWith('c:'))) return
    const target = msg.targetInstallationId
    if (target) rpcState().installationId ||= allocateEventIdentity('', 'link').installationId
    if (target && target !== rpcState().installationId) return
    // Routing metadata is outside the frozen snapshot hash / chunk body.
    if (target) { const { targetInstallationId, ...body } = msg; msg = body }
    // 能收到有效业务包就是连接已恢复的证据，不依赖遗漏的 onOpen。
    if (!rpcState().connected) resumeConnection()
    rpcState().lastPhoneAt = Date.now()
    if (msg.t === 'sync_chunk' && rpcState().v4Ready) {
      if (!msg.transferId?.startsWith('start:')) return
      try { msg = acceptWireChunk(rpcState().transfers ||= {}, msg, Date.now()); if (msg?.t !== 'START_SESSION') return }
      catch (error) { trace('invalid_start_chunk', {}, error); return }
    }
    if (handleV4(msg)) return
    if (rpcState().v4Ready && (['sync', 'plan', 'sync_delta'].includes(msg.t) || /^p:/.test(msg.transferId || ''))) return
    if (msg.t === 'link_probe') { sendControl({ t: 'link_probe_ack', requestId: msg.requestId, installationId: rpcState().installationId, sourceInstallationId: rpcState().installationId }); return }
    if (msg.t === 'link_discover') { sendHello(); return }
    if (msg.t === 'watch_log_request') { sendControl(diagnosticLogPage(msg, WATCH_VERSION)); return }
    if (!['watch_diagnostics_request', 'watch_log_request'].includes(msg.t)) recordDiagnostic('rpc_receive', { type: msg.t, status: msg.status, pending: rpcState().outbox.length })
    if (msg.t === 'session_presence') {
      const state = loadState('rpc'), phoneSession = state.sessionOrigin === 'phone' && state.phoneSession?.sid === state.sid ? state.phoneSession : null
      const hasPhoneLedClose = !phoneSession && (rpcState().v4Ready ? readStored('phone_terminal_v4')?.sid === msg.sid : journalEntry(msg.sid)?.closeEvent?.phoneLed === true)
      const expectedSid = phoneSession?.sid === msg.sid ? phoneSession.sid : hasPhoneLedClose ? msg.sid : ''
      if (expectedSid) {
        const valid = applyPhonePresence(runtime(), msg, expectedSid)
        if (valid && msg.active) { replayPendingEvents(); flush() }
      }
      return
    }
    if (msg.t === 'hello_ack') { rpcState().peerProtocol = rpcState().v4Ready || msg.protocolVersion >= 4 ? 4 : msg.protocolVersion >= 3 ? 3 : 2; rpcState().peerCapabilities = msg.capabilities || {}; serial(resumePhoneConflict); replayPendingEvents(); flush(); return }
    if (msg.t === 'watch_diagnostics_request') {
      const log = diagnosticLog()
      const snapshot = { t: 'watch_diagnostics', watchVersion: WATCH_VERSION,
        log: { watchVersion: log.watchVersion, boot: log.boot, storageFailed: log.storageFailed,
          dropped: log.dropped, droppedInteractions: log.droppedInteractions, unflushed: log.unflushed, count: log.events.length },
        requestId: String(msg.requestId || '').slice(0, 80), ...transportDiagnostics(8) }
      // Match the normal wire budget without introducing chunking or queue entries.
      while (snapshot.events.length && wireBytes(JSON.stringify(snapshot)) > 6000) snapshot.events.shift()
      sendControl(snapshot)
      return
    }
    if (msg.t === 'event_rejected' || msg.t === 'effort_ack') {
      if ((rpcState().peerProtocol || 0) >= 3) return // v3 requires the exact durable committed receipt.
      const event = rpcState().outbox.find(e => e.msg.eventId === msg.eventId)?.msg
      if (!event) return
      msg = { t: 'committed', sid: event.sid, eventId: event.eventId, status: 'rejected', commitRev: 0, detail: msg }
    }
    if (['received', 'committed'].includes(msg.t)) trace(msg.t, msg)
    if (msg.t === 'conflict_reviewed') {
      serial(async () => {
        const saved = await writeStoredAtomic('sync_conflicts', value => {
          const conflicts = value || []
          for (const c of conflicts) if (c.event.eventId === msg.eventId) c.reviewed = true
          return conflicts
        })
        if (!saved.ok) rpcState().handlers.onError?.({ code: 'conflict_review_save_failed' })
      })
      return
    }
    if (msg.t === 'received') {
      const item = rpcState().outbox.find(e => e.msg.eventId === msg.eventId && e.msg.sid === msg.sid)
      if (item) item.receivedAt = Date.now()
      return // native inbox receipt is not a business commit
    }
    if (msg.t === 'committed') {
      const item = rpcState().outbox.find(e => e.msg.eventId === msg.eventId && e.msg.sid === msg.sid)
      if (!item || !['applied', 'conflict', 'rejected'].includes(msg.status)) return
      serial(async () => {
        const affected = [item.msg]
        if (msg.status !== 'applied') {
          const ids = new Set([msg.eventId])
          // New phone-wins receipts settle only this exact event. Each child is
          // still delivered and independently validated by the phone.
          let changed = msg.resolution !== 'phone'
          while (changed) {
            changed = false
            for (const event of [...rpcState().outbox.map(e => e.msg), ...(loadState().pendingEdits || []), ...pendingCloseEvents(), ...pendingSummaries().map(e => e.summaryEvent)]) if (!ids.has(event.eventId) && event.dependsOn?.some(id => ids.has(id))) {
              ids.add(event.eventId); affected.push(event); changed = true
            }
          }
          const archived = await writeStoredAtomic('sync_conflicts', value => {
            const conflicts = value || []
            for (const event of affected) if (!conflicts.some(c => c.event.eventId === event.eventId)) conflicts.push({ event,
              decision: event.eventId === msg.eventId ? msg : { ...msg, eventId: event.eventId, status: 'rejected', reason: 'dependency_failed', parent: msg.eventId }, reviewed: msg.resolution === 'phone', ...(msg.resolution === 'phone' ? { resolution: 'phone' } : {}), at: Date.now() })
            const retained = conflicts.filter(c => !c.reviewed).concat(conflicts.filter(c => c.reviewed).slice(-20))
            if (retained.filter(c => !c.reviewed).length > 100) throw new Error('conflict_archive_full')
            return retained
          })
          if (!archived.ok) { rpcState().handlers.onError?.({ code: 'conflict_archive_full' }); return }
        }
        const recorded = await writeStoredAtomic('event_decisions', value => {
          const decisions = value || {}
          for (const event of affected) decisions[event.eventId] = { sid: event.sid, status: event.eventId === msg.eventId ? msg.status : 'rejected', ...(msg.resolution === 'phone' ? { resolution: 'phone' } : {}), commitRev: msg.commitRev }
          const pins = decisionPins()
          let size = Object.keys(decisions).length
          for (const id of Object.keys(decisions)) { if (size <= 4096) break; if (!pins.has(id)) { delete decisions[id]; size-- } }
          if (size > 4096) throw new Error('event_decisions_full')
          return decisions
        })
        if (!recorded.ok) return
        const ids = new Set(affected.map(e => e.eventId))
        let needsSnapshot = false
        const saved = await writeStoredAtomic('session_state', s => {
          if (!s) return {}
          if (s.sid !== msg.sid) {
            // Retire an old session's exact receipt without rebuilding the active
            // session's projection or comparing unrelated commit revisions.
            s.pendingEdits = (s.pendingEdits || []).filter(e => !ids.has(e.eventId))
            return s
          }
          if (msg.status === 'applied') {
            if (item.msg.t === 'watch_start' && s.sid === msg.sid) s.pendingStart = false
            for (const edit of s.pendingEdits || []) if (edit.eventId === msg.eventId) edit.committedRev = msg.commitRev }
          else s.pendingEdits = (s.pendingEdits || []).filter(e => !ids.has(e.eventId))
          try {
            if (msg.state && s.active && s.sid === msg.sid && msg.state.sid !== msg.sid) throw new Error('receipt_session')
            return reconcileCommittedSnapshot(s, msg.commitRev, s.sid === msg.sid ? msg.state : null)
          }
          catch (_) {
            // The decision is still durable, but its correction cannot be applied
            // to this base. Keep the overlay until fresh phone state arrives.
            needsSnapshot = true
            return reconcileCommittedSnapshot(s, msg.commitRev)
          }
        })
        if (!saved.ok) return
        // A conflict choice is complete only after this exact phone decision
        // and all local close recovery writes have succeeded.
        const resolution = await resumePhoneConflict()
        if (!resolution.ok) { rpcState().handlers.onError?.({ code: 'conflict_close_storage' }); return }
        for (const event of affected) {
          const journal = journalEntry(event.sid)
          if (journal && (event.t === 'session_close' || event.t === 'summary')) {
            if (!(await markEntry(event.sid, { ...(event.t === 'session_close' ? { closeCommitted: true } : {}),
              ...(msg.status === 'applied' ? {} : { delivery: 'blocked', lastError: msg.status }) }))) return
          }
        }
        for (const event of affected) ackEvent(null, event.eventId)
        const state = loadState()
        if (state.active && state.sid === msg.sid && state.syncBase && state.syncBase.commitRev >= msg.commitRev) { try { rpcState().handlers.onSync?.(state.syncBase, { persisted: true }) } catch (error) { trace('page_sync_error', state.syncBase, error) } }
        if (msg.state && state.active && state.sid === msg.sid && state.syncBase?.wireHash === msg.state.wireHash) sendControl({ t: 'sync_ack', sid: msg.sid, wireHash: state.syncBase.wireHash, commitRev: state.syncBase.commitRev, status: 'applied' })
        if (needsSnapshot || (state.sid === msg.sid && msg.status !== 'applied' && (!state.syncBase || state.syncBase.commitRev < msg.commitRev))) sendControl({ t: 'sync_request', sid: msg.sid, reason: 'phone_authority' })
        rpcState().lastCommitAt = Date.now()
      })
      return
    }
    if (msg.transferId?.startsWith('p:') && ['sync_begin', 'sync_chunk', 'sync_resume', 'sync_cancel', 'sync_inline'].includes(msg.t)) {
      const caps = rpcState().peerCapabilities || {}
      if (!caps.selectiveChunkAck || !caps.persistentTransfers) return
      serial(async () => {
        const r = rpcState()
        r.persistentReceiver ||= persistentReceiver({ read: key => readStored(key),
          write: async (key, value) => (await writeStoredAtomic(key, () => value)).ok },
          async (message, meta) => {
            const result = await commitWireSnapshot(message, meta)
            if (result.ok && result.status === 'conflict' && phoneConflict()) r.handlers.onConflict?.(phoneConflict())
            if (result.ok) {
              // Only update the page after the session+applied marker is durable.
              const snapshot = loadState().syncBase
              if (snapshot && result.status !== 'conflict') { try { r.handlers.onSync?.(snapshot, { persisted: true }) } catch (error) { trace('page_sync_error', snapshot, error) } }
            }
            return result
          }, () => Date.now(), { fenced: () => rpcState().peerCapabilities?.snapshotGenerations === true, inline: () => rpcState().peerCapabilities?.inlineSnapshots === true })
        for (const reply of await r.persistentReceiver.receive(msg)) sendControl(reply)
      })
      return
    }
    if (msg.t === 'sync_chunk' || msg.t === 'sync_delta') {
      try {
        if (msg.t === 'sync_chunk') msg = acceptWireChunk(rpcState().transfers ||= {}, msg, Date.now())
        if (!msg) return
        if (msg.t === 'sync_delta') msg = expandWireDelta(loadState().syncBase, msg)
      } catch (error) { sendControl({ t: 'sync_request', reason: String(error.message).slice(0, 80) }); return }
    }
    if (msg.t === 'sync' && msg.protocolVersion >= 3) {
      const { wireHash: hash, ...value } = msg
      if (wireHash(value) !== hash) { sendControl({ t: 'sync_request', reason: 'snapshot_checksum' }); return }
      rpcState().peerProtocol = 3
    }
    else if (msg.t === 'sync') rpcState().peerProtocol = 2
    if (msg.t === 'ack') {
      // Legacy exact ACK is the old protocol's durable business receipt, not received/code=0.
      // Never let a v2 ACK downgrade a v3 transaction, and never cumulatively clear IDs.
      if ((rpcState().peerProtocol || 0) < 3 && msg.eventId) serial(() => acceptLegacyAck(msg.eventId))
      return
    }
    if (msg.t === 'watch_start_ack') {
      const s = loadState()
      if ((rpcState().peerProtocol || 0) < 3 && msg.status === 'started' && msg.eventId) serial(() => acceptLegacyAck(msg.eventId))
      if (msg.status === 'conflict' && msg.snapshot) {
        serial(async () => { const result = await recordPhoneConflict(msg.snapshot); if (result.ok && phoneConflict()) rpcState().handlers.onConflict?.(phoneConflict()) })
      } else if (rpcState().handlers.onStartAck) rpcState().handlers.onStartAck(msg)
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
      if (!Array.isArray(msg.exercises) || !msg.exercises.length) {
        sendControl({ t: msg.t + '_ack', sid: msg.sid, status: 'rejected', reason: 'empty_exercises' })
        return
      }
      const active = loadState()
      if (active.active && active.sid !== msg.sid || phoneConflict()) {
        const incoming = msg
        serial(async () => {
          const result = await recordPhoneConflict(incoming)
          if (result.ok && phoneConflict()) rpcState().handlers.onConflict?.(phoneConflict())
          sendControl({ t: incoming.t + '_ack', sid: incoming.sid, wireHash: incoming.wireHash || '', commitRev: incoming.commitRev || 0,
            status: result.ok ? 'conflict' : 'storage_failed', activeSid: active.sid })
        })
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
        commitRev: msg.commitRev || 0, wireHash: msg.wireHash || '',
        decodePath: decoded.decodePath })
      return
    }
    if (msg.t === 'rest' && rpcState().handlers.onRest) { rpcState().handlers.onRest(msg); return }
    if (msg.t === 'pause' && rpcState().handlers.onPause) { rpcState().handlers.onPause(msg); return }
    if (msg.t === 'set' && rpcState().handlers.onSet) { rpcState().handlers.onSet(msg); return }
    if (msg.t === 'unset' && rpcState().handlers.onUnset) { rpcState().handlers.onUnset(msg); return }
    if (msg.t === 'effort_ack') return // normalized into a durable decision above
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
  // Native callback registrations may retain a destroyed App. They must never
  // reopen delivery or invoke Page subscribers after stop/relaunch.
  for (const key of ['onOpen', 'onClose', 'onError', 'onMessage']) {
    const handler = callbacks[key]
    const guarded = (...args) => {
      if (runtime().destroyed || owner.stopped || owner.callbackBinding !== binding || owner.connect !== connection) return
      return handler(...args)
    }
    connection[key] = guarded
    connection[key.toLowerCase()] = guarded
  }

  if (rpcState().connected) sendHello()
  else probeConnection()
  return detach
}

export function stopServer() {
  const r = rpcState()
  resetPeer(r); runtime().sendLiveEvent = null
  r.stopped = true
  r.callbackBinding = null
  r.handlers = {}
  if (rpcState().retryTimer) cancelAppInterval(rpcState().retryTimer)
  rpcState().retryTimer = null
  cancelAppTimeout(rpcState().flushTimer); rpcState().flushTimer = null
  cancelAppTimeout(rpcState().replayTimer); rpcState().replayTimer = null; rpcState().replaying = false
  try { if (rpcState().connect) rpcState().connect.close({ success() {}, fail() {} }) } catch (e) { /* 已关闭 */ }
  rpcState().controls = []
  rpcState().connect = null
  rpcState().boundConnection = null
  rpcState().connected = false
  rpcState().connectionGeneration++; rpcState().sending = false; cancelAppTimeout(rpcState().sendingTimer)
  r.outbox = []; r.durable = new Set(); r.initialized = false
  r.trace = []; r.transfers = {}; r.persistentReceiver = null; r.eventWire = null
}

/** 事件类：进 outbox，保证闪退/断线不丢。返回是否已在队列里（不代表手机已保存）。 */
export function sendEvent(obj) {
  if (!obj || runtime().destroyed) return false
  if (runtime().sessionDraft) { stageSessionEvent(runtime().sessionDraft, obj); return true }
  initialize()
  // A page replay must not re-clone/rewrite the full session or restart delivery.
  if (obj.protocolVersion === 4 && obj.phoneLed) return sendLiveEvent(obj)
  if (rpcState().v4Ready && (obj.phoneLed || obj.t === 'summary')) return false
  if (obj.eventId && rpcState().outbox.some(e => e.msg.eventId === obj.eventId)) return true
  const s = loadState(), presence = runtime().phoneSessionPresence
  const phoneSession = s.sessionOrigin === 'phone' && s.phoneSession?.sid === s.sid ? s.phoneSession : null
  const phoneLed = !!phoneSession || isPhoneLedEvent(obj)
  const expectedSid = phoneSession?.sid || (obj.phoneLed ? obj.sid : '')
  const livePhoneSession = phoneLed && obj.sid === expectedSid && isPhoneSessionLive({ sid: expectedSid }, presence)
  if (phoneLed && obj.t === 'summary') return true // Phone-led close summaries remain watch-local.
  if (phoneLed && obj.t !== 'session_close' && obj.phoneSessionGeneration != null && obj.phoneSessionGeneration !== presence?.generation) return true
  if (phoneLed && obj.t !== 'session_close' && (!s.active || s.sid !== obj.sid)) return true
  if (phoneLed && obj.t === 'session_close') {
    if (!livePhoneSession) return true // The durable close journal retries it only under same-sid foreground presence.
    obj = { t: 'session_close', sid: obj.sid, eventId: obj.eventId, seq: obj.seq, at: obj.at,
      closedAt: obj.closedAt, disposition: obj.disposition, source: 'watch', protocolVersion: 3, phoneLed: true }
  } else if (phoneLed && !livePhoneSession) return true
  else if (phoneLed) { obj.phoneLed = true; obj.phoneSessionGeneration = presence.generation }
  const frozen = obj.eventId && s.pendingEdits?.find(e => e.dependencyEvents === true && e.eventId === obj.eventId)
  if (frozen || obj.dependencyEvents === true) { const ok = enqueue(JSON.parse(JSON.stringify(frozen || obj))); if (ok) flush(); return ok }
  if (obj.at == null) obj.at = Date.now()
  if (!obj.eventId) {
    const identity = allocateEventIdentity(obj.sid)
    rpcState().lastEventAt = identity.seq
    if (obj.seq == null) obj.seq = identity.seq
    obj.source = 'watch'
    obj.eventId = identity.eventId
    obj.installationId = identity.installationId
    obj.deviceSeq = identity.deviceSeq
  } else {
    rememberEventAt(Number(obj.seq || obj.at) || 0)
  }
  if (rpcState().peerProtocol >= 3) {
    obj.protocolVersion = 3
    obj.baseCommitRev ??= s.commitRev || 0
    obj.sessionEpoch = obj.sid
    obj.installationId ||= runtime().eventClock?.installationId
    obj.deviceSeq ||= runtime().eventClock?.deviceSeq
  }
  if (s.active && s.sid === obj.sid && Number.isInteger(obj.ex)) {
    const exercise = s.workout?.exercises?.[obj.ex], row = s.workout?.rows?.[obj.ex]?.[obj.set - 1]
    obj.protocolVersion = rpcState().peerProtocol >= 3 ? 3 : Math.min(2, s.protocolVersion || 1)
    obj.entryInstanceId ||= exercise?.entryInstanceId
    obj.setId ||= row?.setId
    obj.structureRevision ||= s.structureRevision
    obj.weightUnit ||= s.weightUnit || 'kg'
    if (obj.t === 'add_set') obj.newSetIds = (s.workout.rows[obj.ex] || []).map(r => r.setId)
  }
  if (s.active && s.sid === obj.sid && (['set', 'unset', 'weight', 'reps', 'add_set', 'remove_set', 'effort'].includes(obj.t) || obj.protocolVersion >= 3 && ['rest', 'pause', 'focus'].includes(obj.t))) {
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
  const r = rpcState()
  if (!r.connected || !r.connect || !obj) return false
  const live = obj.protocolVersion === 4 && obj.phoneLed === true
  if (live) {
    const latestKey = obj.t === 'focus' ? ['focus', obj.sid].join(':')
      : ['weight', 'reps', 'rest', 'pause', 'row_value'].includes(obj.t)
        ? [obj.t, obj.sid, obj.entryInstanceId || '', obj.setId || '', obj.field || ''].join(':') : ''
    return sendV4LiveControl(obj, latestKey)
  }
  const controls = r.controls ||= []
  const key = JSON.stringify(obj)
  if (controls.some(e => e.key === key)) return true
  if (controls.length >= 64) { trace('control_queue_full', obj); return false }
  controls.push({ key, msg: JSON.parse(key), latestKey: '', live: false, failures: 0, nextAttemptAt: 0 })
  flush()
  return true
}

const V4_LIVE_LATEST_KEYS = 32
function liveControlReady(msg) {
  const r = rpcState(), presence = runtime().phoneSessionPresence
  return !!(r.connected && r.connect && r.v4Ready && msg?.protocolVersion === 4 && msg.phoneLed === true &&
    msg.sid && isPhoneSessionLive({ sid: msg.sid }, presence))
}
function sendV4LiveControl(msg, latestKey) {
  const r = rpcState()
  if (!liveControlReady(msg)) return false
  if (r.sending || r.liveEventSending) {
    if (!latestKey) return dispatchV4LiveEvent(msg)
    const pending = r.liveLatest ||= Object.create(null)
    const existed = Object.prototype.hasOwnProperty.call(pending, latestKey)
    if (!existed && Object.keys(pending).length >= V4_LIVE_LATEST_KEYS) {
      const oldest = Object.keys(pending)[0]
      if (oldest) delete pending[oldest]
    }
    pending[latestKey] = JSON.parse(JSON.stringify(msg))
    return true
  }
  if (!latestKey) return dispatchV4LiveEvent(msg)
  return dispatchV4LiveControl(msg)
}
function stampV4LiveRevision(r, msg) {
  const state = loadState('rpc')
  const storedRev = state.sid === msg.sid ? Number(state.rev) || 0 : 0
  const liveRev = r.liveRevisionSid === msg.sid ? Number(r.liveRevision) || 0 : 0
  r.liveRevisionSid = msg.sid
  r.liveRevision = Math.max(storedRev, liveRev, Number(msg.rev) || 0) + 1
  msg.rev = r.liveRevision
}
function dispatchV4LiveControl(msg) {
  const r = rpcState()
  if (!liveControlReady(msg) || r.sending) return false
  stampV4LiveRevision(r, msg)
  const token = { generation: r.connectionGeneration, control: null, live: true, type: msg.t, eventId: msg.eventId }
  r.sending = token
  const release = () => {
    if (r.sending !== token || token.generation !== r.connectionGeneration) return false
    cancelAppTimeout(r.sendingTimer); r.sendingTimer = null; r.sending = false
    return true
  }
  const after = () => {
    if (dispatchNextLiveLatest()) return
    scheduleFlush()
  }
  const bytes = wireBytes(JSON.stringify(msg))
  trace('live_send_attempt', msg, null, null, { bytes })
  r.sendingTimer = appTimeout(() => {
    if (!release()) return
    trace('live_send_timeout', msg, null, null, { bytes })
    r.handlers.onError?.({ code: 'live_state_send_failed', sid: msg.sid, operation: msg.t })
    after()
  }, 6000)
  try {
    r.connect.send({ data: msg,
      success: () => { if (!release()) return; trace('live_send_success', msg, null, null, { bytes }); after() },
      fail: (error, code) => { if (!release()) return; trace('live_send_fail', msg, error, code, { bytes }); r.handlers.onError?.({ code: 'live_state_send_failed', sid: msg.sid, operation: msg.t }); after() }
    })
    return true
  } catch (error) {
    if (release()) { trace('live_send_exception', msg, error); r.handlers.onError?.({ code: 'live_state_send_failed', sid: msg.sid, operation: msg.t }); after() }
    return false
  }
}
function dispatchV4LiveEvent(msg) {
  const r = rpcState()
  if (!liveControlReady(msg)) return false
  if (msg.eventId && r.liveEventIds?.includes(msg.eventId)) return true
  if (r.liveEventSending?.eventId && r.liveEventSending.eventId === msg.eventId) return true
  if (r.liveEventSending) {
    trace('live_event_rejected_busy', msg, null, null, { activeEventId: r.liveEventSending.eventId })
    r.handlers.onError?.({ code: 'live_event_busy', sid: msg.sid, eventId: msg.eventId, operation: msg.t })
    return false
  }
  stampV4LiveRevision(r, msg)
  const token = { generation: r.connectionGeneration, eventId: msg.eventId || '' }
  r.liveEventSending = token
  const release = () => {
    if (r.liveEventSending !== token || token.generation !== r.connectionGeneration) return false
    cancelAppTimeout(r.liveEventTimer); r.liveEventTimer = null; r.liveEventSending = null
    return true
  }
  const fail = (code, error) => {
    if (!release()) return
    trace('live_event_send_fail', msg, error, code)
    r.handlers.onError?.({ code: 'live_event_send_failed', sid: msg.sid, eventId: msg.eventId, operation: msg.t })
    if (!dispatchNextLiveLatest()) scheduleFlush()
  }
  const bytes = wireBytes(JSON.stringify(msg))
  trace('live_event_send_attempt', msg, null, null, { bytes })
  r.liveEventTimer = appTimeout(() => fail('timeout'), 6000)
  try {
    r.connect.send({ data: msg,
      success: () => {
        if (!release()) return
        if (msg.eventId) {
          r.liveEventIds ||= []
          r.liveEventIds.push(msg.eventId)
          if (r.liveEventIds.length > 64) r.liveEventIds.shift()
        }
        trace('live_event_send_success', msg, null, null, { bytes })
        if (!dispatchNextLiveLatest()) scheduleFlush()
      },
      fail: fail,
    })
    return true
  } catch (error) {
    fail('exception', error)
    return false
  }
}
function dispatchNextLiveLatest() {
  const r = rpcState(), pending = r.liveLatest ||= Object.create(null)
  if (r.sending || r.liveEventSending) return false
  if (!r.connected || !r.connect || !r.v4Ready) {
    r.liveLatest = Object.create(null)
    return false
  }
  const keys = Object.keys(pending)
  if (!keys.length) return false
  const key = keys[0], msg = pending[key]
  delete pending[key]
  if (liveControlReady(msg)) dispatchV4LiveControl(msg)
  else return dispatchNextLiveLatest()
  return true
}

/** Send the latest phone-led value without adding it to the persistent outbox. */
export function sendLiveValue(value) {
  if (!value || !['weight', 'reps'].includes(value.t)) return false
  initialize()
  const r = rpcState(), s = loadState('rpc'), sid = String(value.sid || '')
  const presence = runtime().phoneSessionPresence
  if (!sid || !r.connected || !r.v4Ready || !s.active || s.sessionOrigin !== 'phone' || s.sid !== sid ||
      !isPhoneSessionLive({ sid }, presence)) return false
  const number = Number(value[value.t])
  if (!Number.isFinite(number) || number < 0 || number > 99999) return false
  r.liveValueSequence = (r.liveValueSequence || 0) + 1
  const msg = { t: value.t, protocolVersion: 4, phoneLed: true, sid,
    eventId: 'watch-live:' + sid + ':' + Date.now() + ':' + r.liveValueSequence,
    ex: Number.isInteger(value.ex) && value.ex >= 0 ? value.ex : 0,
    set: Number.isInteger(value.set) && value.set > 0 ? value.set : 1,
    ...(value.entryInstanceId ? { entryInstanceId: String(value.entryInstanceId).slice(0, 120) } : {}),
    ...(value.setId ? { setId: String(value.setId).slice(0, 120) } : {}),
    ...(value.weightUnit ? { weightUnit: String(value.weightUnit).slice(0, 8) } : {}),
    [value.t]: number, at: Number(value.at) || Date.now(), source: 'watch',
    phoneSessionGeneration: presence.generation }
  return sendControl(msg)
}

export function canSendLiveEvent(value) {
  const r = rpcState(), s = loadState('rpc'), sid = String(value?.sid || '')
  if (!r.v4Ready || !r.connected || !s.active || s.sessionOrigin !== 'phone' || s.sid !== sid ||
      !isPhoneSessionLive({ sid }, runtime().phoneSessionPresence)) return true
  if (r.liveEventSending) return false
  if (value.t !== 'session_close') return true
  const isValue = type => type === 'weight' || type === 'reps'
  return !isValue(r.sending?.type) && !Object.values(r.liveLatest || {}).some(msg => isValue(msg.t))
}

export function pendingCount() { initialize(); return rpcState().outbox.length }
export function persistenceStatus() { return { pending: rpcState().writeBusy || rpcState().writeDirty, failed: rpcState().persistFailed } }
export function isConnected() { return rpcState().connected }
export function isPhoneConnected() { const r = rpcState(); return !!r.connected && !!r.lastPhoneAt && Date.now() - r.lastPhoneAt < 15000 }
export function isPhoneSessionConnected(sid) {
  const state = loadState(), session = state.phoneSession
  return !!rpcState().connected && state.sid === sid && session?.sid === sid && isPhoneSessionLive(session, runtime().phoneSessionPresence)
}
export function synchronizationStatus() {
  initialize()
  const conflicts = readStored('sync_conflicts') || []
  const r = rpcState(), legacy = r.outbox.length, v4 = r.peerProtocol >= 4
  return { pending: v4 ? 0 : legacy, phonePending: v4 ? 0 : r.outbox.filter(e => e.receivedAt).length,
    historicalPending: v4 ? legacy : 0, conflicts: conflicts.filter(c => !c.reviewed).length, lastCommitAt: r.lastCommitAt || 0 }
}
