// One bounded view of the watch calories attached to a completed workout.
// Missing data must stay missing: Number(null) and `value || 0` both turn an
// unavailable measurement into a believable but false zero.

export const finiteKcal = value => {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  return null
}

const versionOf = segment => {
  const seq = finiteKcal(segment?.seq)
  if (seq != null) return { kind: 'seq', value: seq }
  const at = finiteKcal(segment?.at)
  return at != null ? { kind: 'at', value: at } : { kind: 'none', value: 0 }
}

const newer = (a, b) => {
  const va = versionOf(a), vb = versionOf(b)
  if (va.kind === 'seq' && vb.kind === 'seq') return va.value >= vb.value
  if (va.kind === 'seq' && vb.kind !== 'seq') return true
  if (va.kind !== 'seq' && vb.kind === 'seq') return false
  return va.value >= vb.value
}

/**
 * @returns {{status:'available'|'partial'|'pending'|'missing'|'invalid', kcal:number|null,
 * source:'watch_estimate'|null, updatedAt:number|null}}
 */
export function workoutCaloriesOf(workout, sync = {}) {
  if (!workout) return { status: 'missing', kcal: null, source: null, updatedAt: null }
  const rawSegments = workout.watchSegments && typeof workout.watchSegments === 'object'
    ? workout.watchSegments : null
  const segments = rawSegments ? Object.entries(rawSegments).map(([sid, value]) => ({ sid, ...(value && typeof value === 'object' ? value : {}) })) : []

  // A segment map is authoritative. It already represents the workout as a sum of
  // independent watch sessions, so never add workout.calories on top of it.
  if (segments.length) {
    const valid = segments.map(s => ({ ...s, kcal: finiteKcal(s.calories) })).filter(s => s.kcal != null)
    if (!valid.length) return { status: 'invalid', kcal: null, source: null, updatedAt: null }
    const kcal = valid.reduce((sum, s) => sum + s.kcal, 0)
    if (!Number.isFinite(kcal)) return { status: 'invalid', kcal: null, source: null, updatedAt: null }
    const updatedAt = valid.reduce((max, s) => Math.max(max, finiteKcal(s.at) || 0), 0) || null
    const expected = Number(sync.expectedSegments)
    const status = valid.length < segments.length || (Number.isFinite(expected) && expected > valid.length) ? 'partial' : 'available'
    return { status, kcal, source: 'watch_estimate', updatedAt }
  }

  const kcal = finiteKcal(workout.calories)
  if (kcal != null && workout.calorieSource === 'watch_estimate') {
    return { status: 'available', kcal, source: 'watch_estimate', updatedAt: Number(workout.caloriesAt) || null }
  }
  if (sync.pending) return { status: 'pending', kcal: null, source: null, updatedAt: null }
  if (workout.calories != null || workout.calorieSource) return { status: 'invalid', kcal: null, source: null, updatedAt: null }
  return { status: 'missing', kcal: null, source: null, updatedAt: null }
}

export const kcalText = kcal => kcal == null ? null : Math.round(kcal).toLocaleString()

// Used by watch ingestion and tests to decide whether an incoming segment replaces
// an existing one. Equal versions are idempotent and must not add calories twice.
export const isSegmentAtLeast = newer

