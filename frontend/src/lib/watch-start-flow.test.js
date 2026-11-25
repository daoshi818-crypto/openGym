import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { watchSnapshotOf, watchWorkoutDTOOf } from './watch-workout.js'
import { buildSessionEntries } from './session-start.js'
import { ensureWatchIdentity } from './watch-identity.js'
import { legacyWatchWorkout } from './watch-legacy-start-fixture.js'
import { applyChangeSet, canonicalPlan, planHash } from './coach.js'
import { validateChat } from '../../../api/coach/core/chat.js'
import { coachContext } from '../../../api/coach/core/context.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { rotationStep, valueStep } from '../../../watch-app/src/lib/value-step.js'
import { captureRow, rowTarget, setDotWindow } from '../../../watch-app/src/lib/workout-interaction.js'
import { createDurableWatchLifecycle } from './watch-commit.js'
import { applyEdit, applyRest, restOf } from '../../../watch-app/src/lib/protocol.js'
import { loadWatchModule, stripImports, watchPersistence, watchSource, watchInteractionDeps } from './watch-test-harness.js'
async function queuedLegacyStart() {
  const S = { workouts: [], unit: 'kg', routines: [{ id: 'back', name: 'Back', prog: 'off', ex: [{ id: '0025', sets: 4, reps: 8, weight: 40 }] }] }
  const plan = legacyWatchWorkout(), { ctx } = watchPersistence()
  Object.assign(ctx, { ...watchInteractionDeps, applyEdit, applyRest, console, WATCH_VERSION: 'test', router: { replace: vi.fn() } })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', ctx, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
  loadWatchModule('session', ctx, ['commitSessionStart', 'loadState', 'save', 'setRowValue', 'toggleSet', 'eventIdentity', 'nextUndone'])
  expect((await ctx.commitSessionStart(plan, {})).ok).toBe(true)
  const watch = ctx.loadState()
  return { S, event: watch.pendingEdits[0], watch, ctx }
}
function phone(S, extra = {}) {
  const deps = { getState: () => S, update: fn => fn(S), getTimer: () => null,
    send: vi.fn(), sendAck: vi.fn(), sendSync: vi.fn(), sendEnded: vi.fn(), completeInbox: vi.fn(),
    checkpoint: vi.fn(async () => {}), onStarted: vi.fn(), ...extra }
  return { receive: createDurableWatchLifecycle(deps), deps }
}
describe('compatibility for queued legacy watch starts', () => {
  it('opens after the queued legacy start has been checkpointed, never on duplicate', async () => {
    const { S, event, watch } = await queuedLegacyStart(); let release
    const app = phone(S, { checkpoint: vi.fn(() => new Promise(resolve => { release = resolve })) })
    expect(event.plan.entries[0].sets).toHaveLength(4)
    expect(event.sid).toBe(watch.sid)
    expect(app.receive(event)).toBe(true)
    expect(S.active?.watchSid).toBe(watch.sid)
    expect(app.deps.onStarted).not.toHaveBeenCalled()
    release(); await app.receive.idle()
    expect(app.deps.onStarted).toHaveBeenCalledExactlyOnceWith(watch.sid)
    expect(app.deps.send).toHaveBeenCalledWith(expect.objectContaining({ t: 'watch_start_ack', status: 'started', sid: watch.sid }))
    app.deps.checkpoint.mockResolvedValue(undefined)
    app.receive(event); await app.receive.idle()
    expect(app.deps.onStarted).toHaveBeenCalledTimes(1); app.receive.dispose()
  })
  it('opens after a failed checkpoint retries, without another session', async () => {
    const { S, event } = await queuedLegacyStart()
    const app = phone(S, { checkpoint: vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined) })
    app.receive(event); await app.receive.idle(); const active = S.active
    expect(app.deps.onStarted).not.toHaveBeenCalled()
    await app.receive.retry(); await app.receive.idle()
    expect(S.active).toBe(active)
    expect(app.deps.onStarted).toHaveBeenCalledExactlyOnceWith(event.sid); app.receive.dispose()
  })
  it.each(['conflict', 'closed', 'invalid_plan'])('does not replace/open a %s session', async status => {
    const { S, event } = await queuedLegacyStart()
    if (status === 'conflict') S.active = { start: 123, entries: [] }
    if (status === 'closed') S.watchClosed = { [event.sid]: { disposition: 'abandoned' } }
    if (status === 'invalid_plan') event.plan.entries = []
    const before = structuredClone(S.active), app = phone(S)
    app.receive(event); await app.receive.idle()
    expect(app.deps.onStarted).not.toHaveBeenCalled(); expect(S.active).toEqual(before); app.receive.dispose()
  })
  it.each([2, 3])('does not replay navigation after coordinator reconstruction (v%s)', async version => {
    const { S, event } = await queuedLegacyStart(); event.protocolVersion = version
    const app = phone(S); app.receive(event); await app.receive.idle(); app.receive.dispose()
    const restarted = phone(S); restarted.receive(event); await restarted.receive.idle()
    expect(restarted.deps.onStarted).not.toHaveBeenCalled(); restarted.receive.dispose()
  })
  it('does not let a router exception prevent a durable ACK', async () => {
    const { S, event } = await queuedLegacyStart()
    const app = phone(S, { onStarted: vi.fn(() => { throw new Error('router unavailable') }) })
    app.receive(event); await app.receive.idle()
    expect(app.deps.send).toHaveBeenCalledWith(expect.objectContaining({ t: 'watch_start_ack', status: 'started' }))
    expect(S.active.watchSid).toBe(event.sid); app.receive.dispose()
  })
  it('does not navigate a session replaced while the checkpoint was pending', async () => {
    const { S, event } = await queuedLegacyStart(); let release
    const app = phone(S, { checkpoint: () => new Promise(resolve => { release = resolve }) })
    app.receive(event); S.active = { watchSid: 'newer', entries: [] }; release(); await app.receive.idle()
    expect(app.deps.onStarted).not.toHaveBeenCalled(); app.receive.dispose()
  })
})

// These run the shipped session and page handlers. Only device storage/RPC and the
// enclosing UI finish callback are simulated; the completed-workout shape is production code.
describe('real watch row edits with AI template isolation', () => {
  it('crown draft → completed set → phone keeps the original event identity', async () => {
    const { S, event, ctx } = await queuedLegacyStart(), app = phone(S)
    app.receive(event); await app.receive.idle()
    Object.assign(ctx, { rotationStep, valueStep, captureRow, rowTarget, setDotWindow, restOf, tick() {},
      persistenceStatus: () => ({ failed: false }), pendingCount: () => 0 })
    runInNewContext(stripImports(watchSource('Workout/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'globalThis.workoutPage ='), ctx)
    const page = { ...ctx.workoutPage, ...ctx.workoutPage.data, state: ctx.loadState(), refresh: vi.fn() }
    const connection = { getReadyState: ({ success }) => success({ status: 0 }), send: ({ success }) => success() }
    ctx.interconnect = { instance: () => connection }
    loadWatchModule('rpc', ctx, ['startServer', 'sendEvent', 'replayPendingEvents'])
    ctx.startServer({}); connection.onOpen()
    connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true } })
    page.editWeight(); await page.onRotation({ delta: 1 })
    expect(ctx.loadState().pendingEdits.some(e => e.t === 'weight')).toBe(false)
    expect(await page.onComplete()).toBe(true)
    const edit = ctx.loadState().pendingEdits.find(e => e.t === 'set')
    expect(edit.t).toBe('set'); expect(edit.weight).toBe('40.5'); expect(edit.eventId).toBeTruthy()
    expect(ctx.runtime().rpc.outbox.find(e => e.msg.eventId === edit.eventId).msg).toEqual(edit)
    app.receive(edit); await app.receive.idle()
    expect(S.active.entries[0].sets[0].w).toBe(40.5)
    app.receive(edit); await app.receive.idle()
    expect(S.active.entries[0].sets[0].w).toBe(40.5)
    expect(S.routines[0].ex[0].sets).toBe(4)
    ctx.runtime().rpc.stop(); app.receive.dispose()
  })
  it('AI changes template 4→3; offline fourth watch row still commits and saves; next start has 3', async () => {
    const { S, event, ctx } = await queuedLegacyStart()
    const app = phone(S, { finish: end => { S.workouts.push(buildCompletedWorkout(S.active, { end })); S.active = null } })
    app.receive(event); await app.receive.idle()
    const validated = validateChat({ coach_contract: 1, chat_actions_contract: 1, replyType: 'proposal', answer: 'Confirm first', summary: 'Reduce sets', targetRoutineId: 'back',
      changes: [{ id: 'c', type: 'sets', target: { routineId: 'back', exId: '0025' }, after: 3, why: 'Requested' }], notes: [] }, canonicalPlan(S))
    expect(validated.ok).toBe(true)
    const p = { ...validated.proposal, kind: 'review', source: 'chat', id: 'isolation', revision: 1, runtimeIdentity: 'server|test',
      scope: { kind: 'routine', routineId: 'back' }, expiresAt: Date.now() + 60000, planHash: planHash(S), context: coachContext(S, planHash(S)) }
    expect(applyChangeSet(S, p, ['chat-c1'], { pending: structuredClone(p), runtimeIdentity: p.runtimeIdentity, currentRuntimeIdentity: p.runtimeIdentity }).applied).toBe(1)
    expect(S.active.entries[0].sets).toHaveLength(4)
    const watch = ctx.loadState(); expect(watch.workout.rows[0]).toHaveLength(4)
    watch.setIdx = 3; ctx.setRowValue(watch, 0, 3, 'w', '42', true)
    loadWatchModule('rpc', ctx, ['sendEvent'])
    ctx.sendEvent(watch.pendingEdits[0])
    const edit = ctx.loadState().pendingEdits.find(e => e.t === 'weight'), row = ctx.toggleSet(watch, true)
    const done = { ...ctx.eventIdentity(watch, 0, 3), ...ctx.allocateEventIdentity(watch.sid), t: 'set', sid: watch.sid,
      ex: 0, set: 4, weight: String(row.w), reps: String(row.r) }
    // Delivery resumes only after the template was already changed.
    app.receive(edit); app.receive(done); await app.receive.idle()
    expect(S.active.entries[0].sets[3]).toMatchObject({ w: 42, done: true })
    app.receive({ ...ctx.allocateEventIdentity(watch.sid), t: 'session_close', sid: watch.sid, disposition: 'saved', closedAt: Date.now() }); await app.receive.idle()
    expect(S.active).toBeNull()
    expect(S.workouts[0].entries[0].sets).toHaveLength(4)
    expect(S.workouts[0].entries[0].sets[3]).toMatchObject({ w: 42, done: true })
    const template = S.routines[0]
    const next = { ...S, active: { start: Date.now(), name: template.name, entries: buildSessionEntries(S, template) } }
    ensureWatchIdentity(next.active)
    const snapshot = watchSnapshotOf(next, null)
    const dto = watchWorkoutDTOOf({ ...snapshot, name: snapshot.workout }, snapshot.sid, 'next')
    expect(dto.exercises[0].sets).toHaveLength(3); app.receive.dispose()
  })
})
