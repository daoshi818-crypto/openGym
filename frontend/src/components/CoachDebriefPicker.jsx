import { useMemo, useState } from 'react'
import { t, tn } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import { Row, Segmented, Button, SelectRow } from './ui.jsx'
import { selectionForPlan, selectionForWorkout, workoutRows, workoutsForPlan, resolveDebriefSelection, refKey, workoutRefOf } from '../lib/debrief-selection.js'

const sessionSubtitle = w => [fmtDate(w.d, true), typeof w.start === 'number' && w.start > 0 ? new Date(w.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null].filter(Boolean).join(' · ')

export default function CoachDebriefPicker({ S, close, onConfirm, initialSelection }) {
  const plans = useMemo(() => (S.routines || []).filter(r => workoutsForPlan(S, r.id).length), [S.routines, S.workouts])
  const [mode, setMode] = useState('single')
  const [query, setQuery] = useState('')
  const [planId, setPlanId] = useState(plans[0]?.id || '')
  const [limit, setLimit] = useState(5)
  const [page, setPage] = useState(30)
  const [preview, setPreview] = useState(initialSelection || null)
  const [error, setError] = useState('')
  const rows = useMemo(() => workoutRows(S), [S.workouts])
  const filtered = rows.filter(({ w }) => !query.trim() || (String(w.name || '') + ' ' + w.d).toLowerCase().includes(query.trim().toLowerCase()))
  let selected = null
  if (preview) { try { selected = resolveDebriefSelection(S, preview) } catch { /* kept for explicit stale error */ } }
  const prepare = fn => { try { setPreview(fn()); setError('') } catch { setError(t('The selected training changed. Choose it again.')) } }
  const confirm = () => {
    if (!selected) return setError(t('The selected training changed. Choose it again.'))
    close(); onConfirm(preview)
  }
  return <div className="chat-menu coach-debrief-picker">
    <h3>{t('Review a workout')}</h3>
    {preview ? <>
      <p className="muted">{preview.mode === 'plan' ? S.routines?.find(r => r.id === preview.planId)?.name : t('One workout')}</p>
      {selected ? <>
        <p>{tn('{0} workout selected', '{0} workouts selected', selected.originals.length)}</p>
        {preview.mode === 'plan' && selected.originals.length < preview.limit && <p className="small muted">{t('Only {0} of the requested {1} workouts are available.', selected.originals.length, preview.limit)}</p>}
        {preview.mode === 'plan' && selected.originals.length === 1 && <p className="small muted">{t('Only one workout is available. This will be a single-session debrief.')}</p>}
        <div className="sect-b">{selected.originals.map(w => <Row key={refKey(workoutRefOf(w))} icon="checkCircle" title={w.name || t('Workout')} subtitle={sessionSubtitle(w)} />)}</div>
        {selected.records.some(w => w._mixedProjection) && <p className="small muted">{t('Combined workouts include only this plan’s exercises. Whole-session time and calories are not assigned to this plan.')}</p>}
        <p className="small muted">{t('The report will analyze these records and will not change your plan.')}</p>
        <Button variant="primary" onClick={confirm}>{t('Start debrief')}</Button>
      </> : <p role="alert">{t('The selected training changed. Choose it again.')}</p>}
      <Button onClick={() => { setPreview(null); setError('') }}>{t('Back')}</Button>
    </> : <>
      <Segmented value={mode} onChange={setMode} options={[{ value: 'single', label: t('One workout') }, { value: 'plan', label: t('Recent from a plan') }]} />
      {mode === 'single' ? <>
        <input className="field" value={query} onChange={e => { setQuery(e.target.value); setPage(30) }} placeholder={t('Search by date or workout')} style={{ margin: '10px 0' }} />
        <div className="sect-b">{filtered.slice(0, page).map(({ w, ref }) => <Row key={refKey(ref)} icon="checkCircle" iconTint="var(--green)" title={w.name || t('Workout')} subtitle={sessionSubtitle(w)} accessory="chevron" onClick={() => prepare(() => selectionForWorkout(S, w))} />)}</div>
        {!filtered.length && <div className="chat-empty">{t('No matching workouts')}</div>}
        {filtered.length > page && <Button onClick={() => setPage(n => n + 30)}>{t('Show more')}</Button>}
      </> : <>
        {plans.length ? <>
          <SelectRow title={t('Plan')} value={planId} options={plans.map(r => ({ value: r.id, label: r.name }))} onChange={setPlanId} />
          <div className="chips" style={{ margin: '10px 0' }}>{[3,5,10].map(n => <button key={n} className={'chip nocap' + (limit === n ? ' on' : '')} onClick={() => setLimit(n)}>{t('Last {0}', n)}</button>)}</div>
          <p className="small muted">{t('Combined legacy workouts without exercise ownership are available only as single-session debriefs.')}</p>
          <Button variant="primary" disabled={!planId} onClick={() => prepare(() => selectionForPlan(S, planId, limit))}>{t('Preview selected workouts')}</Button>
        </> : <div className="chat-empty">{t('No plan has saved workouts yet')}</div>}
      </>}
    </>}
    {!!error && <p role="alert">{error}</p>}
  </div>
}
