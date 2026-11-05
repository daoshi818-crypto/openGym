import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { todayISO, isoOf, weekStartOf, fmtNum, fmtVol } from '../lib/format.js'
import { reportData } from '../lib/report.js'
import { printReport } from '../lib/report-print.js'
import { recapSheet } from '../components/Recap.jsx'
import { isOn } from '../lib/modules.js'
import { Button, Segmented } from '../components/ui.jsx'

export default function Reports() {
  const S = useStore(s => s.S), nav = useNavigate()
  const [range,setRange] = useState('4w'), [from,setFrom] = useState(todayISO()), [to,setTo] = useState(todayISO()), [busy,setBusy] = useState(false)
  const valid = range !== 'custom' || (!!from && !!to && from <= to && Math.abs(new Date(to)-new Date(from)) <= 3660*86400000)
  const R = reportData(S, valid ? {range,from,to} : {range:'4w'})
  const pdf = async () => { setBusy(true); try { await printReport(S,{range,from,to}) } catch(e) { useUI.getState().toast(e.message || t('Could not create report')) } finally { setBusy(false) } }
  const recap = kind => {
    const now = new Date(todayISO()+'T12:00:00'), end = new Date(now), start = new Date(now)
    if(kind === 'month') {start.setDate(1); end.setDate(0); start.setMonth(start.getMonth()-1)}
    else {start.setDate(start.getDate() - (start.getDay()-weekStartOf(S)+7)%7 - 7); end.setTime(start.getTime()); end.setDate(end.getDate()+6)}
    recapSheet({kind,from:isoOf(start),to:isoOf(end),key:kind+':'+isoOf(start)})
  }
  return <div className="narrow feature-page"><Button variant="ghost" onClick={() => nav('/stats')}>{t('Back')}</Button><h1>{t('Performance report')}</h1>
    <p className="muted">{t('Your training, in one place. Reports are generated locally; sharing is always your choice.')}</p>
    {isOn(S,'motivation') && <div className="feature-presets"><Button onClick={() => recap('week')}>{t('Your week')}</Button><Button onClick={() => recap('month')}>{t('Your month')}</Button></div>}
    <Segmented value={range} onChange={setRange} options={[{value:'7d',label:t('7 days')},{value:'4w',label:t('4 weeks')},{value:'3m',label:t('3 months')},{value:'custom',label:t('Custom')}]} />
    {range === 'custom' && <div className="feature-dates"><label>{t('From')}<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>{t('To')}<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label></div>}
    {!valid && <p role="alert">{t('Choose a valid date range (up to 10 years).')}</p>}
    <div className="recap-tiles">{[[t('Workouts'),R.totals.workouts],[t('Volume'),fmtVol(R.totals.volume,S.unit)],[t('Sets'),R.totals.sets],[t('New bests'),R.totals.prs]].map(([label,value]) => <div className="recap-tile" key={label}><div className="recap-v">{typeof value === 'number' ? fmtNum(value) : value}</div><div className="small muted">{label}</div></div>)}</div>
    <p className="muted">{R.range.from} — {R.range.to}</p><Button variant="primary" disabled={busy || !valid} onClick={pdf}>{busy ? t('Preparing…') : t('Save as PDF')}</Button>
    <p className="small muted">{t('Use the system print dialog to save as PDF. Reports may contain workout and body data; check them before sharing.')}</p>
  </div>
}
