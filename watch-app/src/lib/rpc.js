import { runtime } from './runtime.js'
import { readStored, writeStored, writeStoredConfirmed, retryStorage } from './persistence.js'
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
import { loadState, buildSessionSummary, summaryEventOf, closeSession, save } from './session.js'
import { allocateEventIdentity, rememberEventAt } from './event-id.js'
import { pendingSummaries, pendingEntry, journalEntry, prepareClose, releaseCandidate, markPhase, markEntry, markDelivered } from './close-journal.js'
import { WATCH_VERSION } from './version.js'

const PHONE_PACKAGE = 'ch.duartesantos.opengym'
const PHONE_FINGERPRINT = '8bf64970048540fe913005d05becee1ecad819e7171518dabcd15817301a0149'
const K_OUTBOX = 'rpc_outbox'
const WRITE_TIMEOUT_MS = 5000
const rpcState = () => runtime().rpc ||= { ...{"connect":null,"handlers":{},"connected":false,"outbox":[],"sending":false,"retryTimer":null,"lastEventAt":0,"initialized":false,"connectionGeneration":0,"sendingTimer":null,"writeBusy":false,"writeDirty":false,"persistFailed":false}, durable: new Set(), lifecycleQueue: null }


// Memory-only metadata: diagnostics must not write training storage, enter the durable
// outbox, change retries, or include workout payloads. A broken console is nonfatal.
function trace(stage, msg = {}, error = null, code = null) {
  try {
    const r = rpcState(), head = r.outbox[0]?.msg
    const text = value => value == null ? '' : String(value).slice(0, 80)
    const entry = { at: Date.now(), stage, type: text(msg.t), sid: text(msg.sid),
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
  if (rpcState().initialized) return
  rpcState().outbox = loadOutbox()
  // 已冻结的最终汇总可能只存在日志里（关闭时 outbox 还没写成功）：先并进来。
  for (const entry of pendingSummaries()) enqueue(entry.summaryEvent, { persistOutbox: false })
  markDurable()
  rpcState().initialized = true
}

// 日志里的汇总也已经是可靠数据：把它连同 outbox 现有内容一起视为可发送。
function markDurable(batch = rpcState().outbox) {
  const ids = new Set(batch.map(e => e.msg.eventId))
  for (const entry of pendingSummaries()) if (entry.summaryEvent?.eventId) ids.add(entry.summaryEvent.eventId)
  rpcState().durable = ids
}

function enqueue(msg, { persistOutbox = true } = {}) {
  if (!msg || !msg.eventId) return false
  if (rpcState().outbox.some(e => e.msg.eventId === msg.eventId)) return true
  if (rpcState().outbox.some(e => e.msg.sid === msg.sid && e.msg.t === msg.t && e.msg.set === msg.set && e.at === msg.at)) return true
  rpcState().outbox.push({ at: msg.at || Date.now(), msg, sent: false })
  trace('enqueue', msg)
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
    watchVersion: WATCH_VERSION, protocolVersion: 3, stableIds: true,
    capabilities: { durableCommit: true, snapshotChunks: true, deltas: true },
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
  r.nextProbeAt = 0; r.probeAttempts = 0
  r.connectionGeneration++; r.sending = false; clearTimeout(r.sendingTimer)
  r.outbox.forEach(e => { e.sent = false })
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

function flush() {
  initialize()
  const expired = runtime().expiredEvents || []
  if (expired.length) { runtime().expiredEvents = []; for (const event of expired) sendEvent(event) }
  retryStorage()
  if (rpcState().persistFailed && !rpcState().writeBusy) persist()
  if (!rpcState().connected) { probeConnection(); return }
  if (!rpcState().connected || !rpcState().connect || rpcState().sending) return
  const eligible = e => rpcState().durable.has(e.msg.eventId) && (!e.sent || Date.now() >= (e.nextAttemptAt || (e.sentAt || 0) + 4000))
  const next = rpcState().peerProtocol >= 3 ? (eligible(rpcState().outbox[0] || { msg: {} }) ? rpcState().outbox[0] : null) : rpcState().outbox.find(eligible)
  if (!next) return
  const token = { generation: rpcState().connectionGeneration, eventId: next.msg.eventId }
  rpcState().sending = token
  const release = () => { if (rpcState().sending !== token || token.generation !== rpcState().connectionGeneration) return false; clearTimeout(rpcState().sendingTimer); rpcState().sending = false; return true }
  trace('send_attempt', next.msg)
  rpcState().sendingTimer = setTimeout(() => { if (release()) { trace('send_timeout', next.msg); flush() } }, 6000)
  try {
    rpcState().connect.send({ data: next.msg,
      success: () => { if (!release()) return; trace('send_success', next.msg); const item = rpcState().outbox.find(e => e.msg.eventId === token.eventId); if (item) { item.sent = true; item.sentAt = Date.now(); item.attempts = (item.attempts || 0) + 1; item.nextAttemptAt = Date.now() + Math.min(60000, 4000 * Math.pow(2, Math.min(4, item.attempts - 1))) + Math.floor(Math.random() * 1000) }; flush() },
      fail: (error, code) => { if (!release()) return; trace('send_fail', next.msg, error, code); next.sent = true; next.nextAttemptAt = Date.now() + Math.min(60000, 2000 * Math.pow(2, Math.min(5, next.attempts || 0))); next.attempts = (next.attempts || 0) + 1; flush() }
    })
  } catch (error) { if (release()) trace('send_exception', next.msg, error) }
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
      trace('connection_exception', {}, e)
      if (rpcState().handlers.onError) rpcState().handlers.onError({ code: 1000, data: String(e) })
      return
    }
  }

  // 页面模块共享 application runtime；当前页面只接管 UI 回调。
  rpcState().connect.onOpen = () => {
    rpcState().connected = true
    trace('connection_open')
    rpcState().connectionGeneration++; rpcState().sending = false; clearTimeout(rpcState().sendingTimer)
    initialize()
    rpcState().outbox.forEach(e => { e.sent = false })
    persist()
    if (rpcState().handlers.onState) rpcState().handlers.onState(true)
    flush()
    sendHello()
  }
  rpcState().connect.onClose = () => {
    trace('connection_close')
    rpcState().connected = false
    rpcState().connectionGeneration++; rpcState().sending = false; clearTimeout(rpcState().sendingTimer)
    if (rpcState().handlers.onState) rpcState().handlers.onState(false)
  }
  rpcState().connect.onError = (err) => {
    trace('connection_error', {}, err)
    rpcState().connected = false
    rpcState().connectionGeneration++; rpcState().sending = false; clearTimeout(rpcState().sendingTimer)
    if (rpcState().handlers.onState) rpcState().handlers.onState(false)
    if (rpcState().handlers.onError) rpcState().handlers.onError(err || {})
  }
  rpcState().connect.onMessage = (data) => {
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
    if (msg.t === 'watch_diagnostics_request') {
      const snapshot = { t: 'watch_diagnostics', watchVersion: WATCH_VERSION,
        sid: String(loadState().sid || '').slice(0, 80),
        requestId: String(msg.requestId || '').slice(0, 80), ...transportDiagnostics(8) }
      // Match the normal wire budget without introducing chunking or queue entries.
      while (snapshot.events.length && wireBytes(JSON.stringify(snapshot)) > 6000) snapshot.events.shift()
      sendControl(snapshot)
      return
    }
    if (['received', 'committed'].includes(msg.t)) trace(msg.t, msg)
    if (msg.t === 'conflict_reviewed') {
      const conflicts = readStored('sync_conflicts') || []
      for (const c of conflicts) if (c.event.eventId === msg.eventId) c.reviewed = true
      writeStored('sync_conflicts', conflicts)
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
        if (msg.status !== 'applied') {
          const conflicts = readStored('sync_conflicts') || []
          if (conflicts.filter(c => !c.reviewed).length >= 100 && !conflicts.some(c => c.event.eventId === msg.eventId)) { rpcState().handlers.onError?.({ code: 'conflict_archive_full' }); return }
          if (!conflicts.some(c => c.event.eventId === msg.eventId)) conflicts.push({ event: item.msg, decision: msg, at: Date.now() })
          // Never discard a rejected edit until the original and the decision can be recovered.
          const retained = conflicts.filter(c => !c.reviewed).concat(conflicts.filter(c => c.reviewed).slice(-20))
          try { if (!(await writeStoredConfirmed('sync_conflicts', retained))) return } catch { return }
          storage.set({ key: 'last_notice', value: '存在同步冲突，离线操作已保留，请核对手机训练记录', fail() {} })
        }
        const s = loadState()
        if (msg.status === 'applied') {
          for (const edit of s.pendingEdits || []) if (edit.eventId === msg.eventId) edit.committedRev = msg.commitRev
        } else s.pendingEdits = (s.pendingEdits || []).filter(e => e.eventId !== msg.eventId)
        save(s)
        // A snapshot can beat its commit receipt. Reconcile again after removing/tagging the
        // pending edit, so a rejected optimistic value cannot remain on top of phone state.
        if (s.active && s.syncBase && s.syncBase.commitRev >= msg.commitRev) {
          try { rpcState().handlers.onSync?.(s.syncBase) } catch { return }
        }
        if (!(await writeStoredConfirmed('session_state', loadState()))) return
        ackEvent(null, msg.eventId)
        rpcState().lastCommitAt = Date.now()
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
        commitRev: msg.commitRev || 0, wireHash: msg.wireHash || '',
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

  if (rpcState().connected) sendHello()
  else probeConnection()
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
  if (!rpcState().connected || !rpcState().connect || !obj) return
  try {
    trace('control_attempt', obj)
    rpcState().connect.send({ data: obj, success() { trace('control_success', obj) }, fail(error, code) { trace('control_fail', obj, error, code) } })
  } catch (error) { trace('control_exception', obj, error) }
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
