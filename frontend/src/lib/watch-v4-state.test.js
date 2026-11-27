import { describe, expect, it, vi } from 'vitest'
import { createDurableWatchLifecycle } from './watch-commit.js'
import { ensureWatchIdentity } from './watch-identity.js'

function state() {
  const S = { unit: 'kg', workouts: [], active: { start: 1000, watchSid: 'a', watchPhoneSession: true,
    watchSessionGeneration: 3, cur: 0, entries: [
      { id: 'bench', entryInstanceId: 'bench-1', sets: [{ setId: 'a1', w: 60, r: '8', done: true }] },
      { id: 'bench', entryInstanceId: 'bench-2', sets: [{ setId: 'b1', w: 70, r: '6', done: false }] },
    ] } }
  ensureWatchIdentity(S.active)
  return S
}

function rig(S = state()) {
  let disk
  const deps = { getState: () => S, update: mut => mut(S), isForeground: () => true,
    checkpoint: vi.fn(async () => { disk = structuredClone(S) }), finish: vi.fn(() => {
      S.workouts.push(S.active); S.active = null
    }), rest: vi.fn(), stop: vi.fn(), send: vi.fn(), sendSync: vi.fn() }
  const receive = createDurableWatchLifecycle(deps)
  return { S, disk: () => disk, deps, receive, dispatch: async ev => { expect(receive(ev)).toBe(true); await receive.idle() } }
}

const snapshot = (fields = {}) => ({ t: 'STATE_SNAPSHOT', protocolVersion: 4, sid: 'a', requestId: 'query-1',
  wireHash: 'hash-1', active: true, rev: 10, exIdx: 0, setIdx: 0,
  exercises: [{ entryInstanceId: 'bench-2' }], rows: [[{ setId: 'b1', done: true, w: 100, r: '20' }]],
  pausedAt: 1234, pausedMs: 10, restUntil: 0, ...fields })
const live = (fields = {}) => ({ t: 'set', protocolVersion: 4, phoneLed: true, sid: 'a', eventId: 'e1', rev: 11,
  phoneSessionGeneration: 3, entryInstanceId: 'bench-2', setId: 'b1', ex: 0, set: 1, weight: 72, reps: '7', at: 1500, ...fields })

describe('v4 phone session reconciliation', () => {
  it('adopts focused set and timers without importing disconnected set edits or erasing earlier sets', async () => {
    const a = rig()
    const before = structuredClone(a.S.active.entries)
    await a.dispatch(snapshot({ restLeftSec: 20, restTargetSec: 60 }))
    expect(a.disk().active).toMatchObject({ entries: before, cur: 1, watchFocus: { ex: 1, set: 1 }, pausedAt: 1234, pausedMs: 10 })
    expect(a.deps.rest).toHaveBeenCalledWith(expect.objectContaining({ sid: 'a', leftSec: 20, totalSec: 60, paused: true }))
    expect(a.deps.send).toHaveBeenCalledExactlyOnceWith({ t: 'STATE_SNAPSHOT_ACK', protocolVersion: 4, sid: 'a', requestId: 'query-1', wireHash: 'hash-1' })
    expect(a.deps.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(a.deps.send.mock.invocationCallOrder[0])
    expect(a.deps.sendSync).not.toHaveBeenCalled()
  })

  it('restores only the current focus after offline completion without importing the missed group', async () => {
    const S = state()
    S.active.entries[0].sets[0].done = false
    S.active.entries[0].sets.push({ setId: 'a2', w: 62, r: '8', done: false })
    const a = rig(S)
    const before = structuredClone(S.active.entries)
    await a.dispatch(snapshot({ exIdx: 0, setIdx: 1,
      exercises: [{ entryInstanceId: 'bench-1' }], rows: [[{ setId: 'a2', done: false, w: 62, r: '8' }]] }))
    expect(a.disk().active.watchFocus).toMatchObject({ ex: 0, set: 2 })
    expect(a.disk().active.entries).toEqual(before)
    expect(a.disk().active.entries[0].sets[0].done).toBe(false)
    expect(a.deps.sendSync).not.toHaveBeenCalled()
  })

  it('applies a live group once, routes by stable ID, and does not import stale or duplicate changes', async () => {
    const a = rig()
    await a.dispatch(snapshot())
    await a.dispatch(live({ eventId: 'stale', rev: 10 }))
    await a.dispatch(live({ eventId: 'wrong-session', sid: 'b' }))
    await a.dispatch(live({ eventId: 'old-generation', phoneSessionGeneration: 2 }))
    expect(a.S.active.entries[1].sets[0].done).toBe(false)
    const rest = { restId: 'rest-1', endsAt: Date.now() + 60_000, totalSec: 60 }
    await a.dispatch(live({ rest }))
    await a.dispatch(live({ eventId: 'duplicate-set', rev: 12, weight: 200, rest }))
    expect(a.S.active.entries[1].sets[0]).toMatchObject({ done: true, w: 72, r: '7' })
    expect(a.deps.rest.mock.calls.map(([value]) => value.restId)).toEqual([undefined, 'rest-1'])
    const reboot = rig(a.disk())
    await reboot.dispatch(live({ rest }))
    await reboot.dispatch(live({ t: 'SET_UNDONE', eventId: 'undo', rev: 13, entryInstanceId: undefined, setId: undefined, groupId: 'b1', weight: 100, reps: '10' }))
    expect(reboot.S.active.entries[1].sets[0]).toMatchObject({ done: false, w: 72, r: '7' })
    expect(reboot.S.active.entries[0].sets[0]).toMatchObject({ done: true, w: 60, r: '8' })
    expect(reboot.S.watchCommits).toBeUndefined()
    expect(reboot.deps.rest).not.toHaveBeenCalled()
    expect(reboot.deps.send).not.toHaveBeenCalled()
  })

  it('applies independent live fields and groups even when newer frames arrive first', async () => {
    const S = state()
    S.active.entries[0].sets[0].done = false
    const a = rig(S)
    await a.dispatch(snapshot())
    await a.dispatch(live({ t: 'focus', eventId: 'focus', rev: 16 }))
    await a.dispatch(live({ t: 'rest', eventId: 'rest', rev: 15, leftSec: 45 }))
    await a.dispatch(live({ eventId: 'second', rev: 14 }))
    await a.dispatch(live({ eventId: 'first', rev: 12, entryInstanceId: 'bench-1', setId: 'a1', weight: 62, reps: undefined }))
    await a.dispatch(live({ t: 'reps', eventId: 'reps', rev: 11, entryInstanceId: 'bench-1', setId: 'a1', weight: undefined, reps: '9' }))
    expect(a.disk().active.entries.map(e => e.sets[0])).toMatchObject([
      { done: true, w: 62, r: '9' }, { done: true, w: 72, r: '7' },
    ])
    expect(a.disk().active.watchFocus).toMatchObject({ ex: 1, set: 1 })
    expect(a.disk().watchRest.leftSec).toBe(45)
  })

  it('preserves newer values, completion state and rest against stale frames after reload', async () => {
    const a = rig()
    await a.dispatch(live({ t: 'weight', eventId: 'new-weight', rev: 17, weight: 78, reps: undefined }))
    await a.dispatch(live({ t: 'unset', eventId: 'undo', rev: 16 }))
    await a.dispatch(live({ t: 'rest', eventId: 'skip', rev: 15, leftSec: 0 }))
    const b = rig(a.disk())
    await b.dispatch(live({ t: 'weight', eventId: 'old-weight', rev: 14, weight: 50, reps: undefined }))
    await b.dispatch(live({ t: 'rest', eventId: 'old-rest', rev: 13, leftSec: 45 }))
    await b.dispatch(live({ eventId: 'old-completion', rev: 12 }))
    expect(b.disk().active.entries[1].sets[0]).toMatchObject({ done: false, w: 78, r: '6' })
    expect(b.disk().watchRest).toBeNull()
    expect(b.deps.rest).not.toHaveBeenCalled()
  })

  it('merges a delayed completion edge without overwriting a newer bundled field or accepting an old snapshot', async () => {
    const a = rig()
    await a.dispatch(live({ t: 'weight', eventId: 'weight', rev: 15, weight: 78, reps: undefined }))
    await a.dispatch(snapshot({ rev: 14, pausedAt: 100 }))
    await a.dispatch(live({ eventId: 'completed', rev: 13, weight: 72, reps: '7' }))
    expect(a.disk().active.entries[1].sets[0]).toMatchObject({ done: true, w: 78, r: '7' })
    expect(a.disk().active.pausedAt).toBeUndefined()
    expect(a.disk().active.watchV4Rev).toBe(15)
  })

  it('keeps a remove for an unseen set across reload and still accepts an older add for a different set', async () => {
    const a = rig()
    const removedId = 'watch-set:a:removed', retainedId = 'watch-set:a:retained'
    await a.dispatch(live({ t: 'remove_set', eventId: 'remove', rev: 13, sets: 2, removedSetIds: [removedId] }))
    const b = rig(a.disk())
    await b.dispatch(live({ t: 'add_set', eventId: 'late-add', rev: 12, sets: 3, newSetIds: [removedId] }))
    await b.dispatch(live({ t: 'add_set', eventId: 'other-add', rev: 11, sets: 2, newSetIds: [retainedId] }))
    expect(b.disk().active.entries[1].sets.map(row => row.setId)).toEqual(['b1', retainedId])
    expect(b.disk().active.watchV4Rev).toBe(13)
  })

  it('ignores invalid structural IDs and preserves tombstones across an accepted snapshot', async () => {
    const a = rig()
    const removedId = 'watch-set:a:removed'
    await a.dispatch(live({ t: 'remove_set', eventId: 'remove', rev: 11, removedSetIds: [null, '', 'a1', 'unknown', removedId] }))
    expect(a.disk().active.watchRemovedSets).toEqual([removedId])
    await a.dispatch(snapshot({ rev: 12 }))
    await a.dispatch(live({ t: 'add_set', eventId: 'repeat-add', rev: 13, newSetIds: [removedId, 'invalid'] }))
    expect(a.disk().active.entries.map(entry => entry.sets.map(row => row.setId))).toEqual([['a1'], ['b1']])
    expect(a.disk().active.watchV4Rev).toBe(12)
  })
  it('uses the accepted snapshot watermark for structural frames and keeps newer sets on stale snapshots', async () => {
    const a = rig()
    const oldId = 'watch-set:a:old', freshId = 'watch-set:a:fresh'
    await a.dispatch(snapshot({ rev: 12 }))
    await a.dispatch(live({ t: 'add_set', eventId: 'old-add', rev: 12, sets: 2, newSetIds: [oldId] }))
    await a.dispatch(live({ t: 'add_set', eventId: 'fresh-add', rev: 14, sets: 2, newSetIds: [freshId] }))
    await a.dispatch(snapshot({ rev: 13, requestId: 'stale-query' }))
    await a.dispatch(live({ t: 'remove_set', eventId: 'old-remove', rev: 12, sets: 1, removedSetIds: [freshId] }))
    expect(a.disk().active.entries[1].sets.map(row => row.setId)).toEqual(['b1', freshId])
    expect(a.disk().active.watchV4SnapshotRev).toBe(12)
    expect(a.disk().active.watchV4Rev).toBe(14)
  })
  it('settles a matching terminal against phone rows only and never resaves an already finished workout', async () => {
    const a = rig()
    await a.dispatch(snapshot())
    const terminal = snapshot({ active: false, rev: 0, terminal: { sid: 'a', disposition: 'saved', closedAt: 1800 } })
    await a.dispatch(terminal)
    expect(a.S.active).toBeNull()
    expect(a.S.watchClosed.a).toMatchObject({ disposition: 'saved', closedAt: 1800 })
    expect(a.S.workouts[0].entries[1].sets[0]).toMatchObject({ done: false, w: 70, r: '6' })
    expect(a.deps.finish).toHaveBeenCalledOnce()
    const reboot = rig(a.disk())
    await reboot.dispatch({ ...terminal, requestId: 'query-2', terminal: { ...terminal.terminal, disposition: 'discarded' } })
    expect(reboot.S.workouts).toHaveLength(1)
    expect(reboot.S.watchClosed.a.disposition).toBe('saved')
    expect(reboot.deps.finish).not.toHaveBeenCalled()
  })

  it('applies an abandoned watch terminal without saving phone history', async () => {
    const a = rig()
    await a.dispatch(snapshot({ active: false, rev: 0, terminal: { sid: 'a', disposition: 'abandoned', closedAt: 1800 } }))
    expect(a.S.active).toBeNull(); expect(a.deps.finish).not.toHaveBeenCalled()
    expect(a.S.watchClosed.a.disposition).toBe('abandoned')
  })

  it('does not close another session or import unknown watch workouts', async () => {
    const a = rig()
    await a.dispatch(snapshot({ sid: 'other', active: false, terminal: { sid: 'other', disposition: 'discarded', closedAt: 1800 } }))
    await a.dispatch(snapshot({ sid: 'other', requestId: 'query-2' }))
    expect(a.S.active.watchSid).toBe('a')
    expect(a.S.active.watchV4Rev).toBeUndefined()
    expect(a.deps.finish).not.toHaveBeenCalled()
  })

  it('retries a failed phone checkpoint without replaying the finish or acknowledging it early', async () => {
    const a = rig()
    a.deps.checkpoint.mockRejectedValueOnce(new Error('storage failed'))
    await a.dispatch(snapshot({ active: false, rev: 0, terminal: { sid: 'a', disposition: 'saved', closedAt: 1800 } }))
    expect(a.deps.send).not.toHaveBeenCalled()
    expect(a.deps.stop).not.toHaveBeenCalled()
    await a.receive.retry()
    a.receive.dispose()
    expect(a.disk().workouts).toHaveLength(1)
    expect(a.deps.finish).toHaveBeenCalledOnce()
    expect(a.deps.stop).toHaveBeenCalledOnce()
    expect(a.deps.send).toHaveBeenCalledOnce()
  })
})
