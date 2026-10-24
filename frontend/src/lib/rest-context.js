// One structured description of the rest that is running, for the Android overlay.
//
// The overlay cannot read the React state (or even the WebView, once Android freezes it), so the
// page hands it a small, versioned summary. This module builds that summary from the live session
// and deliberately reuses the same superset / switch rules as the in-app flow — a plain
// `index + 1` would show the wrong exercise after a superset round or an exercise switch.
import { supersetUnits } from './history.js'
import { supersetFlowStep, nextUnfinishedUnit } from './supersetFlow.js'
import { isWarmupRow } from './workout-model.js'
import { watchSidOf } from './session-resume.js'
import { exOr } from './exercises.js'
import { exerciseNameFor } from './i18n-core.js'
import { effortKindOf, effortValueOf, effortSummaryText } from '../../../watch-app/src/lib/effort-scale.js'

export const REST_CONTEXT_VERSION = 1

const workRows = entry => (entry?.sets || []).filter(r => !isWarmupRow(r))
const hasWork = entry => workRows(entry).some(r => !r.done)

function firstUndone(entries, idx, after = -1) {
  const rows = workRows(entries[idx])
  const later = rows.findIndex((r, i) => i > after && !r.done)
  if (later >= 0) return { entryIdx: idx, rowIdx: later }
  const any = rows.findIndex(r => !r.done)
  return any >= 0 ? { entryIdx: idx, rowIdx: any } : null
}

/** The entry the rest belongs to: the one whose set was completed when the timer started. */
function completedTargetOf(entries, timer) {
  const idx = Number.isInteger(timer?.forIdx) ? timer.forIdx : null
  if (idx == null || !entries[idx]) return null
  const rows = workRows(entries[idx])
  const wanted = Number.isInteger(timer?.forSet) ? timer.forSet : -1
  // `forSet` indexes the entry's own `sets` array; map it onto the work rows.
  const entrySets = entries[idx].sets || []
  const rowIdx = wanted >= 0 && entrySets[wanted] && !isWarmupRow(entrySets[wanted])
    ? rows.indexOf(entrySets[wanted])
    : rows.reduce((last, r, i) => (r.done ? i : last), -1)
  if (rowIdx < 0) return null
  return { entryIdx: idx, rowIdx }
}

/**
 * Which set comes next after the rest that was earned by `timer.forIdx/forSet`.
 * Superset: round-robin to the next member that still has work. Plain: the next undone set of
 * the same exercise, else the first set of the next unfinished unit (wrapping once).
 */
export function nextTargetAfter(entries, timer) {
  if (!Array.isArray(entries) || !entries.length) return null
  const units = supersetUnits(entries)
  const from = Number.isInteger(timer?.forIdx) ? timer.forIdx : -1
  if (from < 0) {
    const first = units.map(u => u.find(i => hasWork(entries[i]))).find(i => i != null)
    return first == null ? null : firstUndone(entries, first)
  }
  const unit = units.find(u => u.includes(from)) || [from]
  if (unit.length > 1) {
    const step = supersetFlowStep(entries, unit, from)
    if (step && !step.unitDone && step.nextIdx != null) return firstUndone(entries, step.nextIdx)
  }
  const completed = completedTargetOf(entries, timer)
  const same = firstUndone(entries, from, completed && completed.entryIdx === from ? completed.rowIdx : -1)
  if (same) return same
  const nextUnit = nextUnfinishedUnit(entries, units, from)
  if (!nextUnit) return null
  const idx = nextUnit.find(i => hasWork(entries[i]))
  return idx == null ? null : firstUndone(entries, idx)
}

function targetPayload(S, entries, target, kind) {
  if (!target) return null
  const entry = entries[target.entryIdx]
  const rows = workRows(entry)
  const row = rows[target.rowIdx]
  if (!row) return null
  const ex = entry.id ? (S.customEx?.find(x => x.id === entry.id) || exOr(entry.id)) : null
  // A live entry resolves its display name the same way the watch plan does; a custom/offline
  // entry already carries one.
  const name = (entry.name && String(entry.name).trim()) || (entry.id ? exerciseNameFor(ex) : '')
  const timed = rows[0]?.sec != null || String(entry.target?.reps ?? '').includes('秒')
  const weight = row.w ?? entry.target?.weight ?? ''
  const effortKind = effortKindOf(row)
  const effort = effortKind ? effortSummaryText(effortKind, effortValueOf(row, effortKind)) : null
  const rawReps = timed ? null : (row.r ?? row.reps ?? entry.target?.reps ?? null)
  return {
    kind,
    entryId: entry.id || null,
    instanceId: entry.entryInstanceId || null,
    setId: row.setId || null,
    name: String(name || '').slice(0, 60),
    setNumber: target.rowIdx + 1,
    totalSets: rows.length,
    unit: S.unit || 'kg',
    weight: weight === '' || weight == null ? null : String(weight),
    reps: rawReps == null || rawReps === '' ? null : String(rawReps),
    seconds: timed ? Number(row.sec ?? entry.target?.sec) || null : null,
    effort,
  }
}

/**
 * @returns null when there is no rest, otherwise
 * {version, sid, restId, at, next, completed} with only display-ready, translated short labels.
 */
export function restContextOf(S, timer, now = Date.now()) {
  const A = S?.active
  if (!A || !timer || timer.ready) return null
  const entries = A.entries || []
  const completed = completedTargetOf(entries, timer)
  const next = nextTargetAfter(entries, timer)
  return {
    version: REST_CONTEXT_VERSION,
    sid: watchSidOf(A),
    restId: timer.restId || '',
    at: now,
    next: targetPayload(S, entries, next, 'next'),
    completed: targetPayload(S, entries, completed, 'completed'),
  }
}

/** Compact wire form for the native side: numbers stay numbers, strings are pre-translated. */
export function restContextWire(ctx) {
  if (!ctx) return ''
  try { return JSON.stringify(ctx) } catch { return '' }
}

export const restNextLine = next => {
  if (!next) return '返回训练查看'
  const w = next.weight && Number(next.weight) > 0 ? next.weight + next.unit : ''
  const r = next.seconds ? next.seconds + '秒' : next.reps ? next.reps + '次' : ''
  return '第' + next.setNumber + '/' + next.totalSets + '组' + (w || r ? ' · ' + [w, r].filter(Boolean).join(' × ') : '')
}
