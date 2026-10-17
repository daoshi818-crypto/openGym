import { useLongPressReorder, REORDER_LONG_PRESS_MS, REORDER_DRAG_SLOP } from './use-long-press-reorder.js'
import { supersetUnits } from './history.js'

export const WORKOUT_LONG_PRESS_MS = REORDER_LONG_PRESS_MS
export const WORKOUT_DRAG_SLOP = REORDER_DRAG_SLOP

function geometry(list, entries) {
  const rows = new Map([...list.querySelectorAll('[data-workout-unit]')].map(row => [row.dataset.workoutUnit, row]))
  const visible = supersetUnits(entries).flatMap((unit, position) => {
    const row = rows.get(entries[unit[0]]?.occurrenceId)
    // Cards/Focus show only the current unit until a long press opens the overview.
    if (!row) return []
    const rect = row.getBoundingClientRect()
    if (!rect || !(rect.height > 0)) return [null]
    // Measure layout, not the held tile's painted translation. React can batch several
    // pointer/scroll frames before painting, so subtract what is on the DOM, not pending state.
    const translation = Number(row.style.transform.split(',')[1]?.replace('px', '').trim() || 0)
    const top = rect.top - translation
    return [{ unit: unit.map(index => entries[index].occurrenceId), position, top, bottom: rect.bottom - translation, center: top + rect.height / 2 }]
  })
  return visible.length && visible.every(Boolean) ? visible : null
}

export function useWorkoutReorder(sessionId, entries, onDrop, { enabled = true, onLift } = {}) {
  return useLongPressReorder(sessionId, entries, onDrop, {
    enabled, onLift, geometry, followLayout: true, captureList: true,
    rowSelector: '[data-workout-unit]', sourceOf: row => row.dataset.workoutUnit,
    ignored: 'button:not(.wl-summary),a,input,textarea,select,[data-nodrag],[role="slider"],[contenteditable="true"],video[controls],audio,.chips,.swrow',
  })
}
