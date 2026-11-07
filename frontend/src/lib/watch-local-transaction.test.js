// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { watchPersistence, loadWatchModule } from './watch-test-harness.js'
import { commitPageAction } from '../../../watch-app/src/lib/local-action.js'
import { applyEdit, applyRest } from '../../../watch-app/src/lib/protocol.js'
import { wireHash } from '../../../watch-app/src/lib/sync-wire.js'
function boot(disk = new Map()) {
  const h = watchPersistence(disk), c = h.ctx
  Object.assign(c, { applyEdit, applyRest, console, WATCH_VERSION: 'test' })
  loadWatchModule('event-id', c, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', c, ['prepareClose', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markEntry', 'markDelivered', 'releaseCandidate', 'markPhase'])
  loadWatchModule('session', c, ['startSession', 'save', 'loadState', 'closeSession', 'buildSessionSummary', 'summaryEventOf'])
  return { ...h, c }
}
function start(h) { return h.c.startSession({ sid: 's', name: 'Bench', protocolVersion: 2, exercises: [{ name: 'Bench', entryInstanceId: 'entry', sets: 2, reps: '8', weight: '50' }] }) }
const intent = (c, s, id = 'edit') => c.stageSessionEvent(s, { t: 'weight', sid: 's', eventId: id, ex: 0, set: 1, weight: '65', at: 100 })
const drain = async () => { for (let i=0;i<30;i++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())
it('does not publish success UI or Outbox before disk, then replays the same frozen intention after restart', async () => {
  const h = boot(); start(h)
  const writes = [], original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? writes.push(item) : original(item)
  const page = { state: h.c.loadState(), visible: true, refresh: vi.fn(), startHrCapture: vi.fn() }, replay = vi.fn()
  const action = commitPageAction(page, function() { this.state.workout.rows[0][0].w = '65'; intent(h.c,this.state); this.startHrCapture(); this.refresh() }, { ...h.c, replayPendingEvents: replay })
  expect(page.state.workout.rows[0][0].w).toBe('50'); expect(page.refresh).not.toHaveBeenCalled(); expect(page.startHrCapture).not.toHaveBeenCalled(); expect(replay).not.toHaveBeenCalled()
  original(writes[0]); expect(await action).toBe(true)
  expect(page.state.workout.rows[0][0].w).toBe('65'); expect(replay).toHaveBeenCalledOnce(); expect(page.refresh).toHaveBeenCalledOnce()
  const frozen = h.disk.get('session_state').pendingEdits[0]
  expect(frozen.protocolVersion).toBe(3)
  const restarted = boot(h.disk), c = restarted.c
  c.interconnect = { instance: () => ({ getReadyState: ({ success }) => success({ status: 0 }), send() {} }) }
  loadWatchModule('rpc', c, ['startServer', 'replayPendingEvents', 'pendingCount'])
  c.startServer({}); c.replayPendingEvents(); await drain()
  expect(c.pendingCount()).toBe(1)
  expect(h.disk.get('rpc_outbox')[0].msg).toEqual(frozen)
})
it('failed local operation keeps the prior training and emits no success effects', async () => {
  const h = boot(); start(h); const original = h.storage.set
  h.storage.set = item => item.key === 'session_state' ? item.fail() : original(item)
  const page = { state: h.c.loadState(), refresh: vi.fn() }, replay = vi.fn()
  expect(await commitPageAction(page, function() { this.state.workout.rows[0][0].done=true; intent(h.c,this.state); this.refresh() }, { ...h.c,replayPendingEvents:replay })).toBe(false)
  expect(page.state.workout.rows[0][0].done).toBe(false); expect(h.disk.get('session_state').pendingEdits || []).toHaveLength(0)
  expect(replay).not.toHaveBeenCalled(); expect(page.refresh).not.toHaveBeenCalled(); expect(page.inputNotice).toContain('未保存')
})
it.each(['watch_close_journal_v1','closed_sessions','summary_last','clear'])('recovers a local close after failure of %s without changing IDs or losing prerequisites', async failKey => {
  const h = boot(); start(h); await h.c.commitSessionAction('s', s => { s.workout.rows[0][0].w='65'; intent(h.c,s) })
  const original = h.storage.set
  h.storage.set = item => (item.key === failKey || (failKey === 'clear' && item.key === 'session_state' && !item.value.active)) ? item.fail() : original(item)
  const result = await h.c.commitLocalClose('s','saved', Date.now()+60000)
  expect(result.ok).toBe(failKey !== 'watch_close_journal_v1')
  const frozen = h.disk.get('session_state').closeIntent
  expect(frozen.close.pendingEvents[0].eventId).toBe('edit')
  const reboot = boot(h.disk); expect((await reboot.c.recoverLocalClose()).ok).toBe(true)
  const entry = reboot.c.journalEntry('s')
  expect(entry.closeEvent).toEqual(frozen.close.closeEvent); expect(entry.summaryEvent).toEqual(frozen.summaryEvent)
  expect(entry.pendingEvents[0].eventId).toBe('edit'); expect(reboot.c.loadState().active).toBe(false)
  expect(h.disk.get('closed_sessions')).toContain('s'); expect(h.disk.get('summary_last').totalCalories).toBe(frozen.summaryLast.totalCalories)
})
it('persistent snapshot rejects missing Delta base, retains older revisions and preserves local pending edits', async () => {
  const h=boot(); const state=start(h); state.commitRev=2; h.c.save(state)
  await h.c.commitSessionAction('s', s => { s.workout.rows[0][0].w='65'; intent(h.c,s) })
  const value={t:'sync', protocolVersion:3,sid:'s',commitRev:1,workout:'Old',exercises:state.workout.exercises,rows:state.workout.rows}
  const msg={...value,wireHash:wireHash(value)}, meta={transferId:'old',sid:'s',revision:1,hash:'outer'}
  expect((await h.c.commitWireSnapshot(msg,meta)).status).toBe('retained')
  expect(h.c.loadState().pendingEdits[0].eventId).toBe('edit'); expect(h.c.loadState().workout.rows[0][0].w).toBe('65')
  expect((await h.c.commitWireSnapshot({ t:'sync_delta',sid:'s',commitRev:3,baseCommitRev:999,baseHash:'none' },{...meta,transferId:'delta',revision:3})).ok).toBe(false)
  expect(h.c.loadState().commitRev).toBe(2)
})
