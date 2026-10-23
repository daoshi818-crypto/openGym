export * from '../../../api/coach/core/debrief-selection.js'
import { sortedWorkouts, workoutRefOf, resolveDebriefSelection } from '../../../api/coach/core/debrief-selection.js'
export const workoutRows = S => sortedWorkouts(S).reverse().map(w => ({ w, ref: workoutRefOf(w) }))
export function selectionLabel(S, selection) {
  const { originals } = resolveDebriefSelection(S, selection)
  const name = selection.mode === 'plan' ? S.routines.find(r => r.id === selection.planId)?.name : originals[0].name
  return [name || '', originals.length, originals[0].d + (originals.length > 1 ? ' – ' + originals.at(-1).d : '')].join(' · ')
}
