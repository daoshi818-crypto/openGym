import { createWatchLifecycle } from './watch-session.js'
import { watchSnapshotOf } from './watch-workout.js'
import { dependencyDecision } from '../../../watch-app/src/lib/event-dependencies.js'
import { watchConflict } from './watch-revision.js'
import { watchSidOf } from './session-resume.js'
import { wireBytes } from '../../../watch-app/src/lib/sync-wire.js'

const TYPES = new Set(['hello', 'watch_start', 'session_close', 'session_close_ack', 'pause', 'rest',
  'effort', 'weight', 'reps', 'set', 'unset', 'add_set', 'remove_set', 'focus', 'end', 'summary'])
const copy = value => JSON.parse(JSON.stringify(value))
const decisionOf = record => {
  if (record.decision) return record.decision
  const committed = record.replies?.find(r => r.msg?.t === 'committed')?.msg
  if (committed) return committed
  const ack = record.replies?.find(r => r.kind === 'ack' && r.eventId)
  return ack ? { eventId: ack.eventId, sid: record.sid, status: 'applied' } : null
}
const keyOf = ev => JSON.stringify([ev.sid || '', ev.eventId || ev._inboxId || [ev.t, ev.ex, ev.set, ev.at]])

// The bridge claims synchronously. Business work, durable checkpoint and replies run serially.
// A failed checkpoint keeps the head and its decision: retry never re-runs finish/rest effects.
export function createDurableWatchLifecycle(deps) {
  const queue = []
  let running = null, release = null, disposed = false, retryTimer = null, replying = false
  const status = (phase, error = '') => deps.status?.({ phase, pending: queue.length, error })
  async function pump() {
    if (running || disposed || !queue.length) return running
    running = (async () => {
      while (queue.length && !disposed) {
        const item = queue[0], ev = item.ev, key = keyOf(ev)
        try {
          if (!item.replies) {
            const prior = ev.t !== 'hello' && deps.getState().watchCommits?.[key]
            if (prior) item.replies = prior.replies
            else {
              const stage = () => {
              const replies = []
              const starting = ev.t === 'watch_start' && !deps.getState().active
              const staged = { ...deps,
                update: fn => deps.update(fn, ev),
                send: msg => replies.push({ kind: 'send', msg: copy(msg) }),
                sendAck: (at, eventId) => replies.push({ kind: 'ack', at, eventId }),
                sendEnded: msg => replies.push({ kind: 'ended', msg: copy(msg) }),
                sendSync: () => replies.push({ kind: 'sync' }),
              }
              const decisions = Object.entries(deps.getState().watchCommits || {}).map(([key, record]) => {
                // Old versions stored only replies; sid is part of the persisted exact key.
                let sid
                try { sid = JSON.parse(key)[0] } catch { /* malformed records cannot prove a parent */ }
                return decisionOf({ ...record, sid })
              })
              const dependency = dependencyDecision(ev, id => decisions.find(d => d?.eventId === id))
              const conflict = dependency.status === 'ready' ? watchConflict(deps.getState(), ev) : null
              if (dependency.status !== 'ready') {
                replies.push({ kind: 'send', msg: { t: 'event_rejected', eventId: ev.eventId, reason: dependency.reason, parent: dependency.parent } })
              } else if (conflict) {
                replies.push({ kind: 'send', msg: { t: 'event_rejected', eventId: ev.eventId, reason: 'concurrent_edit', detail: copy(conflict) } }, { kind: 'sync' })
              } else createWatchLifecycle(staged)(ev)
              if (ev.protocolVersion >= 3 && ev.eventId) {
                const rejected = replies.find(r => r.msg?.t === 'event_rejected')
                const conflicted = replies.find(r => r.msg?.status === 'conflict')
                const start = replies.find(r => r.msg?.t === 'watch_start_ack')
                const applied = replies.some(r => r.kind === 'ack') || ev.t === 'session_close_ack'
                const commit = { t: 'committed', eventId: ev.eventId, sid: ev.sid,
                  status: conflict || conflicted ? 'conflict' : rejected || !applied ? 'rejected' : 'applied',
                  ...(conflict || conflicted ? { resolution: 'phone' } : {}),
                  commitRev: deps.getState().active?.syncRev || 0,
                  ...(conflict ? { detail: copy(conflict) } : conflicted ? { detail: conflicted.msg } : rejected ? { detail: rejected.msg } : !applied ? { detail: { reason: start?.msg.status || 'no_target' } } : {}) }
                for (let i = replies.length - 1; i >= 0; i--) if (replies[i].kind === 'ack' || ['effort_ack', 'event_rejected'].includes(replies[i].msg?.t)) replies.splice(i, 1)
                // Freeze the canonical phone correction in the SAME durable decision.
                // Never regenerate a duplicate's delta against newer phone state.
                if (replies.some(r => r.kind === 'sync')) {
                  const snapshot = watchSnapshotOf(deps.getState(), deps.getTimer())
                  const state = deps.commandState?.(ev, snapshot)
                  if (state && wireBytes(JSON.stringify({ ...commit, state })) <= 6000) {
                    commit.state = copy(state)
                    for (let i = replies.length - 1; i >= 0; i--) if (replies[i].kind === 'sync') replies.splice(i, 1)
                  }
                }
                replies.unshift({ kind: 'send', msg: commit })
                if (commit.status === 'conflict') deps.update(s => {
                  s.watchConflicts ||= {}
                  s.watchConflicts[key] = { event: copy(ev), detail: commit.detail, resolved: 'phone', at: Date.now() }
                })
                if (ev.resolutionOf && commit.status === 'applied') deps.update(s => {
                  if (s.watchConflicts?.[ev.resolutionOf]) s.watchConflicts[ev.resolutionOf].resolved = 'watch'
                })
                if (ev.resolutionOf && commit.status === 'applied') {
                  const original = deps.getState().watchConflicts?.[ev.resolutionOf]?.event
                  if (original) replies.push({ kind: 'send', msg: { t: 'conflict_reviewed', eventId: original.eventId } })
                }
              }
              if (ev.t === 'hello') deps.update(s => {
                for (const record of Object.values(s.watchConflicts || {})) if (!record.resolved) record.resolved = 'phone'
              })
              if (ev.t === 'hello') for (const record of Object.values(deps.getState().watchConflicts || {})) {
                if (record.resolved) replies.push({ kind: 'send', msg: { t: 'conflict_reviewed', eventId: record.event.eventId } })
              }
              // UI is a post-checkpoint effect, not a business ACK or replayable reply.
              // Keep it on the queue item across a failed checkpoint, never in watchCommits.
              if (starting && replies.some(r => r.msg?.t === 'watch_start_ack' && r.msg.status === 'started')) item.startedSid = ev.sid
              item.replies = replies
              deps.update(s => {
                s.watchCommitRev = (s.watchCommitRev || 0) + 1
                // Hello must always reconcile fresh state, rather than replaying an old answer.
                if (ev.t !== 'hello') {
                  s.watchCommits ||= {}
                  s.watchCommits[key] = { replies, decision: replies.find(r => r.msg?.t === 'committed')?.msg || (ev.eventId ? { eventId: ev.eventId, sid: ev.sid, status: replies.some(r => r.kind === 'ack') ? 'applied' : replies.some(r => r.msg?.status === 'conflict') ? 'conflict' : 'rejected' } : null), rev: s.watchCommitRev }
                  const keys = Object.keys(s.watchCommits)
                  for (const old of keys.slice(0, Math.max(0, keys.length - 4000))) delete s.watchCommits[old]
                }
                if (ev.t === 'rest' || ev.rest) s.watchRest = copy(deps.getTimer() || null)
              })
              }
              try { (deps.transaction || (run => run()))(stage, ev) }
              catch (error) { item.replies = null; throw error }
            }
          }
          if (ev.t !== 'hello' && !deps.getState().watchCommits?.[key]) throw new Error('watch decision was not published')
          status('saving')
          await deps.checkpoint()
          if (disposed) return
          // The exact decision is already on disk. Inbox deletion is garbage collection:
          // a slow/lost native callback must not hold navigation, ACKs or later commands.
          // A retained entry safely replays the same durable decision on the next drain.
          for (const id of item.inboxIds) Promise.resolve().then(() => deps.completeInbox?.(id)).catch(() => {})
          // Cancel an automatic page plan echo only after durable publication.
          // This cache callback cannot invalidate or block the persisted decision.
          for (const reply of item.replies) if (reply.msg?.t === 'committed' && reply.msg.state) {
            try { deps.commandStateCommitted?.(reply.msg.state) } catch { /* optimization only */ }
          }
          replying = true
          release?.(); release = null
          if (item.startedSid) {
            const sid = item.startedSid
            item.startedSid = null
            // A failed/duplicate/conflicting start must not steal navigation.
            if (watchSidOf(deps.getState().active) === sid) {
              try { deps.onStarted?.(sid) } catch { /* navigation cannot invalidate a durable commit */ }
            }
          }
          for (const reply of item.replies) {
            try {
              if (reply.kind === 'sync') {
                const snapshot = watchSnapshotOf(deps.getState(), deps.getTimer())
                if (snapshot) Promise.resolve(deps.sendSync(snapshot)).catch(() => {})
              } else if (reply.kind === 'ack') await deps.sendAck(reply.at, reply.eventId)
              else if (reply.kind === 'ended') await deps.sendEnded(reply.msg)
              else await deps.send(reply.msg)
            } catch { /* lost replies are reproduced when the watch resends */ }
          }
          replying = false
          queue.shift()
          if (queue.length) release ||= deps.holdOutbound?.()
          status(queue.length ? 'pending' : 'synced')
        } catch (error) {
          status('storage_failed', String(error?.message || error))
          clearTimeout(retryTimer)
          retryTimer = setTimeout(() => { running = null; pump() }, 5000)
          break
        }
      }
    })().finally(() => { running = null })
    return running
  }
  function receive(ev) {
    if (disposed || !TYPES.has(ev?.t)) return false
    let item = queue.find(item => keyOf(item.ev) === keyOf(ev))
    if (!item) { item = { ev: copy(ev), inboxIds: new Set() }; queue.push(item) }
    if (ev._inboxId) item.inboxIds.add(ev._inboxId)
    if (!replying) release ||= deps.holdOutbound?.()
    status('pending')
    clearTimeout(retryTimer)
    pump()
    return true
  }
  receive.idle = async () => { while (running) await running }
  receive.retry = () => { clearTimeout(retryTimer); return pump() }
  receive.dispose = () => { disposed = true; clearTimeout(retryTimer); release?.() }
  return receive
}
