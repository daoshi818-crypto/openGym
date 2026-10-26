const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export const watchFieldKey = (entry, row, field) => [entry?.entryInstanceId || '', row?.setId || '', field].join(':')
export function stampWatchRevision(prev, next, actor = 'phone') {
  const a = next.active, old = prev.active
  if (!a) return
  const changes = []
  const oldEntries = old?.entries || []
  for (const e of a.entries || []) {
    const before = oldEntries.find(x => x.entryInstanceId === e.entryInstanceId)
    if (!same(e.sets?.map(r => r.setId), before?.sets?.map(r => r.setId))) changes.push(watchFieldKey(e, null, 'structure'))
    for (const row of e.sets || []) {
      const prior = before?.sets?.find(r => r.setId === row.setId)
      for (const [field, value] of [['weight', r => r?.w], ['reps', r => r?.sec ?? r?.reps ?? r?.r], ['done', r => !!r?.done], ['effort', r => [r?.rpe, r?.rir]]]) {
        if (!same(value(row), value(prior))) changes.push(watchFieldKey(e, row, field))
      }
    }
  }
  if (!same(old?.entries?.map(e => e.entryInstanceId), a.entries?.map(e => e.entryInstanceId))) changes.push('structure')
  for (const field of ['restVersion', 'pauseVersion', 'watchFocus']) if (!same(old?.[field], a[field])) changes.push(field)
  if (!changes.length) return
  a.syncRev = Math.max(a.syncRev || 0, old?.syncRev || 0) + 1
  a.syncFields = { ...a.syncFields }
  for (const key of changes) a.syncFields[key] = { rev: a.syncRev, actor }
}

export function watchConflict(S, ev) {
  const a = S.active
  if (!(ev.protocolVersion >= 3) || !Number.isFinite(ev.baseCommitRev) || !a || String(a.watchSid || a.start) !== ev.sid) return null
  if (ev.sessionEpoch && ev.sessionEpoch !== ev.sid) return { field: 'session', reason: 'stale_epoch', watch: ev }
  const entry = a.entries?.find(e => e.entryInstanceId === ev.entryInstanceId)
  const row = entry?.sets?.find(r => r.setId === ev.setId)
  const fields = ev.t === 'set' ? ['done', ...(ev.weight != null ? ['weight'] : []), ...(ev.reps != null ? ['reps'] : [])]
    : ev.t === 'unset' ? ['done'] : ['weight', 'reps', 'effort'].includes(ev.t) ? [ev.t] : ['add_set', 'remove_set'].includes(ev.t) ? ['structure'] : []
  const actor = ev.installationId || 'watch'
  for (const field of fields) {
    const version = a.syncFields?.[watchFieldKey(entry, field === 'structure' ? null : row, field)]
    if (version && version.rev > ev.baseCommitRev && version.actor !== actor) return { field, version, phone: row ? JSON.parse(JSON.stringify(row)) : null, watch: ev }
  }
  return null
}
