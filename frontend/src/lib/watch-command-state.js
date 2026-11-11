import { canonicalWire, diffWire, expandWireDelta, wireBytes } from '../../../watch-app/src/lib/sync-wire.js'

const COMMANDS = new Set(['weight', 'reps', 'set', 'unset', 'focus', 'rest', 'pause', 'effort'])
// This cache is an optimization, never a source of business decisions. After a
// restart/eviction the exact durable event still succeeds through normal sync.
export function createCommandStateCache() {
  const snapshots = new Map()
  let bytes = 0
  function remember(snapshot) {
    if (!snapshot?.wireHash) return
    const size = wireBytes(JSON.stringify(snapshot)), prior = snapshots.get(snapshot.wireHash)
    if (prior) return
    snapshots.set(snapshot.wireHash, { snapshot: JSON.parse(JSON.stringify(snapshot)), size }); bytes += size
    while (snapshots.size > 16 || bytes > 524288) {
      const [hash, value] = snapshots.entries().next().value
      snapshots.delete(hash); bytes -= value.size
    }
  }
  function lookup(event) {
    const base = snapshots.get(event.appliedHash || event.baseHash || event.wireHash)?.snapshot
    return base?.sid === event.sid && base.commitRev === (event.appliedRev ?? event.baseCommitRev ?? event.commitRev) ? base : null
  }
  return { remember, lookup,
    prepare(event, snapshot) {
      if (!(event.protocolVersion >= 3) || !COMMANDS.has(event.t)) return null
      const base = lookup(event)
      if (!base || !snapshot || base.sid !== snapshot.sid) return null
      // Exact receipts settle their own event; do not grow a 128-ID history per click.
      const next = canonicalWire({ ...snapshot, ackedEvents: [event.eventId] }), delta = diffWire(base, next, true)
      if (!delta || wireBytes(JSON.stringify(delta)) > 4500 || wireBytes(JSON.stringify(delta)) >= wireBytes(JSON.stringify(next))) return null
      // Existing wire hashes include JSON property order. Optional schema changes
      // must round trip exactly; otherwise use the full-state recovery protocol.
      try { expandWireDelta(base, delta) } catch { return null }
      remember(next)
      return delta
    },
  }
}
