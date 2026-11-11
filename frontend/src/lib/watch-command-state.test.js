import { describe, expect, it } from 'vitest'
import { createCommandStateCache } from './watch-command-state.js'
import { canonicalWire, expandWireDelta, wireHash, wireBytes } from '../../../watch-app/src/lib/sync-wire.js'
const copy = value => structuredClone(value)
function base() {
  return canonicalWire({ sid: 's', commitRev: 1, structureRevision: 'shape', workout: 'Workout',
    exercises: [0, 1].map(ex => ({ entryInstanceId: 'entry' + ex, name: 'Exercise ' + ex, sets: 5, setIds: [0,1,2,3,4].map(set => ex + ':' + set), weight: 50, reps: '8' })),
    rows: [0,1].map(ex => [0,1,2,3,4].map(set => ({ setId: ex + ':' + set, w: 50, r: '8', done: false, at: 0 }))), ackedEvents: [] })
}
const event = b => ({ t: 'set', sid: b.sid, eventId: 'A', protocolVersion: 3, baseCommitRev: b.commitRev, appliedRev: b.commitRev, appliedHash: b.wireHash })
describe('bounded canonical command corrections', () => {
  it('round trips the exact authoritative state with one event ACK instead of a growing history', () => {
    const cache = createCommandStateCache(), b = base(); cache.remember(b)
    const next = copy(b); next.commitRev++; next.rows[0][0].done = true
    next.ackedEvents = Array.from({length:128}, (_,i) => 'very-long-event-id-' + i)
    const delta = cache.prepare(event(b), next), result = expandWireDelta(b, delta)
    expect(result.rows[0][0].done).toBe(true)
    expect(result.ackedEvents).toEqual(['A'])
    expect(result.wireHash).toBe(canonicalWire(result).wireHash)
    expect(wireBytes(JSON.stringify(delta))).toBeLessThan(700)
    expect(cache.lookup({sid:'s',commitRev:2,wireHash:delta.wireHash})).toEqual(result)
  })
  it('updates first-row exercise defaults in a targeted cell without replacing the exercise list', () => {
    const cache = createCommandStateCache(), b = base(); cache.remember(b)
    const next = copy(b); next.commitRev++; next.exercises[0].weight = 80; next.rows[0][0].w = 80
    const delta = cache.prepare({...event(b),t:'weight'},next)
    expect(delta.exerciseCells).toHaveLength(1)
    expect(delta.changes.exercises).toBeUndefined()
    const result = expandWireDelta(b,delta)
    expect(result.exercises[0].weight).toBe(80); expect(result.rows[0][0].w).toBe(80)
    expect(result.exercises[1]).toEqual(b.exercises[1])
  })
  it.each(['add_set','remove_set','session_close','watch_start'])('keeps %s on the recovery protocol', t => {
    const cache = createCommandStateCache(), b = base(); cache.remember(b)
    expect(cache.prepare({...event(b),t},b)).toBeNull()
  })
  it.each([{protocolVersion:2},{protocolVersion:undefined},{sid:'other'},{appliedHash:'unknown'},{appliedRev:3}])('falls back without exact evidence: %j', invalid => {
    const cache = createCommandStateCache(), b = base(); cache.remember(b)
    expect(cache.prepare({...event(b),...invalid},b)).toBeNull()
  })
  it('uses the current applied transport base without changing the original causal version', () => {
    const cache = createCommandStateCache(), b = base(); cache.remember(b)
    const ev = {...event(b),baseCommitRev:0}
    expect(cache.prepare(ev,b)?.baseCommitRev).toBe(1)
    expect(ev.baseCommitRev).toBe(0)
  })
  it('falls back for structural changes even at identical exercise counts', () => {
    const cache = createCommandStateCache(), b = base(); cache.remember(b)
    const next = copy(b); next.exercises[0].setIds[0]='replacement'; next.rows[0][0].setId='replacement'
    expect(cache.prepare(event(b),next)).toBeNull()
  })
  it('does not encode a correction that exceeds the single-message budget', () => {
    const cache = createCommandStateCache(), b = base(); cache.remember(b)
    const next = copy(b); next.rows[0][0].r='长'.repeat(2000)
    expect(cache.prepare(event(b),next)).toBeNull()
  })
  it('evicts old encoding bases without losing decisions or mutating supplied snapshots', () => {
    const cache = createCommandStateCache(), b = base(); cache.remember(b)
    const original = copy(b)
    for(let i=2;i<20;i++)cache.remember(canonicalWire({...b,commitRev:i}))
    expect(cache.lookup(event(b))).toBeNull(); expect(b).toEqual(original)
  })
  it('rejects a corrupt correction and a changed structural target', () => {
    const cache = createCommandStateCache(), b = base(); cache.remember(b)
    const next=copy(b);next.rows[0][0].w=70;next.exercises[0].weight=70
    const delta=cache.prepare({...event(b),t:'weight'},next)
    expect(()=>expandWireDelta(b,{...delta,wireHash:'bad'})).toThrow('delta_checksum')
    const changed=copy(delta);changed.exerciseCells[0].exercise.entryInstanceId='other'
    expect(()=>expandWireDelta(b,changed)).toThrow('delta_structure')
    const {wireHash:hash,...value}=b;expect(wireHash(value)).toBe(hash)
  })
})

it('falls back when optional property order cannot reconstruct the canonical checksum', () => {
  const cache = createCommandStateCache(), b = base(); cache.remember(b)
  const { wireHash: ignored, ...data } = b
  const next = { optionalNewField: 'schema-change', ...data, commitRev: 2 }
  expect(cache.prepare(event(b), next)).toBeNull()
})
