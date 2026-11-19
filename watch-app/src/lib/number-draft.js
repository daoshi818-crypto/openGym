import { captureRow, rowTarget } from './workout-interaction.js'

const text = v => v === '' || v == null ? '' : String(v)
const same = (a, b) => a && b && a.sid === b.sid && a.entryInstanceId === b.entryInstanceId &&
  a.setId === b.setId && a.exIdx === b.exIdx && a.setIdx === b.setIdx && a.weightUnit === b.weightUnit

// One bounded, raw draft for the shown unfinished set. Never a session copy or an event.
export function numberDraft(state, previous) {
  const target = captureRow(state), found = rowTarget(state, target)
  if (!found || found.row.done || state.pausedAt || state.restUntil || state.closeIntent) return null
  const draft = same(previous?.target, target) ? previous : { target, w: '', r: '', dirtyW: false, dirtyR: false }
  // Untouched fields follow the phone; deliberately edited fields stay with the lifter.
  if (!draft.dirtyW) draft.w = text(found.row.w)
  if (!draft.dirtyR) draft.r = text(found.row.r)
  return draft
}

export function changeNumber(draft, field, value) {
  if (!draft || !['w', 'r'].includes(field)) return false
  const n = Number(value)
  if (value !== '' && (!Number.isFinite(n) || n < 0 || n > (field === 'w' ? 99999.999 : 99999) || field === 'r' && !Number.isInteger(n))) return false
  draft[field] = value === '' ? '' : String(Math.round(n * 1000) / 1000)
  draft[field === 'w' ? 'dirtyW' : 'dirtyR'] = true
  return true
}

// Called inside the SAME durable transaction as set completion. No intermediate edits.
export function applyNumberDraft(state, draft) {
  if (!draft || !draft.dirtyW && !draft.dirtyR) return
  const current = captureRow(state), found = rowTarget(state, draft.target)
  if (!same(draft.target, current) || !found || found.row.done || state.pausedAt || state.restUntil || state.closeIntent)
    throw new Error('目标已变化，请重新填写')
  if (draft.dirtyW) found.row.w = draft.w
  if (draft.dirtyR) found.row.r = draft.r
}

export function keypadPress(buffer, key, field, replace) {
  if (key === 'back') return buffer.slice(0, -1)
  const start = replace ? '' : buffer
  if (key === '.') return field === 'w' && !start.includes('.') ? (start || '0') + '.' : buffer
  if (!/^[0-9]$/.test(key)) return buffer
  if (start.replace('.', '').length >= 8 || (!start.includes('.') && start.length >= 5) || (start.includes('.') && start.split('.')[1].length >= 3)) return buffer
  return start === '0' ? key : start + key
}
