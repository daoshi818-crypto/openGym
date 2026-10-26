import { describe, it, expect, vi } from 'vitest'
import { createDurableWatchLifecycle } from './watch-commit.js'

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
