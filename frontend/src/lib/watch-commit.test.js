import { describe, it, expect, vi } from 'vitest'
import { createDurableWatchLifecycle } from './watch-commit.js'
import { canonicalWire, diffWire } from '../../../watch-app/src/lib/sync-wire.js'
import { watchSnapshotOf } from './watch-workout.js'
import { ensureWatchIdentity } from './watch-identity.js'

const state = () => ({ workouts: [], active: { start: 1000, entries: [{ id: 'plain-bench', sets: [{ w: 60, r: '8', done: false }] }] } })
function app(S = state(), overrides = {}) {
  let disk
  const deps = { getState: () => S, update: fn => fn(S), getTimer: () => null,
    checkpoint: vi.fn(async () => { disk = structuredClone(S) }),
    send: vi.fn(), sendEnded: vi.fn(), sendSync: vi.fn(), sendAck: vi.fn(),
    finish: vi.fn(() => { S.workouts.push(S.active); S.active = null }),
    completeInbox: vi.fn(), holdOutbound: vi.fn(() => vi.fn()), status: vi.fn(), ...overrides }
  return { deps, receive: createDurableWatchLifecycle(deps), disk: () => disk, S }
}
const event = (eventId = 'A') => ({ t: 'set', sid: '1000', ex: 0, set: 1, eventId, at: 20, _inboxId: eventId })
describe('durable watch commits', () => {
  it('commits later operations even when a previous transport reply never settles', async () => {
    const a = app(undefined, { sendAck: vi.fn((at, id) => id === 'A' ? new Promise(() => {}) : undefined) })
    a.receive(event('A'))
    a.receive({ ...event('B'), t: 'unset', at: 21 })
    await a.receive.idle()
    expect(a.deps.sendAck.mock.calls.map(c => c[1])).toEqual(['A', 'B'])
    expect(a.disk().active.entries[0].sets[0].done).toBe(false)
    expect(a.deps.completeInbox).toHaveBeenCalledWith('B')
    a.receive.dispose()
  })
  it('commits an operation arriving after the queue drains and before the pump settles', async () => {
    const a = app(undefined, { status: vi.fn(({ phase }) => {
      if (phase === 'synced' && !a.deps.sendAck.mock.calls.some(([, id]) => id === 'B')) {
        queueMicrotask(() => a.receive({ ...event('B'), t: 'unset', at: 21 }))
      }
    }) })
    a.receive(event('A'))
    await a.receive.idle()
    expect(a.deps.sendAck.mock.calls.map(([, id]) => id)).toEqual(['A', 'B'])
    expect(a.disk().active.entries[0].sets[0].done).toBe(false)
    a.receive.dispose()
  })

  it('does not hold outgoing replies behind an event arriving during the previous reply', async () => {
    let blocked = false, receive
    const a = app(undefined, { holdOutbound: () => { blocked = true; return () => { blocked = false } },
      sendAck: vi.fn(async (at, id) => { if (id === 'A') receive(event('B')) }),
      sendSync: vi.fn(async () => { expect(blocked).toBe(false) }) })
    receive = a.receive
    receive(event()); await receive.idle()
    expect(a.deps.sendAck).toHaveBeenCalledTimes(2)
    receive.dispose()
  })
  it('claims synchronously but neither acknowledges nor drops inbox before the checkpoint', async () => {
    let done
    const a = app(undefined, { checkpoint: vi.fn(() => new Promise(resolve => { done = resolve })) })
    expect(a.receive(event())).toBe(true)
    expect(a.deps.sendAck).not.toHaveBeenCalled()
    expect(a.deps.completeInbox).not.toHaveBeenCalled()
    done(); await a.receive.idle()
    expect(a.deps.sendAck).toHaveBeenCalledWith(20, 'A')
    expect(a.deps.completeInbox).toHaveBeenCalledWith('A')
    a.receive.dispose()
  })
  it('retains failed head, blocks later commands and retries storage even with in-memory dedup', async () => {
    const a = app(undefined, { checkpoint: vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined) })
    a.receive(event()); await a.receive.idle()
    expect(a.deps.sendAck).not.toHaveBeenCalled()
    expect(a.deps.completeInbox).not.toHaveBeenCalled()
    expect(a.deps.status).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'storage_failed' }))
    a.receive({ ...event('B'), t: 'unset', at: 21 }); await a.receive.idle()
    expect(a.deps.checkpoint).toHaveBeenCalledTimes(3)
    expect(a.deps.sendAck.mock.calls.map(c => c[1])).toEqual(['A', 'B'])
    expect(a.S.active.entries[0].sets[0].done).toBe(false)
    a.receive.dispose()
  })
  it('recovers an exact decision after restart and does not finish twice on ACK loss', async () => {
    const a = app(), ev = { t: 'end', sid: '1000', eventId: 'end', at: 50, calories: 42 }
    a.receive(ev); await a.receive.idle()
    expect(a.deps.finish).toHaveBeenCalledOnce()
    const b = app(a.disk())
    b.receive(ev); await b.receive.idle()
    expect(b.deps.finish).not.toHaveBeenCalled()
    expect(b.deps.sendAck).toHaveBeenCalledWith(50, 'end')
    a.receive.dispose(); b.receive.dispose()
  })
  it('replays the persisted conflict rather than turning a duplicate into success', async () => {
    const S = state(); S.active.entries[0].sets[0] = { rpe: 8, effortVersion: 30 }
    const a = app(S), ev = { ...event(), t: 'effort', scale: 'rpe', value: 6, baseEffortVersion: 10, effortVersion: 40 }
    a.receive(ev); await a.receive.idle()
    const b = app(a.disk()); b.receive(ev); await b.receive.idle()
    expect(b.deps.send).toHaveBeenCalledWith(expect.objectContaining({ t: 'effort_ack', status: 'conflict', value: 8 }))
    a.receive.dispose(); b.receive.dispose()
  })
  it('reconciles every hello freshly and does not claim telemetry', async () => {
    const a = app()
    expect(a.receive({ t: 'sync_ack' })).toBe(false)
    a.receive({ t: 'hello', sid: '1000' }); await a.receive.idle()
    a.S.active = null
    a.receive({ t: 'hello', sid: '1000' }); await a.receive.idle()
    expect(a.deps.sendEnded).toHaveBeenCalled()
    a.receive.dispose()
  })
})


describe('command receipts carry the durable phone state', () => {
  it('sends the exact canonical delta after the checkpoint instead of a second transfer', async () => {
    let base
    const a = app(undefined, { commandState: (ev, snapshot) => diffWire(base, canonicalWire(snapshot)) })
    ensureWatchIdentity(a.S.active)
    base = canonicalWire(watchSnapshotOf(a.S, null))
    a.receive({ ...event(), protocolVersion: 3, baseHash: base.wireHash }); await a.receive.idle()
    const receipt = a.deps.send.mock.calls.find(([msg]) => msg.t === 'committed')[0]
    expect(receipt.state).toMatchObject({ t: 'sync_delta', baseHash: base.wireHash })
    expect(a.deps.sendSync).not.toHaveBeenCalled()
    expect(Object.values(a.disk().watchCommits)[0].decision).toEqual(receipt)
    const b = app(a.disk())
    b.receive({ ...event(), protocolVersion: 3, baseHash: base.wireHash }); await b.receive.idle()
    expect(b.deps.send).toHaveBeenCalledWith(receipt)
    expect(b.deps.sendSync).not.toHaveBeenCalled()
    a.receive.dispose(); b.receive.dispose()
  })
  it('keeps the transfer fallback when no exact command baseline is available', async () => {
    const a = app(undefined, { commandState: () => null })
    a.receive({ ...event(), protocolVersion: 3 }); await a.receive.idle()
    expect(a.deps.send.mock.calls[0][0].state).toBeUndefined()
    expect(a.deps.sendSync).toHaveBeenCalledOnce()
    a.receive.dispose()
  })
})

it('keeps a separate transfer when the entire inline receipt exceeds the SDK budget', async () => {
  const a = app(undefined, { commandState: () => ({ t: 'sync_delta', padding: '字'.repeat(2100) }) })
  a.receive({ ...event(), protocolVersion: 3 }); await a.receive.idle()
  expect(a.deps.send.mock.calls.find(([msg]) => msg.t === 'committed')[0].state).toBeUndefined()
  expect(a.deps.sendSync).toHaveBeenCalledOnce()
  a.receive.dispose()
})


it('covers automatic plan echoes only after checkpoint succeeds and before releasing outbound', async () => {
  const order = [], correction = { t: 'sync_delta', sid: '1000', wireHash: 'new', commitRev: 1 }
  const a = app(undefined, {
    commandState: () => correction,
    checkpoint: vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation(async () => { order.push('saved') }),
    commandStateCommitted: vi.fn(() => order.push('covered')),
    holdOutbound: () => () => order.push('released'), send: vi.fn(() => order.push('sent')),
  })
  try {
    a.receive({ ...event(), protocolVersion: 3 }); await a.receive.idle()
    expect(a.deps.commandStateCommitted).not.toHaveBeenCalled()
    expect(order).toEqual([])
    a.receive.retry(); await a.receive.idle()
    expect(a.deps.commandStateCommitted).toHaveBeenCalledWith(correction)
    expect(order).toEqual(['saved', 'covered', 'released', 'sent'])
  } finally { a.receive.dispose() }
})


it('quarantines a repeatable transactional v3 fault durably without success ACK or blocking independent events', async () => {
  let S = state(), durable, calls = 0
  const send = vi.fn(), sendAck = vi.fn()
  const deps = {
    getState: () => S, getTimer: () => null,
    update: fn => fn(S),
    checkpoint: async () => { durable = structuredClone(S) }, send, sendAck, sendSync() {}, sendEnded() {},
  }
  // Inject only into the business transaction, not into the failure-decision update.
  deps.transaction = (run, ev) => {
    const before = structuredClone(S)
    try { if (ev.eventId === 'bad' && calls++ < 3) { S.active.entries[0].sets[0].w = 999; throw new Error('bad business row') } run() }
    catch (e) { S = before; e.watchReducerRolledBack = true; throw e }
  }
  const receive = createDurableWatchLifecycle(deps)
  try {
    receive({ ...event('bad'), protocolVersion: 3 }); await receive.idle()
    receive.retry(); await receive.idle()
    receive.retry(); await receive.idle()
    const rejected = send.mock.calls.find(([m]) => m.eventId === 'bad')[0]
    expect(rejected).toMatchObject({ status: 'rejected', detail: { reason: 'business_exception' } })
    expect(durable.active.entries[0].sets[0].w).toBe(60)
    expect(Object.values(durable.watchCommits)[0].failedEvent.eventId).toBe('bad')
    expect(sendAck).not.toHaveBeenCalled()
    receive({ ...event('independent'), protocolVersion: 3 }); await receive.idle()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'independent', status: 'applied' }))
  } finally { receive.dispose() }
})


it('durably rejects edits from an older phone foreground generation', async () => {
  const S = state()
  S.active.watchSid = '1000'; S.active.watchPhoneSession = true; S.active.watchSessionGeneration = 2
  const a = app(S, { presenceSupported: () => true })
  a.receive({ ...event('stale-focus'), t: 'focus', sid: '1000', protocolVersion: 3, phoneSessionGeneration: 1 })
  await a.receive.idle()
  expect(a.deps.send).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'stale-focus', status: 'rejected', detail: expect.objectContaining({ reason: 'stale_phone_activation' }) }))
  expect(a.disk().active.watchFocus).toBeUndefined()
  a.receive.dispose()
})

it('accepts a same-session phone-led close while stale and ignores its watch payload', async () => {
  const a = app(undefined, { finish: vi.fn(() => { a.S.workouts.push({ calories: 7 }); a.S.active = null }) })
  a.S.active.watchSid = '1000'; a.S.active.watchPhoneSession = true; a.S.active.watchSessionGeneration = 2
  a.receive({ ...event('close'), t: 'session_close', sid: '1000', protocolVersion: 3, phoneSessionGeneration: 1, disposition: 'saved', calories: 999,
    completedSets: [{ ex: 0, set: 1, weight: 999, reps: '99' }] })
  await a.receive.idle()
  expect(a.deps.finish).toHaveBeenCalledOnce()
  expect(a.S.active).toBeNull()
  expect(a.S.workouts).toEqual([{ calories: 7 }])
  expect(a.S.watchClosed['1000']).toMatchObject({ phoneLedSession: true, eventId: 'close' })
  a.receive.dispose()
})
