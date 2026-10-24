import { convertWatchWeight } from './watch-identity.js'
import { applyWatchSummary } from './watch-session.js'
import { applyWatchEvent, applyWatchEffort } from './watch-events.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { hasCompletedWork, isWarmupRow } from './workout-model.js'
import { isoOf } from './format.js'

export function resolveWatchSave(S, key, accept) {
  const ev = S.watchPendingSaves?.[key]
  if (!ev) return
  if (accept) {
    const index = S.workouts.findIndex(w => w.watchSid === ev.sid || String(w.start) === ev.sid || w.watchSids?.includes(ev.sid))
    const record = JSON.parse(JSON.stringify(index >= 0 ? S.workouts[index] : {
      id: ev.sid, watchSid: ev.sid, start: ev.startedAt || ev.closedAt, d: isoOf(new Date(ev.startedAt || ev.closedAt)),
      name: ev.workout?.name || '手表训练', entries: [],
    }))
    const original = S.watchClosed?.[ev.sid]?.entries
    const source = original || (ev.workout?.exercises?.map((ex, i) => ({ id: ex.id, entryInstanceId: ex.entryInstanceId,
      sets: (ev.workout.rows[i] || []).map(r => ({ setId: r.setId, w: convertWatchWeight(r.w, ev.weightUnit || S.unit || 'kg', S.unit || 'kg'), ...(String(ex.reps).includes('秒') ? { sec: Number(r.r) || 0 } : { r: String(r.r) }), done: false })) })) || record.entries)
    if (!source.length || source.some(e => !e.id)) throw new Error('缺少原动作信息，已保留手表待确认记录')
    const used = new Set()
    const entries = source.map(entry => {
      const match = record.entries.findIndex((e, i) => !used.has(i) && (entry.entryInstanceId ? e.entryInstanceId === entry.entryInstanceId : e.id === entry.id))
      if (match < 0) return JSON.parse(JSON.stringify(entry))
      used.add(match)
      return JSON.parse(JSON.stringify(record.entries[match]))
    })
    entries.push(...record.entries.filter((entry, i) => !used.has(i)).map(entry => JSON.parse(JSON.stringify(entry))))
    const draft = { ...S, active: { ...record, entries, watchSid: ev.sid, watchEvents: [], watchVersions: {} } }
    for (const set of ev.completedSets || []) {
      const entry = set.entryInstanceId ? entries.find(e => e.entryInstanceId === set.entryInstanceId) : entries[set.ex]
      if (!entry) continue
      const rows = entry.sets.filter(r => !isWarmupRow(r))
      while (rows.length < set.set && rows.length < 100) { const row = { ...(rows.at(-1) || {}), setId: set.setId || undefined, done: false }; entry.sets.push(row); rows.push(row) }
    }
    for (const set of ev.completedSets || []) {
      applyWatchEvent(draft, { ...set, t: 'set', sid: ev.sid,
        eventId: key + ':' + set.ex + ':' + set.set, seq: ev.closedAt })
      // 离线合并也要保留评分与清除版本：旧摘要不能复活已清除评分。
      if (set.rpe != null || set.rir != null || set.effortCleared === true) {
        applyWatchEffort(draft, { ...set, t: 'effort', sid: ev.sid, clear: set.effortCleared === true,
          scale: set.rpe != null ? 'rpe' : 'rir', value: set.rpe != null ? set.rpe : set.rir,
          effortVersion: set.effortVersion || ev.closedAt,
          eventId: key + ':effort:' + set.ex + ':' + set.set })
      }
    }
    applyWatchSummary(draft, { ...ev, ...ev.summary, at: ev.closedAt })
    const completed = buildCompletedWorkout(draft.active, { end: Math.max(record.end || 0, ev.closedAt || 0),
      prs: record.prs || [], snapshotFor: entry => entry.muscleSnapshot })
    const result = { ...record, ...completed, id: record.id }
    if (Number.isFinite(Number(ev.summary?.minutes))) {
      const base = S.watchClosed?.[ev.sid]?.elapsedBeforeMs || 0
      result.durationMs = Math.max(record.durationMs ?? Math.max(0, (record.end || record.start) - record.start),
        base + Math.max(0, Number(ev.summary.minutes)) * 60000)
      result.end = record.start + result.durationMs
      result.finishedAt = Math.max(record.finishedAt || record.end || 0, ev.closedAt || 0)
    }
    if (index >= 0) S.workouts[index] = result
    else S.workouts.push(result)
  }
  S.watchSaveDecisions = { ...S.watchSaveDecisions, [key]: accept ? 'merged' : 'kept_phone' }
  delete S.watchPendingSaves[key]
}
