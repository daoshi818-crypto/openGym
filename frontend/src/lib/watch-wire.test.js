import { describe, it, expect } from 'vitest'
import { wireHash, wireBytes, splitWire, acceptWireChunk, diffWire, expandWireDelta } from '../../../watch-app/src/lib/sync-wire.js'
const snapshot = (rev = 1) => {
  const value = { t: 'sync', sid: 's', protocolVersion: 3, commitRev: rev, exercises: [{ entryInstanceId: 'e', sets: 2 }], rows: [[{ setId: 'a', done: false }, { setId: 'b', done: false }]] }
  return { ...value, wireHash: wireHash(value) }
}
describe('bounded snapshot and revision wire format', () => {
  it('reassembles duplicated, reordered Unicode chunks only when the entire checksum matches', () => {
    const next = { ...snapshot(), workout: '🦾中文训练'.repeat(3000) }, pending = {}
    const pieces = splitWire(next, 'transfer')
    expect(pieces.length).toBeGreaterThan(1)
    for (const p of pieces.slice(1).reverse()) { expect(acceptWireChunk(pending, p, 1)).toBe(null); expect(acceptWireChunk(pending, p, 1)).toBe(null) }
    expect(acceptWireChunk(pending, pieces[0], 2)).toEqual(next)
    expect(wireBytes('🦾中文')).toBe(10)
  })
  it('rejects corrupt chunks, mixed transfers, oversized input and expired partial assemblies', () => {
    const pieces = splitWire({ ...snapshot(), padding: 'a'.repeat(7000) }, 'a'), pending = {}
    acceptWireChunk(pending, pieces[0], 1)
    expect(() => acceptWireChunk(pending, { ...pieces[0], data: 'other' }, 2)).toThrow('chunk_mismatch')
    for (const p of pieces.slice(1, -1)) acceptWireChunk(pending, p, 3)
    expect(() => acceptWireChunk(pending, { ...pieces.at(-1), data: pieces.at(-1).data + 'x' }, 4)).toThrow('snapshot_checksum')
    expect(() => splitWire({ padding: '中'.repeat(50000) }, 'x')).toThrow('snapshot_too_large')
    acceptWireChunk(pending, pieces[0], 5)
    acceptWireChunk(pending, { ...pieces[1], transferId: 'new' }, 31006)
    expect(pending.a).toBeUndefined()
  })
  it('patches only changed cells, detects gaps and rejects a changed target', () => {
    const base = snapshot(), next = snapshot(2)
    next.rows[0][1].done = true
    const { wireHash: old, ...value } = next; next.wireHash = wireHash(value)
    const delta = diffWire(base, next)
    expect(delta.cells).toHaveLength(1)
    expect(expandWireDelta(base, delta)).toEqual(next)
    expect(() => expandWireDelta(snapshot(0), delta)).toThrow('revision_gap')
    expect(() => expandWireDelta(base, { ...delta, cells: [{ ex: 0, set: 1, row: { setId: 'other' } }] })).toThrow('delta_target')
  })
})
