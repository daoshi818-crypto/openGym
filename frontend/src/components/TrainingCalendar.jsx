import { useMemo, useState } from 'react'
import { t, tn, dateLocale } from '../lib/i18n.js'
import { DAYS, fmtDate, fmtDur, fmtVol, todayISO, weekStartOf } from '../lib/format.js'
import { dayLabelOf, monthCellsOf, monthDataOf, monthLabelOf } from '../lib/training-calendar.js'
import { Button } from './ui.jsx'
import Icon from './Icon.jsx'
import { WorkoutRow, workoutDetailSheet } from '../sheets.jsx'

const monthStart = date => new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0)

export default function TrainingCalendar({ S, onWorkout }) {
  const now = new Date()
  const [month, setMonth] = useState(() => monthStart(now))
  const [selected, setSelected] = useState(null)
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const weekStart = weekStartOf(S)
  const data = useMemo(() => monthDataOf(S.workouts, year, monthIndex), [S.workouts, year, monthIndex])
  const cells = useMemo(() => monthCellsOf(year, monthIndex, weekStart), [year, monthIndex, weekStart])
  const today = todayISO()
  const selectedDay = selected ? data.days.get(selected) : null
  const weekdayHeaders = Array.from({ length: 7 }, (_, offset) => DAYS[(weekStart + offset) % 7])
  const shiftMonth = delta => {
    setMonth(current => new Date(current.getFullYear(), current.getMonth() + delta, 1, 12))
    setSelected(null)
  }
  const goToday = () => {
    setMonth(monthStart(new Date()))
    setSelected(todayISO())
  }

  return <div className="training-calendar" data-training-calendar>
    <div className="row between training-calendar-nav">
      <button className="iconbtn" onClick={() => shiftMonth(-1)} aria-label={t('Previous month')}><Icon name="chevronLeft" /></button>
      <div className="training-calendar-title">
        <h2>{monthLabelOf(year, monthIndex, dateLocale())}</h2>
        <Button size="sm" variant="ghost" icon="calendar" onClick={goToday}>{t('Today')}</Button>
      </div>
      <button className="iconbtn" onClick={() => shiftMonth(1)} aria-label={t('Next month')}><Icon name="chevronRight" /></button>
    </div>

    <div className="training-calendar-summary" aria-label={t('This month')}>
      <div><strong>{data.trainingDays}</strong><span>{t('Training days')}</span></div>
      <div><strong>{data.trainingSessions}</strong><span>{t('Sessions')}</span></div>
      <div><strong>{data.muscles.length}</strong><span>{t('Muscle groups')}</span></div>
    </div>

    <div className="training-calendar-grid">
      {weekdayHeaders.map(day => <div className="training-calendar-weekday" key={day}>{t(day)}</div>)}
      {cells.map(cell => {
        const day = data.days.get(cell.iso)
        const active = selected === cell.iso
        const label = day?.muscles.length
          ? day.muscles.map(slug => t(dayLabelOf(slug))).join(', ')
          : day ? t('Workouts') : ''
        return <button key={cell.iso} className={'training-calendar-day' + (!cell.inMonth ? ' outside' : '') + (day ? ' trained' : '') + (active ? ' selected' : '') + (cell.iso === today ? ' today' : '')}
          disabled={!cell.inMonth}
          aria-pressed={active}
          aria-label={`${cell.iso}${label ? ' · ' + label : ''}`}
          onClick={() => cell.inMonth && setSelected(cell.iso)}>
          <span className="training-calendar-number">{cell.day}</span>
          {day && <span className="training-calendar-mark" aria-hidden="true" />}
          {day?.muscles.length ? <span className="training-calendar-muscles">{day.muscles.slice(0, 2).map(slug => t(dayLabelOf(slug))).join(' · ')}{day.muscles.length > 2 ? ' +' + (day.muscles.length - 2) : ''}</span> : day ? <span className="training-calendar-muscles">{t('Workouts')}</span> : null}
        </button>
      })}
    </div>

    {selectedDay ? <section className="training-calendar-details" aria-live="polite">
      <div className="row between" style={{ marginBottom: 8 }}>
        <div><h3>{fmtDate(selectedDay.iso, true, true)}</h3><div className="muted small">{tn('{0} session', '{0} sessions', selectedDay.sessions.length)} · {fmtDur(selectedDay.duration)} · {fmtVol(selectedDay.volume, S.unit)}</div></div>
        <Button size="sm" variant="ghost" icon="x" aria-label={t('Close')} onClick={() => setSelected(null)} />
      </div>
      {selectedDay.muscles.length ? <div className="mchips training-calendar-chips">{selectedDay.muscles.map(slug => <span className="mchip" key={slug}>{t(dayLabelOf(slug))}</span>)}</div> : <div className="muted small" style={{ marginBottom: 8 }}>{t('Workouts')}</div>}
      <div className="list">{selectedDay.sessions.map(session => {
        const workout = { ...session.workout, d: session.day, entries: session.workout.entries || [], vol: session.volume }
        return <WorkoutRow key={session.workout.id || `${session.day}-${session.index}`} w={workout} onClick={() => onWorkout ? onWorkout(session.workout) : workoutDetailSheet(workout)} />
      })}</div>
    </section> : selected ? <div className="training-calendar-hint muted small" aria-live="polite">{fmtDate(selected, true, true)} · {t('No workouts on this day.')}</div>
      : null}
  </div>
}
