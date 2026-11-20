// @vitest-environment node
import { expect, it, vi, afterEach } from 'vitest'
import { createDurableWatchLifecycle } from './watch-commit.js'
import { canonicalWire } from '../../../watch-app/src/lib/sync-wire.js'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'
import { stripImports, watchSource } from './watch-test-harness.js'
import { runInNewContext } from 'node:vm'
import { makeTransfer } from '../../../watch-app/src/lib/persistent-transfer.js'
import { selectReadyEvent } from '../../../watch-app/src/lib/event-dependencies.js'

afterEach(() => vi.useRealTimers())
function watch() {
  const h = watchPersistence(), ctx = h.ctx
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('protocol', ctx, ['applyEdit', 'applyRest'])
  loadWatchModule('close-journal', ctx, ['prepareClose', 'journalEntry'])
  loadWatchModule('session', ctx, ['startSession', 'loadState', 'save', 'commitWireSnapshot', 'phoneConflict', 'completePhoneConflict'])
  ctx.startSession({ sid: 'watch', name: '手表训练', protocolVersion: 3, exercises: [
    { id: '0025', name: '划船', entryInstanceId: 'e1', sets: 1, setIds: ['s1'], weight: 40, reps: 8 },
  ] })
  const s = ctx.loadState(); s.workout.rows[0][0].done = true; s.workout.rows[0][0].at = Date.now(); ctx.save(s)
  return { ...h, ctx }
}
const snapshot = () => canonicalWire({ sid: 'phone', commitRev: 2, workout: '手机训练', startedAt: Date.now(),
  exercises: [{ id: '0025', name: '划船', entryInstanceId: 'phone-e', sets: 1, setIds: ['phone-s'] }], rows: [[{ setId: 'phone-s', w: 60, r: 10, done: false }]] })
function phone() {
  let S = { unit: 'kg', workouts: [], active: { start: Date.now(), watchSid: 'phone', name: '手机训练', entries: [] } }
  let disk
  const deps = { getState: () => S, getTimer: () => null, update: fn => fn(S),
    transaction: fn => { const before = structuredClone(S); try { fn() } catch (e) { S = before; e.watchReducerRolledBack = true; throw e } },
    checkpoint: vi.fn(async () => { disk = structuredClone(S) }), send: vi.fn(), sendSync: vi.fn(), sendEnded: vi.fn(), sendAck: vi.fn() }
  const receive = createDurableWatchLifecycle(deps)
  return { deps, receive, state: () => S, disk: () => disk }
}

it('announces a different active workout without ending it or changing the phone session', async () => {
  const p = phone(), before = structuredClone(p.state().active)
  p.receive({ t: 'hello', sid: 'watch', active: true }); await p.receive.idle()
  expect(p.deps.sendEnded).not.toHaveBeenCalled()
  expect(p.deps.sendSync).toHaveBeenCalled()
  expect(p.state().active).toEqual(before); p.receive.dispose()
})

it.each(['saved', 'abandoned'])('keeps phone active and durably %s the watch choice exactly once', async disposition => {
  const h = watch(), p = phone(), before = structuredClone(p.state().active), snap = snapshot()
  const applied = await h.ctx.commitWireSnapshot(snap, { sid: snap.sid, revision: snap.commitRev, transferId: 'p:conflict', hash: '123' })
  expect(applied).toMatchObject({ ok: true, status: 'conflict' })
  expect(h.ctx.loadState().sid).toBe('watch')
  expect(h.ctx.phoneConflict()).toMatchObject({ watchSid: 'watch', phoneSid: 'phone' })
  const close = await h.ctx.commitLocalClose('watch', disposition, Date.now(), { conflictWith: 'phone' })
  expect(close.ok).toBe(true)
  const ev = close.entry.closeEvent
  expect(ev.conflictWith).toBe('phone'); expect(ev.dependsOn).toEqual([])
  p.receive(ev); await p.receive.idle()
  expect(p.state().active).toEqual(before)
  expect(p.disk().workouts).toHaveLength(disposition === 'saved' ? 1 : 0)
  if (disposition === 'saved') expect(p.disk().workouts[0].entries[0].sets[0]).toMatchObject({ done: true, w: 40, r: '8' })
  expect(Object.keys(p.state().watchPendingSaves || {})).toHaveLength(0)
  p.receive(ev); await p.receive.idle()
  expect(p.state().workouts).toHaveLength(disposition === 'saved' ? 1 : 0)
  expect((await h.ctx.completePhoneConflict()).resolved).not.toBe(true)
  const commit = p.deps.send.mock.calls.map(([m]) => m).find(m => m.t === 'committed' && m.eventId === ev.eventId)
  expect(commit.status).toBe('applied')
  h.disk.set('event_decisions', { [ev.eventId]: { sid: ev.sid, status: 'applied' } })
  expect(await h.ctx.completePhoneConflict()).toMatchObject({ ok: true, resolved: true })
  expect(h.ctx.phoneConflict()).toBeNull()
  expect((await h.ctx.commitWireSnapshot(snap, { sid: snap.sid, revision: snap.commitRev, transferId: 'p:continue', hash: '234' })).ok).toBe(true)
  expect(h.ctx.loadState().sid).toBe('phone'); p.receive.dispose()
})

it('does not acknowledge a save until the phone checkpoint succeeds', async () => {
  const h = watch(), p = phone()
  await h.ctx.commitWireSnapshot(snapshot(), { sid: 'phone', revision: 2, transferId: 'p:x', hash: '1' })
  const close = await h.ctx.commitLocalClose('watch', 'saved', Date.now(), { conflictWith: 'phone' })
  p.deps.checkpoint.mockRejectedValueOnce(Error('disk full'))
  p.receive(close.entry.closeEvent); await p.receive.idle()
  expect(p.deps.send).not.toHaveBeenCalled(); expect(p.disk()).toBeUndefined()
  await p.receive.retry(); await p.receive.idle()
  expect(p.disk().workouts).toHaveLength(1); p.receive.dispose()
})

it('preserves the selected disposition across watch storage failure and restart before phone receipt', async () => {
  const h = watch()
  await h.ctx.commitWireSnapshot(snapshot(), { sid: 'phone', revision: 2, transferId: 'p:x', hash: '1' })
  const original = h.storage.set
  h.storage.set = opts => opts.key === 'watch_close_journal_v1' ? opts.fail?.() : original(opts)
  const failed = await h.ctx.commitLocalClose('watch', 'saved', Date.now(), { conflictWith: 'phone' })
  expect(failed.ok).toBe(false)
  expect(h.ctx.loadState()).toMatchObject({ active: true, sid: 'watch', closeIntent: { close: { disposition: 'saved' } } })
  const restarted = watchPersistence(h.disk), ctx = restarted.ctx
  loadWatchModule('close-journal', ctx, ['prepareClose', 'journalEntry'])
  loadWatchModule('session', ctx, ['loadState', 'phoneConflict', 'recoverLocalClose', 'completePhoneConflict'])
  expect(ctx.phoneConflict().watchSid).toBe('watch')
  expect((await ctx.recoverLocalClose()).ok).toBe(true)
  expect(ctx.loadState().active).toBe(false)
  expect(ctx.journalEntry('watch').closeEvent).toMatchObject({ conflictWith: 'phone', disposition: 'saved' })
  expect((await ctx.completePhoneConflict()).resolved).toBe(false)
})

it('delivers a self-contained conflict close ahead of a blocked start without deleting the old events', () => {
  const outbox = [
    { msg: { t: 'watch_start', sid: 'watch', eventId: 'blocked', dependencyEvents: true, dependsOn: [] }, nextAttemptAt: 99999 },
    { msg: { t: 'session_close', sid: 'watch', eventId: 'choice', protocolVersion: 3, conflictWith: 'phone', dependencyEvents: true, dependsOn: [] } },
  ]
  expect(selectReadyEvent(outbox, new Set(['blocked', 'choice']), {}, 1000, true)?.msg.eventId).toBe('choice')
  expect(outbox).toHaveLength(2)
})

it.each(['saved', 'abandoned'])('routes persistent conflict to Index, waits for exact %s commit, then activates only fresh phone state', async disposition => {
  vi.useFakeTimers()
  const h = watch(), { ctx } = h, p = phone(), sent = [], router = { replace: vi.fn() }
  const connection = { send({ data, success }) { sent.push(data); success() }, getReadyState({ success }) { success({ status: 1 }) } }
  Object.assign(ctx, { interconnect: { instance: () => connection }, console: { info() {} }, WATCH_VERSION: 'test', router,
    pendingCount: () => 0, isConnected: () => true })
  loadWatchModule('close-journal', ctx, ['prepareClose', 'journalEntry', 'pendingSummaries', 'pendingCloseEvents', 'pendingEntry', 'releaseCandidate', 'markPhase', 'markEntry', 'markDelivered'])
  loadWatchModule('session', ctx, ['loadState', 'save', 'startSession', 'buildSessionSummary', 'summaryEventOf', 'closeSession', 'applySync', 'replacePlan'])
  loadWatchModule('rpc', ctx, ['startServer', 'sendEvent', 'sendControl', 'resumePhoneConflict', 'replayPendingEvents', 'canResolvePhoneConflict', 'isPhoneConnected'])
  const conflict = vi.fn()
  ctx.startServer({ onConflict: conflict }); connection.onOpen()
  expect(ctx.isPhoneConnected()).toBe(false)
  connection.onMessage({ data: { t: 'hello_ack', protocolVersion: 3, capabilities: { inlineSnapshots: true, snapshotGenerations: true, sessionConflict: true, selectiveChunkAck: true, persistentTransfers: true, dependencyEvents: true } } })
  await vi.advanceTimersByTimeAsync(500)
  expect(ctx.isPhoneConnected()).toBe(true)
  const snap = snapshot(), first = makeTransfer(snap, 1), inline = job => ({ ...job.meta, t: 'sync_inline', snapshot: job.snapshot })
  connection.onMessage({ data: inline(first) }); await vi.advanceTimersByTimeAsync(500)
  expect(conflict).toHaveBeenCalled(); expect(ctx.loadState().sid).toBe('watch')
  runInNewContext(stripImports(watchSource('Index/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'this.page ='), ctx)
  const page = Object.assign(ctx.page, ctx.page.data)
  page.onInit({}); page.onReady()
  expect(page.onBackPress()).toBe(true); expect(router.replace).not.toHaveBeenCalled()
  await page.resolveConflict(disposition); await vi.advanceTimersByTimeAsync(500)
  expect(ctx.loadState().active).toBe(false); expect(page.conflictWaiting).toBe(true)
  // A premature phone snapshot cannot bypass the unresolved choice.
  const second = makeTransfer(snap, 2)
  connection.onMessage({ data: inline(second) }); await vi.advanceTimersByTimeAsync(500)
  expect(ctx.loadState().active).toBe(false)
  const ev = ctx.journalEntry('watch').closeEvent
  p.receive(ev); await p.receive.idle()
  const committed = p.deps.send.mock.calls.map(([m]) => m).find(m => m.t === 'committed' && m.eventId === ev.eventId)
  expect(committed.status).toBe('applied')
  connection.onMessage({ data: committed }); await vi.advanceTimersByTimeAsync(500)
  expect(page.conflict).toBeNull(); expect(ctx.phoneConflict()).toBeNull()
  const third = makeTransfer(snapshot(), 3)
  connection.onMessage({ data: inline(third) }); await vi.advanceTimersByTimeAsync(500)
  expect(ctx.loadState().sid).toBe('phone'); expect(router.replace).toHaveBeenLastCalledWith({ uri: '/Workout' })
  expect(p.state().workouts).toHaveLength(disposition === 'saved' ? 1 : 0)
  page.onDestroy(); p.receive.dispose()
  await vi.advanceTimersByTimeAsync(15001)
  expect(ctx.isPhoneConnected()).toBe(false)
})
