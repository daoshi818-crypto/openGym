// Derived from openGym v1.4.5 WatchLogic.kt Metrics / ZonesPage.kt (AGPL-3.0).
// The UI uses the square branch. No invented sample values or missing-age estimate.
export function maxHeartRate(birthYear, year = new Date().getFullYear()) {
  if (!Number.isInteger(birthYear)) return null
  const age = year - birthYear
  return age >= 10 && age <= 100 ? 208 - 0.7 * age : null
}
export function heartZone(bpm, max) {
  return bpm > 0 && max > 0 ? Math.max(1, Math.min(5, Math.floor(bpm * 10 / max + 1e-9) - 4)) : null
}
export function zoneView(hr, birthYear, year) {
  const max = maxHeartRate(birthYear, year)
  const times = [0, 0, 0, 0, 0]
  // Bounded per-bpm duration histogram preserves the upstream gap rule exactly,
  // without serializing an ever-growing array of raw samples with every row edit.
  for (const bpm of Object.keys(hr?.bpmSeconds || {})) {
    const z = heartZone(Number(bpm), max)
    if (z) times[z - 1] += hr.bpmSeconds[bpm]
  }
  const longest = Math.max(...times), current = heartZone(hr?.last, max)
  const clock = seconds => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0')
  return { max, rows: [5, 4, 3, 2, 1].map(z => {
    const color = ['#40C8E0','#A3E635','#FFD60A','#FF9F0A','#FF453A'][z - 1]
    const lo = z === 1 ? null : Math.ceil(max * (z + 4) / 10 - 1e-9)
    const hi = z === 5 ? null : Math.ceil(max * (z + 5) / 10 - 1e-9) - 1
    const duration = times[z - 1]
    return { key: String(z), cls: ['zone-teal','zone-green','zone-yellow','zone-orange','zone-red'][z - 1],
      color, border: max != null && z === current ? color : '#000000',
      zone: 'Z' + z, current: max != null && z === current, dim: max != null && current != null && current !== z,
      band: max == null ? '' : lo == null ? '<' + (hi + 1) : hi == null ? lo + '+' : lo + '–' + hi,
      time: clock(duration), fill: (duration > 0 && longest > 0 ? Math.max(11, 100 * duration / longest) : 0) + '%' }
  }) }
}
// Chinese labels are the existing upstream phone locale's MUSCLE_NAME translations.
const NAMES = { trapezius:'斜方肌', deltoids:'肩部', chest:'胸部', 'upper-back':'上背部', serratus:'前锯肌',
  biceps:'肱二头肌', triceps:'肱三头肌', forearm:'前臂', abs:'腹肌', obliques:'腹斜肌', 'lower-back':'下背部',
  gluteal:'臀部', quadriceps:'股四头肌', hamstring:'腘绳肌', adductors:'内收肌', 'hip-flexors':'髋屈肌', calves:'小腿', tibialis:'胫前肌' }
const SHADES = ['#A3E635','#7FB329','#628A20','#4E6E19','#3E5714']
export function muscleView(workout) {
  const tally = {}
  ;(workout?.exercises || []).forEach((ex, i) => {
    const done = (workout.rows[i] || []).filter(r => r.done && !r.warmup).length
    for (const slug of Object.keys(ex.muscles || {})) {
      const weight = ex.muscles[slug]
      if (Number.isFinite(weight) && weight > 0 && done) tally[slug] = (tally[slug] || 0) + done * weight
    }
  })
  const all = Object.keys(tally).map(key => ({ key, name:NAMES[key] || key, sets:tally[key] }))
    .sort((a,b) => b.sets - a.sets || a.name.localeCompare(b.name))
  const total = all.reduce((sum,r) => sum + r.sets, 0)
  let top = 0
  return { more: Math.max(0, all.length - 5), rows: all.slice(0,5).map((r,i) => {
    const share = r.sets / total, result = { ...r, value:String(Math.round(r.sets * 10) / 10), color:SHADES[i],
      top:top + 'px', height:Math.max(1, 260 * share - 5) + 'px' }
    top += 260 * share
    return result
  }) }
}
