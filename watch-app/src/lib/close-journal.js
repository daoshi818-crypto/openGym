// 关闭日志：把“训练已关闭”与“本段热量已送达手机”分开保存。
//
// session_close_ack 只表示手机收到了关闭消息，不代表热量已写入手机训练记录，所以它不能
// 清掉待传汇总。汇总必须先进这份按 sid 保存的独立日志（不放在会被清空的 session_state
// 里），再入 outbox；手机对该 summary 回业务 ACK 后才标记 delivered。
// 日志本身是“一次生成、永不重算”的冻结快照：重复的关闭消息、乱序的 ended、
// 重启补发都复用同一条 summaryEvent（同 eventId），手机按 eventId 幂等。
import { wireBytes } from './sync-wire.js'
import { readStored, writeStoredAtomic } from './persistence.js'

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

// The journal cache contains only confirmed candidates, never failed writes.
async function updateJournal(change) {
  const result = await writeStoredAtomic(CLOSE_JOURNAL_KEY, value => {
    const journal = value?.entries ? value : empty()
    change(journal.entries)
    if (wireBytes(JSON.stringify(journal)) > 1048576) throw new Error('close_journal_bytes')
    return journal
  })
  return result.ok ? result.value : null
}

/**
 * 生成（或复用）本段唯一的关闭记录。
 * 已存在同 sid 记录时只返回它，不改 summaryEvent：一次关闭只有一个最终汇总。
 * 返回 null 表示日志没能落盘，调用方必须保留原始会话、显示待保存，不能继续清理。
 */
export async function prepareClose(close, summaryEvent, delivery = 'pending') {
  const sid = close && close.sid
  if (!sid || !summaryEvent) return null
  const journal = await updateJournal(entries => {
    if (entries[sid]?.summaryEvent) {
      // A pre-extension frozen candidate keeps its summary identity. Add the new
      // close prerequisite without changing any already-frozen business payload.
      if (close.closeEvent && !entries[sid].closeEvent) Object.assign(entries[sid], { closeEvent: close.closeEvent,
        pendingEvents: close.pendingEvents || [], localClose: true, closeCommitted: false, delivery })
      return
    }
    const terminal = Object.values(entries).filter(e => ['delivered', 'discarded'].includes(e.delivery) && (!e.localClose || e.closeCommitted)).sort((a,b) => a.closedAt - b.closedAt)
    while (Object.keys(entries).length >= 128 && terminal.length) delete entries[terminal.shift().sid]
    if (Object.keys(entries).length >= 128) throw new Error('close_journal_full')
    entries[sid] = {
      sid, closeEventId: close.eventId || '', disposition: close.disposition || 'saved',
      closedAt: close.closedAt || Date.now(), phase: 'prepared', summaryEvent, delivery, lastError: null,
      ...(close.closeEvent ? { closeEvent: close.closeEvent, pendingEvents: close.pendingEvents || [], localClose: true, closeCommitted: false } : {}),
    }
  })
  return journal?.entries[sid] || null
}

/** 候选（手机还没给裁决）转成待发送；复用同一条冻结汇总。 */
export async function releaseCandidate(sid) {
  const journal = await updateJournal(entries => {
    const entry = entries[sid]
    if (entry?.summaryEvent && entry.delivery !== 'delivered') entries[sid] = { ...entry, delivery: 'pending', phase: entry.phase || 'prepared' }
  })
  return journal?.entries[sid] || null
}

/** 只更新阶段/送达状态；失败返回 false，由调用方保留原数据并重试。 */
export async function markEntry(sid, patch) {
  let found = false
  const journal = await updateJournal(entries => {
    if (entries[sid]) { found = true; entries[sid] = { ...entries[sid], ...patch } }
  })
  return !!journal && found
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

// Local-close prerequisites survive clearing session_state. Exact committed receipts
// suppress replay; retained payloads are never reconstructed from a newer summary.
export function pendingCloseEvents() {
  return Object.values(readJournal().entries).filter(e => e.localClose && !e.closeCommitted && e.delivery !== 'blocked')
    .flatMap(e => [...(e.pendingEvents || []), e.closeEvent].filter(Boolean))
}
