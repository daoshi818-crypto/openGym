// 关闭日志：把“训练已关闭”与“本段热量已送达手机”分开保存。
//
// session_close_ack 只表示手机收到了关闭消息，不代表热量已写入手机训练记录，所以它不能
// 清掉待传汇总。汇总必须先进这份按 sid 保存的独立日志（不放在会被清空的 session_state
// 里），再入 outbox；手机对该 summary 回业务 ACK 后才标记 delivered。
// 日志本身是“一次生成、永不重算”的冻结快照：重复的关闭消息、乱序的 ended、
// 重启补发都复用同一条 summaryEvent（同 eventId），手机按 eventId 幂等。
import { readStored, writeStoredConfirmed } from './persistence.js'

export const CLOSE_JOURNAL_KEY = 'watch_close_journal_v1'
const empty = () => ({ schemaVersion: 1, entries: {} })

export function readJournal() {
  const j = readStored(CLOSE_JOURNAL_KEY)
  return j && typeof j === 'object' && j.entries && typeof j.entries === 'object' ? j : empty()
}

export function journalEntry(sid) {
  return sid ? readJournal().entries[sid] || null : null
}

/** 尚未送达手机的冻结汇总（重启后要重建 outbox 的那批）。
 *  候选（candidate）不在这里：手机还没说“这场已保存”，不能自己把它变成历史。 */
export function pendingSummaries() {
  return Object.values(readJournal().entries)
    .filter(e => e && e.summaryEvent && e.delivery === 'pending')
}

export function pendingEntry(sid) {
  const e = journalEntry(sid)
  return e && e.summaryEvent && e.delivery === 'pending' ? e : null
}

function save(entries) {
  return writeStoredConfirmed(CLOSE_JOURNAL_KEY, { schemaVersion: 1, entries })
}

/**
 * 生成（或复用）本段唯一的关闭记录。
 * 已存在同 sid 记录时只返回它，不改 summaryEvent：一次关闭只有一个最终汇总。
 * 返回 null 表示日志没能落盘，调用方必须保留原始会话、显示待保存，不能继续清理。
 */
export async function prepareClose(close, summaryEvent, delivery = 'pending') {
  const sid = close && close.sid
  if (!sid || !summaryEvent) return null
  const journal = readJournal()
  const existing = journal.entries[sid]
  if (existing && existing.summaryEvent) return existing
  const entry = {
    sid,
    closeEventId: close.eventId || '',
    disposition: close.disposition || 'saved',
    closedAt: close.closedAt || Date.now(),
    phase: 'prepared',
    summaryEvent,
    delivery,
    lastError: null,
  }
  journal.entries[sid] = entry
  const ok = await save(journal.entries)
  return ok ? entry : null
}

/** 候选（手机还没给裁决）转成待发送；复用同一条冻结汇总。 */
export async function releaseCandidate(sid) {
  const journal = readJournal()
  const entry = journal.entries[sid]
  if (!entry || !entry.summaryEvent || entry.delivery === 'delivered') return entry || null
  journal.entries[sid] = { ...entry, delivery: 'pending', phase: entry.phase || 'prepared' }
  const ok = await save(journal.entries)
  return ok ? journal.entries[sid] : null
}

/** 只更新阶段/送达状态；失败返回 false，由调用方保留原数据并重试。 */
export async function markEntry(sid, patch) {
  const journal = readJournal()
  const entry = journal.entries[sid]
  if (!entry) return false
  journal.entries[sid] = { ...entry, ...patch }
  return save(journal.entries)
}

export const markPhase = (sid, phase) => markEntry(sid, { phase })
export const markDelivered = sid => markEntry(sid, { delivery: 'delivered', phase: 'done', lastError: null })

export function summaryEventIdOf(sid) {
  const entry = journalEntry(sid)
  return entry && entry.summaryEvent ? entry.summaryEvent.eventId : ''
}

export function deliveredSids() {
  return Object.values(readJournal().entries).filter(e => e && e.delivery === 'delivered').map(e => e.sid)
}
