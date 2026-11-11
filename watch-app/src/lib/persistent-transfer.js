// Persistent snapshot transport. SDK concurrency is deliberately NOT implemented here:
// each call to next() yields one application message to the endpoint's single send gate.
import { wireHash, wireBytes } from './sync-wire.js'
export const TRANSFER_TTL = 86400000
const MAX_BYTES = 131072, MAX_CHUNKS = 132
const copy = value => JSON.parse(JSON.stringify(value))
const signature = m => JSON.stringify([m.transferId, m.sid, m.revision, m.generation, m.count, m.bytes, m.hash, m.encoding, m.hashAlgorithm])
const valid = m => typeof m.transferId === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(m.transferId) && typeof m.sid === 'string' && m.sid.length <= 256 &&
  Number.isSafeInteger(m.revision) && m.revision >= 0 && Number.isSafeInteger(m.generation) && m.generation >= 0 && Number.isInteger(m.count) && m.count > 0 && m.count <= MAX_CHUNKS &&
  Number.isInteger(m.bytes) && m.bytes > 0 && m.bytes <= MAX_BYTES && /^[0-9a-f]{1,8}$/.test(m.hash) && m.encoding === 'json-utf8' && m.hashAlgorithm === 'fnv1a-utf16-v1'
const matches = (a, b) => a.transferId === b.transferId && a.sid === b.sid && a.revision === b.revision && a.hash === b.hash
const receipt = (t, m, extra = {}) => ({ t, transferId: m.transferId, sid: m.sid, revision: m.revision, hash: m.hash, ...extra })
function serialOwner() {
  let tail = Promise.resolve()
  return task => { const next = tail.then(task); tail = next.catch(() => {}); return next }
}
async function put(store, key, value) { if (!(await store.write(key, copy(value)))) throw new Error('transfer_storage') }
export function makeTransfer(snapshot, generation, now = Date.now()) {
  const text = JSON.stringify(snapshot), chunks = []
  if (!['sync', 'sync_delta'].includes(snapshot.t) || wireBytes(text) > MAX_BYTES) throw new Error('snapshot_too_large')
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + 1000, text.length)
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
    chunks.push(text.slice(i, end)); i = end
  }
  const hash = wireHash(text)
  const meta = { transferId: 'p:' + now.toString(36) + ':' + generation + ':' + hash, sid: snapshot.sid, revision: snapshot.commitRev,
    generation, count: chunks.length, bytes: wireBytes(text), hash, encoding: 'json-utf8', hashAlgorithm: 'fnv1a-utf16-v1' }
  if (!valid(meta)) throw new Error('invalid_transfer')
  return { meta, chunks, snapshot, at: now, acknowledged: [], begun: false, attempts: 0, retryAt: 0 }
}
export function persistentReceiver(store, apply, now = () => Date.now()) {
  const serial = serialOwner(), key = 'sync_rx_v1'
  const chunkKey = (slot, i) => 'sync_rx_' + slot + '_' + i
  const index = async () => (await store.read(key)) || { jobs: [] }
  async function received(job) {
    const indexes = []
    let bytes = 0
    for (let i = 0; i < job.meta.count; i++) {
      const saved = await store.read(chunkKey(job.slot, i))
      if (saved?.id === job.meta.transferId && saved.index === i && typeof saved.data === 'string' && saved.data.length <= 1000 && wireHash(saved.data) === saved.hash) { indexes.push(i); bytes += wireBytes(saved.data) }
    }
    if (bytes > job.meta.bytes) throw new Error('transfer_size')
    return indexes
  }
  async function finish(state, job) {
    const indexes = await received(job)
    if (indexes.length !== job.meta.count) return null
    let text = ''
    for (let i = 0; i < job.meta.count; i++) text += (await store.read(chunkKey(job.slot, i))).data
    if (wireBytes(text) !== job.meta.bytes || wireHash(text) !== job.meta.hash) throw new Error('transfer_checksum')
    const message = JSON.parse(text)
    if (!['sync', 'sync_delta'].includes(message.t) || message.sid !== job.meta.sid || message.commitRev !== job.meta.revision) throw new Error('transfer_snapshot')
    // apply MUST persist its transferId marker with the training state. A retry after
    // state success/index failure is then an exact idempotent apply, not a new operation.
    const outcome = await apply(message, job.meta)
    if (!outcome?.ok) throw new Error(outcome?.error || 'snapshot_apply')
    job.applied = true; job.status = outcome.status || 'applied'
    await put(store, key, state)
    return receipt('sync_applied', job.meta, { status: outcome.status || 'applied' })
  }
  return {
    receive: msg => serial(async () => {
      const state = await index()
      state.jobs = state.jobs.filter(j => now() - j.at <= TRANSFER_TTL)
      let job = state.jobs.find(j => j.meta.transferId === msg.transferId)
      try {
        if (msg.t === 'sync_cancel') {
          if (job && !matches(job.meta, msg)) throw new Error('transfer_mismatch')
          state.jobs = state.jobs.filter(j => j !== job); await put(store, key, state)
          return [receipt('sync_cancel_ack', msg)]
        }
        if (msg.t === 'sync_begin') {
          if (!valid(msg)) throw new Error('invalid_transfer')
          if (job && signature(job.meta) !== signature(msg)) throw new Error('transfer_mismatch')
          if (!job) {
            // At most two fixed disk slots (264 chunk keys), never per-transfer key growth.
            if (state.jobs.length >= 2) {
              const retired = state.jobs.find(j => j.applied)
              if (!retired) throw new Error('transfer_capacity')
              state.jobs = state.jobs.filter(j => j !== retired)
            }
            const slot = [0, 1].find(s => !state.jobs.some(j => j.slot === s))
            job = { slot, meta: copy(msg), at: now(), applied: false }
            delete job.meta.t
            state.jobs.push(job)
            await put(store, key, state)
          }
          if (job.applied) return [receipt('sync_applied', job.meta, { status: job.status || 'applied' })]
          const complete = await finish(state, job)
          return complete ? [complete] : [receipt('sync_begin_ack', job.meta, { received: await received(job) })]
        }
        if (!job) return [receipt('unknown_transfer', msg)]
        if (!matches(job.meta, msg)) throw new Error('transfer_mismatch')
        if (job.applied) return [receipt('sync_applied', job.meta, { status: job.status || 'applied' })]
        if (msg.t === 'sync_resume') {
          const complete = await finish(state, job)
          return complete ? [complete] : [receipt('sync_resume', job.meta, { received: await received(job) })]
        }
        if (msg.t !== 'sync_chunk' || !Number.isInteger(msg.index) || msg.index < 0 || msg.index >= job.meta.count || typeof msg.data !== 'string' || !msg.data.length || msg.data.length > 1000) throw new Error('invalid_chunk')
        const ck = chunkKey(job.slot, msg.index), old = await store.read(ck)
        if (old?.id === job.meta.transferId && old.data !== msg.data) throw new Error('chunk_mismatch')
        // ACK only after actual chunk persistence; no rewrite of session_state per chunk.
        if (!old || old.id !== job.meta.transferId || old.index !== msg.index || old.hash !== wireHash(msg.data))
          await put(store, ck, { id: job.meta.transferId, index: msg.index, data: msg.data, hash: wireHash(msg.data) })
        const complete = await finish(state, job)
        return [receipt('sync_chunk_ack', job.meta, { index: msg.index }), ...(complete ? [complete] : [])]
      } catch (error) { return [receipt('sync_error', msg, { reason: String(error.message).slice(0, 80) })] }
    }),
  }
}
export function persistentSender(store, onApplied = () => {}, now = () => Date.now(), fullSnapshot = null, encode = null) {
  const serial = serialOwner(), key = 'sync_tx_v1'
  function prepare(snapshot, generation, compact) {
    const wire = compact && encode ? encode(copy(snapshot)) : snapshot
    const job = makeTransfer(copy(wire), generation, now())
    if (wire.t === 'sync_delta' && snapshot.t === 'sync') job.authoritativeSnapshot = copy(snapshot)
    return job
  }
  const stateOf = async () => (await store.read(key)) || { generation: 0, active: null, queued: null }
  return {
    enqueue: snapshot => serial(async () => {
      const state = await stateOf(), content = JSON.stringify(snapshot)
      if ([state.active, state.queued].some(j => j && JSON.stringify(j.authoritativeSnapshot || j.snapshot) === content)) return true
      if (state.active?.meta.sid === snapshot.sid && snapshot.commitRev < state.active.meta.revision) return false
      const job = prepare(snapshot, ++state.generation, !state.active)
      if (!state.active) state.active = job
      else state.queued = job // Never cancel an in-flight same-revision generation on every clock tick.
      await put(store, key, state); return true
    }),
    next: () => serial(async () => {
      const state = await stateOf(), job = state.active
      if (!job) return null
      if (now() - job.at > TRANSFER_TTL && !job.cancelReason) job.cancelReason = 'expired'
      if (now() < job.retryAt) return null
      let message
      if (job.cancelReason) message = receipt('sync_cancel', job.meta, { reason: job.cancelReason })
      else if (!job.begun) message = { ...job.meta, t: 'sync_begin' }
      else {
        const i = job.chunks.findIndex((_, i) => !job.acknowledged.includes(i))
        message = i < 0 ? receipt('sync_resume', job.meta) : receipt('sync_chunk', job.meta, { index: i, data: job.chunks[i] })
      }
      job.attempts++; job.retryAt = now() + Math.min(60000, 2000 * 2 ** Math.min(5, job.attempts - 1))
      await put(store, key, state)
      return message
    }),
    receipt: msg => serial(async () => {
      const state = await stateOf(), job = state.active
      if (!job || !matches(job.meta, msg)) return false
      const received = msg.received
      if (['sync_begin_ack', 'sync_resume'].includes(msg.t)) {
        if (!Array.isArray(received) || received.some(i => !Number.isInteger(i) || i < 0 || i >= job.chunks.length)) return false
        job.begun = true; job.acknowledged = [...new Set(received)]
      } else if (msg.t === 'sync_chunk_ack') {
        if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index >= job.chunks.length) return false
        if (!job.acknowledged.includes(msg.index)) job.acknowledged.push(msg.index)
      } else if (msg.t === 'sync_applied' && ['applied', 'retained'].includes(msg.status)) {
        // Retention is durable receipt of an older snapshot, NOT a Delta base.
        if (msg.status === 'applied') await onApplied(copy(job.authoritativeSnapshot || job.snapshot), copy(job.meta))
        state.failures = 0
        state.active = state.queued && msg.status === 'applied'
          ? prepare(state.queued.authoritativeSnapshot || state.queued.snapshot, ++state.generation, true)
          : state.queued
        state.queued = null
      } else if (msg.t === 'sync_cancel_ack' || (msg.t === 'unknown_transfer' && job.cancelReason)) {
        // Keep cancellation durable until its exact ACK (or unknown-transfer proof).
        // Never touch business Outbox/pendingEdits/close-journal here.
        let replacement = state.queued
        if (!replacement && job.cancelReason !== 'expired') {
          const full = job.authoritativeSnapshot || (job.snapshot.t === 'sync' ? job.snapshot : await fullSnapshot?.(copy(job.snapshot)))
          if (!full || full.t !== 'sync' || full.sid !== job.meta.sid) {
            job.lastError = 'full_snapshot_required'; job.retryAt = now() + 60000
            await put(store, key, state); return false
          }
          replacement = makeTransfer(copy(full), ++state.generation, now())
        }
        if (replacement) replacement.retryAt = now() + Math.min(60000, 2000 * 2 ** Math.min(5, (state.failures || 1) - 1))
        state.active = replacement; state.queued = null
      } else if (msg.t === 'unknown_transfer') { job.begun = false; job.acknowledged = [] }
      else if (msg.t === 'sync_error') {
        job.lastError = String(msg.reason || 'snapshot_error').slice(0, 80)
        if (['transfer_storage', 'transfer_capacity'].includes(msg.reason)) {
          // A temporary disk/capacity failure keeps exact bytes and backoff, not a cancel storm.
          await put(store, key, state); return false
        }
        job.cancelReason = job.lastError; state.failures = Math.min(6, (state.failures || 0) + 1)
      }
      else return false // Unrecognized receipts never advance the task.
      job.attempts = 0; job.retryAt = 0
      await put(store, key, state); return true
    }),
    wakeIn: () => serial(async () => { const s = await stateOf(); return s.active ? Math.max(0, s.active.retryAt - now()) : null }),
    resume: () => serial(async () => {
      const state = await stateOf()
      if (state.active) { state.active.begun = false; state.active.retryAt = 0; state.active.attempts = 0; await put(store, key, state) }
    }),
  }
}
