// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { finishWorkoutFromWatch } from '../sheets.jsx'
import { EXDB } from './exercises-data.js'
import { createDurableWatchLifecycle } from './watch-commit.js'
const clone = v => JSON.parse(JSON.stringify(v))
const S = () => useStore.getState().S
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear()
  const state = clone(DEF)
  state.active = { id: 'close-test', watchSid: 'close-sid', d: '2026-11-11', name: 'Close regression', start: Date.now() - 1200000,
    entries: [{ id: EXDB[0].id, entryInstanceId: 'entry', target: { mode: 'reps', sets: 1, reps: 8, weight: 40 }, sets: [{ setId: 'set', w: 40, r: 8, done: true }] }] }
  useStore.setState({ S: state, user: null })
  useUI.setState({ sheets: [], timer: null, work: null })
})
afterEach(() => { useUI.getState().stopRest(); useUI.getState().stopWork(); vi.restoreAllMocks(); vi.useRealTimers() })
describe('real phone close transaction and finish integration', () => {
  it.each(['saved', 'abandoned'])('%s checkpoints before commit and replays lost receipts without repeating finish', async disposition => {
    const finish = vi.fn(finishWorkoutFromWatch), sent = []
    const checkpoint = vi.fn(() => useStore.getState().checkpointWatchState())
      .mockRejectedValueOnce(new Error('disk unavailable'))
    const deps = { getState: S, getTimer: () => null,
      update: (fn, ev) => useStore.getState().update(fn, false, { watchActor: ev?.installationId || 'watch' }),
      transaction: fn => useStore.getState().withWatchTransaction(fn), checkpoint,
      finish, stop: () => { useUI.getState().stopRest(); useUI.getState().stopWork() },
      send: msg => sent.push(msg), sendAck() {}, sendSync() {}, sendEnded() {} }
    let receive = createDurableWatchLifecycle(deps)
    const event = { t: 'session_close', sid: 'close-sid', disposition, protocolVersion: 3, eventId: 'close:one', closedAt: Date.now() - 60000, at: Date.now() - 60000 }
    try {
      expect(receive(event)).toBe(true); await receive.idle()
      expect(sent).toEqual([])
      expect(S().active).toBeNull()
      expect(S().workouts).toHaveLength(disposition === 'saved' ? 1 : 0)
      expect(finish).toHaveBeenCalledTimes(disposition === 'saved' ? 1 : 0)
      await receive.retry(); await receive.idle()
      expect(sent).toContainEqual(expect.objectContaining({ t: 'committed', eventId: event.eventId, sid: event.sid, status: 'applied' }))
      const persisted = JSON.parse(localStorage.getItem('gym_state_v1'))
      expect(persisted.active).toBeNull()
      expect(persisted.watchClosed[event.sid].disposition).toBe(disposition)
      expect(persisted.workouts).toHaveLength(disposition === 'saved' ? 1 : 0)
      receive.dispose()
      useStore.setState({ S: persisted })
      receive = createDurableWatchLifecycle(deps)
      sent.length = 0
      receive(event); await receive.idle()
      expect(sent).toContainEqual(expect.objectContaining({ t: 'committed', eventId: event.eventId, status: 'applied' }))
      expect(S().workouts).toHaveLength(disposition === 'saved' ? 1 : 0)
      expect(finish).toHaveBeenCalledTimes(disposition === 'saved' ? 1 : 0)
      if (disposition === 'saved') expect(S().workouts[0].end).toBe(event.closedAt)
    } finally { receive.dispose() }
  })
})
