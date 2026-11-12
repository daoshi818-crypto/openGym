import storage from '@blueos.storage.storage'
import { runtime } from './runtime.js'
import { appTimeout, cancelAppTimeout } from './app-timers.js'
import { wireBytes } from './sync-wire.js'

const KEY = 'watch_diagnostic_log_v1'
const MAX_BYTES = 24000
// Reserve evidence for user actions without increasing the journal or write budget.
const ACTION_STAGE = /^(dot_|local_commit_|complete_tap$|page_|interaction_reset$|remote_end$|local_end$)/
function interaction(e) { return ACTION_STAGE.test(e.stage) }
function trim(j) {
  while (j.events.length > 64 || j.bytes > MAX_BYTES) {
    const actions = j.events.filter(interaction).length
    const transport = j.events.length - actions
    const evictAction = actions > 32 && transport <= 32 || transport === 0
    const i = j.events.findIndex(e => interaction(e) === evictAction)
    const removed = j.events.splice(i, 1)[0]
    j.bytes -= j.sizes.splice(i, 1)[0]
    j.dropped++; if (interaction(removed)) j.droppedInteractions++
  }
}
const fields = ['sid', 'eventId', 'entryInstanceId', 'setId', 'type', 'code', 'detail', 'version', 'status',
  'ex', 'set', 'rev', 'pending', 'rest', 'paused', 'ok', 'duration', 'bytes']
function journal() {
  const r = runtime()
  if (!r.diagnosticLog) {
    let saved
    try { saved = storage.getSync({ key: KEY }) } catch { /* Optional diagnostics only. */ }
    const events = Array.isArray(saved?.events) ? saved.events.slice(-64).map(e => clean(e.stage, e, e.at)) : []
    const sizes = events.map(e => wireBytes(JSON.stringify(e)) + 1)
    r.diagnosticLog = { events, sizes, bytes: sizes.reduce((n, size) => n + size, 2), serial: 0, persisted: 0, timer: null, writing: false, lastWriteAt: null,
      dropped: Number.isSafeInteger(saved?.dropped) && saved.dropped >= 0 ? saved.dropped : 0,
      droppedInteractions: Number.isSafeInteger(saved?.droppedInteractions) && saved.droppedInteractions >= 0 ? saved.droppedInteractions : 0,
      failed: false, boot: Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }
  }
  return r.diagnosticLog
}
function clean(stage, data = {}, at = Date.now()) {
  const e = { at: Number.isFinite(at) ? at : Date.now(), stage: String(stage || '').slice(0, 40) }
  for (const key of fields) {
    const v = data[key]
    if (typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) e[key] = v
    else if (typeof v === 'string') e[key] = v.slice(0, 80)
  }
  if (Number.isSafeInteger(data.count) && data.count > 0) e.count = data.count
  if (Number.isFinite(data.firstAt)) e.firstAt = data.firstAt
  if (typeof data.boot === 'string') e.boot = data.boot.slice(0, 32)
  return e
}
function schedule(j) {
  if (j.timer != null || j.writing || j.failed) return
  j.timer = appTimeout(() => { j.timer = null; flushDiagnosticLog() }, 1000)
}
export function recordDiagnostic(stage, data = {}) {
  try {
    const j = journal(), e = { ...clean(stage, data), boot: j.boot }, last = j.events[j.events.length - 1]
    // A burst is one record with a count and its final target, not hundreds of allocations/writes.
    if (last?.stage === e.stage && last.boot === e.boot && last.detail === e.detail && last.status === e.status && e.at - last.at < 250) {
      e.count = (last.count || 1) + 1; e.firstAt = last.firstAt || last.at
      j.bytes -= j.sizes.pop()
      j.events[j.events.length - 1] = e
    } else j.events.push(e)
    const size = wireBytes(JSON.stringify(e)) + 1
    j.sizes.push(size); j.bytes += size
    trim(j)
    j.serial++; schedule(j)
  } catch { /* Logging must never change training or transport decisions. */ }
}
export function flushDiagnosticLog() {
  try {
    const j = journal()
    if (j.writing || j.failed || j.persisted === j.serial) return
    if (j.lastWriteAt != null && Date.now() - j.lastWriteAt < 1000) { schedule(j); return }
    if (j.timer != null) cancelAppTimeout(j.timer)
    j.timer = null
    j.writing = true
    j.lastWriteAt = Date.now()
    const serial = j.serial, value = { version: 1, dropped: j.dropped, droppedInteractions: j.droppedInteractions, events: j.events.map(e => ({ ...e })) }
    let settled = false, watchdog
    const done = ok => {
      if (settled) return
      settled = true; cancelAppTimeout(watchdog); j.writing = false
      if (!ok) { j.failed = true; return }
      j.persisted = serial
      if (j.serial !== serial) schedule(j)
    }
    watchdog = appTimeout(() => done(false), 5000)
    try { storage.set({ key: KEY, value, success: () => done(true), fail: () => done(false) }) }
    catch { done(false) }
  } catch { /* Storage failure is isolated from the workout storage queue. */ }
}
export function diagnosticLog() {
  try {
    const j = journal()
    return { version: 1, boot: j.boot, storageFailed: j.failed, dropped: j.dropped, droppedInteractions: j.droppedInteractions,
      unflushed: j.serial !== j.persisted, events: j.events.map(e => ({ ...e })) }
  } catch { return { version: 1, storageFailed: true, events: [] } }
}

export function diagnosticLogPage(request, watchVersion) {
  const j = journal(), requestId = String(request.requestId || '').slice(0, 80)
  const offset = Number.isSafeInteger(request.offset) && request.offset >= 0 ? request.offset : -1
  if (offset === 0 && (j.export?.requestId !== requestId || Date.now() - j.export.at > 60000))
    j.export = { requestId, at: Date.now(), log: diagnosticLog() }
  const snapshot = j.export
  if (offset < 0 || !snapshot || snapshot.requestId !== requestId || Date.now() - snapshot.at > 60000 || offset > snapshot.log.events.length)
    return { t: 'watch_log', requestId, offset, status: 'expired', events: [] }
  const events = snapshot.log.events.slice(offset, offset + 12)
  const reply = { t: 'watch_log', requestId, offset, status: 'ok', watchVersion,
    boot: snapshot.log.boot, storageFailed: snapshot.log.storageFailed, unflushed: snapshot.log.unflushed,
    dropped: snapshot.log.dropped, droppedInteractions: snapshot.log.droppedInteractions,
    total: snapshot.log.events.length, nextOffset: offset + events.length, events }
  while (events.length > 1 && wireBytes(JSON.stringify(reply)) > 5500) {
    events.pop(); reply.nextOffset = offset + events.length
  }
  return reply
}
