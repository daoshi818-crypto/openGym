import { fingerprint } from '../../../api/coach/core/debrief-selection.js'
import { isWarmupRow } from './workout-model.js'
const id = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)
export const watchStructure = a => fingerprint((a?.entries || []).map(e => [e.entryInstanceId, e.id, e.sets.filter(r => !isWarmupRow(r)).map(r => r.setId)]))
// Called on the mutable training draft, so identities survive restarts and reordering.
export function ensureWatchIdentity(active, seed) {
  if (!active?.entries || active.editingWorkoutId) return
  const entries = new Set(), sets = new Set()
  active.entries.forEach((e, i) => {
    if (!e.entryInstanceId || entries.has(e.entryInstanceId)) e.entryInstanceId = seed ? seed + ':e:' + i : id()
    entries.add(e.entryInstanceId)
    e.sets.forEach((r, j) => {
      if (!r.setId || sets.has(r.setId)) r.setId = seed ? e.entryInstanceId + ':s:' + j : id()
      sets.add(r.setId)
    })
  })
  active.structureRevision = watchStructure(active)
  active.watchLegacyStructure ||= active.structureRevision
}
export function resolveWatchTarget(active, event) {
  if (!active) return null
  let index = event.ex
  if (event.entryInstanceId) index = active.entries.findIndex(e => e.entryInstanceId === event.entryInstanceId)
  else if (active.watchLegacyStructure && active.watchLegacyStructure !== watchStructure(active)) return null
  const entry = active.entries[index], rows = entry?.sets.filter(r => !isWarmupRow(r))
  if (!entry) return null
  const setIndex = event.setId ? rows.findIndex(r => r.setId === event.setId) : event.set - 1
  return { entry, rows, row: rows[setIndex], ex: index, set: setIndex + 1 }
}
export const convertWatchWeight = (value, from, to) => {
  if (value === '' || value == null) return value
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || !['kg','lb'].includes(from) || !['kg','lb'].includes(to)) return null
  return from === to ? n : Math.round(n * (from === 'lb' ? 0.45359237 : 1 / 0.45359237) * 1000) / 1000
}
