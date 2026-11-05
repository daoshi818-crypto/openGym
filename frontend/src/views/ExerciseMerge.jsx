import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { allExercises, searchExercises } from '../lib/exercises.js'
import { exerciseNameFor, t } from '../lib/i18n.js'
import { mergePreview, mergeBlocked, mergeExercise } from '../lib/exercise-merge.js'
import { confirmSheet } from '../sheets.jsx'
import { useUI } from '../store/useUI.js'
import { Button } from '../components/ui.jsx'

export default function ExerciseMerge() {
  const S = useStore(s => s.S), update = useStore(s => s.update), nav = useNavigate()
  const [params] = useSearchParams()
  const [from, setFrom] = useState(params.get('from') || ''), [into, setInto] = useState('')
  const [q, setQ] = useState(''), [selecting, setSelecting] = useState(from ? 'into' : 'from')
  const exercises = allExercises(S), source = exercises.find(e => e.id === from), target = exercises.find(e => e.id === into)
  const preview = mergePreview(S, from, into), blocked = mergeBlocked(S, from, into)
  const merge = () => confirmSheet({title: t('Merge exercises?'), message: t('The source is hidden and its history, routines, notes and aliases move to the target. Export a backup first; this cannot be undone here.'), onConfirm: () => {
    try { update(s => mergeExercise(s, from, into, {names: source ? [exerciseNameFor(source)] : []})); useUI.getState().toast(t('Exercises merged')); nav('/library') }
    catch(e) { useUI.getState().toast(t(e.message)) }
  }})
  return <div className="narrow feature-page">
    <Button variant="ghost" onClick={() => nav('/library')}>{t('Back')}</Button><h1>{t('Merge exercises')}</h1>
    <p className="muted">{t('Keep one exercise and bring duplicate records together. Weights are not converted between different equipment types.')}</p>
    <div className="card"><label>{t('Source exercise')}</label><Button onClick={() => setSelecting('from')}>{source ? exerciseNameFor(source) : t('Choose exercise')}</Button>
    <label>{t('Keep this exercise')}</label><Button onClick={() => setSelecting('into')}>{target ? exerciseNameFor(target) : t('Choose exercise')}</Button></div>
    <div className="card"><label htmlFor="merge-search">{selecting === 'from' ? t('Source exercise') : t('Keep this exercise')}</label>
    <input id="merge-search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search…')} />
    <div className="feature-results">{searchExercises(exercises,q).slice(0,60).map(ex => <button type="button" key={ex.id} onClick={() => { if(selecting === 'from') {setFrom(ex.id); setSelecting('into')} else setInto(ex.id); setQ('') }}>{exerciseNameFor(ex)}</button>)}</div></div>
    {source && target && <div className="card"><h3>{t('Merge preview')}</h3><p>{t('{0} workouts · {1} sets · {2} routines', preview.workouts, preview.sets, preview.routines)}</p><p className="muted">{t('Export a backup before merging.')}</p></div>}
    {blocked && <p className="muted">{t(blocked)}</p>}<Button variant="primary" disabled={!!blocked} onClick={merge}>{t('Merge exercises')}</Button>
  </div>
}
