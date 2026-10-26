// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { useStore, DEF } from './useStore.js'
import { createDurableWatchLifecycle } from '../lib/watch-commit.js'
const clone = value => JSON.parse(JSON.stringify(value))
beforeEach(() => { localStorage.clear(); useStore.setState({ S: { ...clone(DEF), active: { start: Date.now(), watchSid: 's', entries: [{ id: 'plain-bench', sets: [{ w: 50, r: '8', done: false }] }] } }, user: null }) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('watch store transaction', () => {
  it('publishes close, history, energy and exact decision together across nested finish updates', async () => {
    const writes = [], real = localStorage
    vi.stubGlobal('localStorage', { getItem: key => real.getItem(key), removeItem: key => real.removeItem(key),
      setItem: (key, value) => { if (key === 'gym_state_v1') writes.push(JSON.parse(value)); real.setItem(key, value) } })
    const receive = createDurableWatchLifecycle({ getState: () => useStore.getState().S,
      update: (fn, ev) => useStore.getState().update(fn, false, { watchActor: ev?.installationId || 'watch' }),
      transaction: fn => useStore.getState().withWatchTransaction(fn), checkpoint: () => useStore.getState().checkpointWatchState(),
      getTimer: () => null, sendAck() {}, sendSync() {}, send() {}, sendEnded() {},
      finish: () => useStore.getState().update(s => { s.workouts.push({ ...s.active, watchSid: 's' }); s.active = null }) })
    receive({ t: 'end', sid: 's', eventId: 'end:A', at: Date.now(), calories: 42 }); await receive.idle()
    expect(writes.length).toBeGreaterThan(0)
    for (const s of writes) {
      expect(s.active).toBeNull()
      expect(s.workouts.at(-1).calories).toBe(42)
      expect(s.watchClosed.s.disposition).toBe('saved')
      expect(Object.keys(s.watchCommits)).toHaveLength(1)
    }
    receive.dispose()
  })
  it('stores the applied event and durable decision in one document with no intermediate disk state', async () => {
    const writes = [], real = localStorage
    vi.stubGlobal('localStorage', { getItem: key => real.getItem(key), removeItem: key => real.removeItem(key),
      setItem: (key, value) => { if (key === 'gym_state_v1') writes.push(JSON.parse(value)); real.setItem(key, value) } })
    const sendAck = vi.fn()
    const receive = createDurableWatchLifecycle({ getState: () => useStore.getState().S,
      update: (fn, ev) => useStore.getState().update(fn, false, { watchActor: ev?.installationId || 'watch' }),
      transaction: fn => useStore.getState().withWatchTransaction(fn), checkpoint: () => useStore.getState().checkpointWatchState(),
      getTimer: () => null, sendAck, sendSync() {}, send() {}, sendEnded() {}, finish() {} })
    receive({ t: 'set', sid: 's', eventId: 'A', ex: 0, set: 1, at: Date.now() }); await receive.idle()
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every(s => s.watchCommits && Object.keys(s.watchCommits).length === 1 && s.active.entries[0].sets[0].done)).toBe(true)
    expect(sendAck).toHaveBeenCalledOnce()
    receive.dispose()
  })
  it('rolls back a reducer exception and propagates a failed checkpoint', async () => {
    const before = clone(useStore.getState().S)
    expect(() => useStore.getState().withWatchTransaction(() => { useStore.getState().update(s => { s.active = null }); throw new Error('reducer') })).toThrow('reducer')
    expect(useStore.getState().S).toEqual(before)
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('quota') } })
    await expect(useStore.getState().checkpointWatchState()).rejects.toThrow('quota')
  })
})
