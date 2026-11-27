export function summarizeWorkoutRows(workout) {
  const exercises = workout?.exercises || []
  const rowsByExercise = workout?.rows || []
  let totalSets = 0, doneSets = 0, completedVolume = 0, completed = null
  for (let exIdx = 0; exIdx < rowsByExercise.length; exIdx++) {
    const rows = rowsByExercise[exIdx] || []
    const timed = String(exercises[exIdx]?.reps || '').includes('秒')
    totalSets += rows.length
    for (let setIdx = 0; setIdx < rows.length; setIdx++) {
      const row = rows[setIdx]
      if (!row.done) continue
      doneSets++
      if (!completed || row.at > completed.at) completed = { exIdx, setIdx, at: row.at || 0 }
      if (timed) continue
      const weight = parseFloat(row.w), reps = parseFloat(row.r)
      if (Number.isFinite(weight) && Number.isFinite(reps)) completedVolume += weight * reps
    }
  }
  return { totalSets, doneSets, completedVolume, completed }
}
