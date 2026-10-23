import storage from '@blueos.storage.storage'
import { runtime } from './runtime.js'
const clone = v => JSON.parse(JSON.stringify(v))
const data = () => runtime().persistence ||= { values: {}, queues: {}, errors: {} }
export function readStored(key) {
  const state = data()
  if (Object.prototype.hasOwnProperty.call(state.values, key)) return clone(state.values[key])
  const value = storage.getSync({ key })
  if (value != null) state.values[key] = clone(value)
  return value
}
export function writeStored(key, value) {
  const state = data()
  state.values[key] = clone(value)
  const q = state.queues[key] ||= { busy: false, dirty: false }
  q.dirty = true
  drain(key, state, q)
}
function drain(key, state, q) {
  if (q.busy || !q.dirty) return
  q.busy = true; q.dirty = false
  const value = clone(state.values[key])
  try { storage.set({ key, value,
    success() { q.busy = false; delete state.errors[key]; drain(key, state, q) },
    fail() { q.busy = false; q.dirty = true; state.errors[key] = 'write_failed' }
  }) } catch { q.busy = false; q.dirty = true; state.errors[key] = 'write_failed' }
}
export function retryStorage() { const state = data(); for (const key of Object.keys(state.queues)) drain(key, state, state.queues[key]) }
export function storageStatus() { const state = data(); return { failed: Object.keys(state.errors).length > 0, pending: Object.values(state.queues).some(q => q.busy || q.dirty) } }
