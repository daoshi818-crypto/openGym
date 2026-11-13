import { persistentReceiver } from './persistent-transfer.js'
import { compactStartEvent, createEventWire, nextEventFrame, EVENT_FRAME_BYTES } from './event-wire.js'
import { selectReadyEvent } from './event-dependencies.js'
import { appTimeout, cancelAppTimeout, appInterval, cancelAppInterval } from './app-timers.js'
import { runtime } from './runtime.js'
import { readStored, writeStored, writeStoredConfirmed, writeStoredAtomic, retryStorage } from './persistence.js'
import { wireHash, wireBytes, acceptWireChunk, expandWireDelta } from './sync-wire.js'
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
import { loadState, buildSessionSummary, summaryEventOf, closeSession, save, stageSessionEvent, recoverLocalClose, commitWireSnapshot, reconcileCommittedSnapshot } from './session.js'
import { allocateEventIdentity, rememberEventAt } from './event-id.js'
import { pendingSummaries, pendingCloseEvents, pendingEntry, journalEntry, prepareClose, releaseCandidate, markPhase, markEntry, markDelivered } from './close-journal.js'
import { WATCH_VERSION } from './version.js'
import { recordDiagnostic, diagnosticLogPage } from './diagnostic-log.js'

const PHONE_PACKAGE = 'ch.duartesantos.opengym'
const PHONE_FINGERPRINT = '8bf64970048540fe913005d05becee1ecad819e7171518dabcd15817301a0149'
const K_OUTBOX = 'rpc_outbox'
const WRITE_TIMEOUT_MS = 5000
const SEND_GAP_MS = 120
const REPLAY_BATCH = 2
const rpcState = () => runtime().rpc ||= { ...{"connect":null,"handlers":{},"connected":false,"outbox":[],"sending":false,"retryTimer":null,"lastEventAt":0,"initialized":false,"connectionGeneration":0,"sendingTimer":null,"writeBusy":false,"writeDirty":false,"persistFailed":false}, durable: new Set(), lifecycleQueue: null }


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
    recordDiagnostic(stage, { ...entry, type: entry.type, status: msg.status, rev: msg.commitRev })
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
    rpcState().handlers.onError?.({ code: 'outbox_capacity' }); return false
  }
  rpcState().outbox.push(entry)
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
  const s = loadState()
  sendControl({
    t: 'hello',
    watchVersion: WATCH_VERSION, protocolVersion: 3, stableIds: true,
    capabilities: { durableCommit: true, snapshotChunks: true, deltas: true, dependencyEvents: true, selectiveChunkAck: true, persistentTransfers: true, commandReceipts: true, watchEventChunks: true },
    receipts: true,
    sid: s.sid || '',
    rev: s.rev || 0,
    commitRev: s.commitRev || 0, sessionEpoch: s.sid || '',
    pending: rpcState().outbox.length,
    active: !!s.active,
    pendingStart: !!s.pendingStart,
  })
}

function resumeConnection() {
  const r = rpcState()
  if (r.connected || !r.connect) return
  r.connected = true
  r.peerCapabilities = {} // Every connection must negotiate extension features again.
  r.nextProbeAt = 0; r.probeAttempts = 0
  r.connectionGeneration++; r.sending = false; cancelAppTimeout(r.sendingTimer)
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

// Keypad edits are already durable in session_state. Recover only edits not yet in the
// outbox, two per UI turn. Re-read between batches so receipts/closed sessions win.
export function replayPendingEvents() {
  if (runtime().destroyed || rpcState().stopped) return
  const r = rpcState()
  if (runtime().sessionDraft) return
  initialize()
  if (r.replaying) return
  r.replaying = true
  const step = () => {
    r.replayTimer = null
    try {
      const queued = new Set(r.outbox.map(e => e.msg.eventId))
      const missing = (loadState().pendingEdits || []).filter(e => e.committedRev == null && !queued.has(e.eventId))
      for (const event of missing.slice(0, REPLAY_BATCH)) sendEvent(event)
      if (missing.length > REPLAY_BATCH) r.replayTimer = appTimeout(step, SEND_GAP_MS)
      else r.replaying = false
    } catch (error) {
      // Leave durable session edits intact and allow the next UI replay to retry.
      r.replaying = false
      trace('replay_failed', { reason: String(error?.message || error) })
    }
  }
  step()
}

function flush() {
  if (runtime().destroyed || rpcState().stopped) return
  initialize()
  const decisions = readStored('event_decisions') || {}
  for (const event of pendingCloseEvents()) if (!decisions[event.eventId] && !rpcState().outbox.some(e => e.msg.eventId === event.eventId)) enqueue(event)
  const expired = runtime().expiredEvents || []
  if (expired.length) { runtime().expiredEvents = []; for (const event of expired) sendEvent(event) }
  retryStorage()
  if (rpcState().persistFailed && !rpcState().writeBusy) persist()
  if (!rpcState().connected) { probeConnection(); return }
  if (!rpcState().connected || !rpcState().connect || rpcState().sending) return
  if (!(rpcState().controls || []).some(e => Date.now() >= (e.nextAttemptAt || 0)) && Date.now() < (rpcState().nextSendAt || 0)) { scheduleFlush(rpcState().nextSendAt - Date.now()); return }
  const r = rpcState()
  let control = (r.controls ||= []).find(e => Date.now() >= (e.nextAttemptAt || 0))
  const eligible = e => r.durable.has(e.msg.eventId) && Date.now() >= (e.nextAttemptAt || 0) && (!e.sent || Date.now() >= (e.nextAttemptAt || (e.sentAt || 0) + 4000))
  // Frozen extension intentions require head confirmation on old peers. Original v2
  // payloads retain their established FIFO send-order pipeline and exact ACK semantics.
  const business = r.peerProtocol >= 3 || r.outbox[0]?.msg.dependencyEvents
    ? selectReadyEvent(r.outbox, r.durable, decisions, Date.now(), r.peerProtocol >= 3 && !!r.peerCapabilities?.dependencyEvents)
    : (r.outbox.find(e => !e.sent && eligible(e)) || r.outbox.find(eligible))
  if ((r.controlBurst || 0) >= 8 && business) control = null
  const next = control || business
  if (!next) {
    const waiting = [...r.controls, ...r.outbox.filter(e => r.durable.has(e.msg.eventId))]
    if (waiting.length) scheduleFlush(Math.max(SEND_GAP_MS, Math.min(4000, ...waiting.map(e => Math.max(1000, (e.nextAttemptAt || 0) - Date.now())))))
    return
  }
  r.controlBurst = control ? (r.controlBurst || 0) + 1 : 0
  const token = { generation: rpcState().connectionGeneration, eventId: next.msg.eventId }
  rpcState().sending = token
  if (!control) rpcState().nextSendAt = Date.now() + SEND_GAP_MS
  const release = () => { if (rpcState().sending !== token || token.generation !== rpcState().connectionGeneration) return false; cancelAppTimeout(rpcState().sendingTimer); rpcState().sending = false; return true }
  const backoff = () => {
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
      const state = loadState()
      const base = state.active && state.sid === next.msg.sid ? state.syncBase : null
      if (base?.wireHash) data = { ...data, appliedHash: base.wireHash, appliedRev: base.commitRev }
    }
    const bytes = wireBytes(JSON.stringify(data))
    trace('send_attempt', next.msg, null, null, { bytes })
    rpcState().connect.send({ data,
      success: () => {
        if (!release()) return
        trace('send_success', next.msg, null, null, { bytes })
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
      fail: (error, code) => { if (!release()) return; trace('send_fail', next.msg, error, code, { bytes }); backoff(); scheduleFlush() }
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
        if (rpcState().outbox.length !== before) persist()
      }
      const p = markDelivered(entry.sid)
      if (p && typeof p.then === 'function') p.then(ok => { if (ok) drop() }, () => {})
      else drop()
      return
    }
    rpcState().outbox = rpcState().outbox.filter(e => e.msg.eventId !== eventId)
  }
  if (rpcState().outbox.length !== before) persist()
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
function serial(task) {
  const prev = rpcState().lifecycleQueue || Promise.resolve()
  const next = prev.then(() => { if (runtime().destroyed || rpcState().stopped) return null; try { return task() } catch (e) { return null } }).catch(() => null)
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
  if (runtime().destroyed) return
  rpcState().stopped = false
  rpcState().stop = stopServer
  if (h) rpcState().handlers = h
  if (!rpcState().retryTimer) rpcState().retryTimer = appInterval(flush, 4000)
  if (!rpcState().connect) {
    initialize()
    try {
      rpcState().connect = interconnect.instance({ package: PHONE_PACKAGE, fingerprint: PHONE_FINGERPRINT })
    } catch (e) {
      rpcState().connect = null
      trace('connection_exception', {}, e)
      if (rpcState().handlers.onError) rpcState().handlers.onError({ code: 1000, data: String(e) })
      return
    }
  }

  // Page changes only replace subscribers. Rebinding/hello here restarted full sync
  // on every onShow even when the connection was already active.
  if (rpcState().boundConnection === rpcState().connect) return
  rpcState().boundConnection = rpcState().connect
  const connection = rpcState().connect, owner = rpcState(), callbacks = {}
  const binding = {}; owner.callbackBinding = binding
  // 页面模块共享 application runtime；当前页面只接管 UI 回调。
  callbacks.onOpen = () => {
    rpcState().connected = true
    rpcState().peerCapabilities = {}
    trace('connection_open')
    rpcState().connectionGeneration++; rpcState().sending = false; cancelAppTimeout(rpcState().sendingTimer)
    initialize()
    rpcState().nextSendAt = 0
    rpcState().outbox.forEach(e => { e.sent = false; if (!e.lastSendFailed) e.nextAttemptAt = 0 })
    sendHello()
    persist()
    if (rpcState().handlers.onState) rpcState().handlers.onState(true)
    flush()
  }
  callbacks.onClose = () => {
    trace('connection_close')
    rpcState().connected = false
    rpcState().connectionGeneration++; rpcState().sending = false; cancelAppTimeout(rpcState().sendingTimer)
    if (rpcState().handlers.onState) rpcState().handlers.onState(false)
  }
  callbacks.onError = (err) => {
    trace('connection_error', {}, err)
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
    // 能收到有效业务包就是连接已恢复的证据，不依赖遗漏的 onOpen。
    if (!rpcState().connected) resumeConnection()
    if (msg.t === 'watch_log_request') { sendControl(diagnosticLogPage(msg, WATCH_VERSION)); return }
    if (!['watch_diagnostics_request', 'watch_log_request'].includes(msg.t)) recordDiagnostic('rpc_receive', { type: msg.t, sid: msg.sid, eventId: msg.eventId, status: msg.status, rev: msg.commitRev })
    if (msg.t === 'hello_ack') { rpcState().peerProtocol = msg.protocolVersion >= 3 ? 3 : 2; rpcState().peerCapabilities = msg.capabilities || {}; replayPendingEvents(); flush(); return }
    if (msg.t === 'watch_diagnostics_request') {
      const snapshot = { t: 'watch_diagnostics', watchVersion: WATCH_VERSION,
        sid: String(loadState().sid || '').slice(0, 80),
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
        for (const event of affected) {
          const journal = journalEntry(event.sid)
          if (journal && (event.t === 'session_close' || event.t === 'summary')) {
            if (!(await markEntry(event.sid, { ...(event.t === 'session_close' ? { closeCommitted: true } : {}),
              ...(msg.status === 'applied' ? {} : { delivery: 'blocked', lastError: msg.status }) }))) return
          }
        }
        for (const event of affected) ackEvent(null, event.eventId)
        const state = loadState()
        if (state.active && state.syncBase && state.syncBase.commitRev >= msg.commitRev) { try { rpcState().handlers.onSync?.(state.syncBase, { persisted: true }) } catch (error) { trace('page_sync_error', state.syncBase, error) } }
        if (msg.state && state.active && state.sid === msg.sid && state.syncBase?.wireHash === msg.state.wireHash) sendControl({ t: 'sync_ack', sid: msg.sid, wireHash: state.syncBase.wireHash, commitRev: state.syncBase.commitRev, status: 'applied' })
        if (needsSnapshot || (msg.status !== 'applied' && (!state.syncBase || state.syncBase.commitRev < msg.commitRev))) sendControl({ t: 'sync_request', sid: msg.sid, reason: 'phone_authority' })
        rpcState().lastCommitAt = Date.now()
      })
      return
    }
    if (msg.transferId?.startsWith('p:') && ['sync_begin', 'sync_chunk', 'sync_resume', 'sync_cancel'].includes(msg.t)) {
      const caps = rpcState().peerCapabilities || {}
      if (!caps.selectiveChunkAck || !caps.persistentTransfers) return
      serial(async () => {
        const r = rpcState()
        r.persistentReceiver ||= persistentReceiver({ read: key => readStored(key),
          write: async (key, value) => (await writeStoredAtomic(key, () => value)).ok },
          async (message, meta) => {
            const result = await commitWireSnapshot(message, meta)
            if (result.ok) {
              // Only update the page after the session+applied marker is durable.
              const snapshot = loadState().syncBase
              if (snapshot) { try { r.handlers.onSync?.(snapshot, { persisted: true }) } catch (error) { trace('page_sync_error', snapshot, error) } }
            }
            return result
          })
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
    if (msg.t === 'plan_catalog') {
      storage.set({ key: 'plan_catalog', value: msg, fail() {} })
      if (rpcState().handlers.onCatalog) rpcState().handlers.onCatalog(msg)
      sendControl({ t: 'plan_catalog_ack', at: msg.at })
      return
    }
    if (msg.t === 'watch_start_ack') {
      const s = loadState()
      if ((rpcState().peerProtocol || 0) < 3 && msg.status === 'started' && msg.eventId) serial(() => acceptLegacyAck(msg.eventId))
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
}

export function stopServer() {
  const r = rpcState()
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
  if (obj.eventId && rpcState().outbox.some(e => e.msg.eventId === obj.eventId)) return true
  const frozen = obj.eventId && loadState().pendingEdits?.find(e => e.dependencyEvents === true && e.eventId === obj.eventId)
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
  const s = loadState()
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
  const controls = r.controls ||= []
  const key = JSON.stringify(obj)
  if (controls.some(e => e.key === key)) return true
  if (controls.length >= 64) { trace('control_queue_full', obj); return false }
  controls.push({ key, msg: JSON.parse(key), nextAttemptAt: 0 })
  flush()
  return true
}

export function pendingCount() { initialize(); return rpcState().outbox.length }
export function persistenceStatus() { return { pending: rpcState().writeBusy || rpcState().writeDirty, failed: rpcState().persistFailed } }
export function isConnected() { return rpcState().connected }
export function synchronizationStatus() {
  initialize()
  const conflicts = readStored('sync_conflicts') || []
  return { pending: rpcState().outbox.length, phonePending: rpcState().outbox.filter(e => e.receivedAt).length,
    conflicts: conflicts.filter(c => !c.reviewed).length, lastCommitAt: rpcState().lastCommitAt || 0 }
}
