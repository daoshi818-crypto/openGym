// Pure wire helpers shared with the phone. Hash detects incomplete/corrupt transfers,
// rather than authenticating the peer (the RPC channel handles pairing).
export function wireHash(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(16)
}
export function wireBytes(text) {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 128) bytes++
    else if (c < 2048) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}
export function splitWire(message, transferId) {
  const text = JSON.stringify(message)
  if (wireBytes(text) > 131072) throw new Error('snapshot_too_large')
  if (wireBytes(text) <= 6000) return [message]
  const pieces = []
  for (let i = 0; i < text.length;) {
    let end = Math.min(text.length, i + 1000)
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
    pieces.push(text.slice(i, end)); i = end
  }
  return pieces.map((data, index) => ({ t: 'sync_chunk', transferId, sid: message.sid, index, count: pieces.length,
    hash: wireHash(text), data }))
}
export function acceptWireChunk(pending, msg, now) {
  for (const id of Object.keys(pending)) if (now - pending[id].at > 30000) delete pending[id]
  if (typeof msg.transferId !== 'string' || msg.transferId.length > 128 || !Number.isInteger(msg.count) || msg.count < 1 || msg.count > 132 ||
      !Number.isInteger(msg.index) || msg.index < 0 || msg.index >= msg.count || typeof msg.data !== 'string' || msg.data.length > 1000) throw new Error('invalid_chunk')
  let transfer = pending[msg.transferId]
  if (!transfer) {
    if (Object.keys(pending).length >= 2) throw new Error('too_many_transfers')
    transfer = pending[msg.transferId] = { at: now, sid: msg.sid, count: msg.count, hash: msg.hash, chunks: {}, bytes: 0 }
  }
  if (transfer.hash !== msg.hash || transfer.count !== msg.count || transfer.sid !== msg.sid) throw new Error('chunk_mismatch')
  if (transfer.chunks[msg.index] != null && transfer.chunks[msg.index] !== msg.data) throw new Error('chunk_mismatch')
  if (transfer.chunks[msg.index] == null) { transfer.chunks[msg.index] = msg.data; transfer.bytes += wireBytes(msg.data) }
  if (transfer.bytes > 131072) { delete pending[msg.transferId]; throw new Error('snapshot_too_large') }
  if (Object.keys(transfer.chunks).length !== transfer.count) return null
  const text = Array.from({ length: transfer.count }, (_, i) => transfer.chunks[i]).join('')
  delete pending[msg.transferId]
  if (wireHash(text) !== transfer.hash) throw new Error('snapshot_checksum')
  const message = JSON.parse(text)
  if (!['sync', 'sync_delta'].includes(message.t) || message.sid !== msg.sid) throw new Error('invalid_snapshot')
  return message
}
export function diffWire(base, next) {
  if (!base || base.sid !== next.sid || JSON.stringify(base.exercises) !== JSON.stringify(next.exercises)) return null
  const changes = {}, cells = []
  for (const key of Object.keys(next)) {
    if (['rows', 't', 'wireHash'].includes(key)) continue
    if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) changes[key] = next[key]
  }
  for (let ex = 0; ex < next.rows.length; ex++) for (let set = 0; set < next.rows[ex].length; set++) {
    if (JSON.stringify(base.rows?.[ex]?.[set]) !== JSON.stringify(next.rows[ex][set])) cells.push({ ex, set, row: next.rows[ex][set] })
  }
  return { t: 'sync_delta', sid: next.sid, baseCommitRev: base.commitRev, baseHash: base.wireHash,
    commitRev: next.commitRev, changes, cells, wireHash: next.wireHash }
}
export function expandWireDelta(base, delta) {
  if (!base || base.sid !== delta.sid || base.commitRev !== delta.baseCommitRev || base.wireHash !== delta.baseHash) throw new Error('revision_gap')
  if (delta.commitRev < base.commitRev) throw new Error('stale_delta')
  const next = { ...JSON.parse(JSON.stringify(base)), ...delta.changes, wireHash: delta.wireHash }
  for (const cell of delta.cells || []) {
    if (!Number.isInteger(cell.ex) || !Number.isInteger(cell.set) || !next.rows?.[cell.ex]?.[cell.set] || next.rows[cell.ex][cell.set].setId !== cell.row?.setId) throw new Error('delta_target')
    next.rows[cell.ex][cell.set] = cell.row
  }
  const { wireHash: hash, ...value } = next
  if (wireHash(value) !== hash) throw new Error('delta_checksum')
  return next
}
