import { t } from '../lib/i18n.js'
import { fmtNum } from '../lib/format.js'
import { weeklyMuscleSets } from '../lib/muscle-targets.js'
import { muscleTargetsSheet } from './WeeklySets.jsx'
import { Button } from './ui.jsx'
import CardHead from './CardHead.jsx'

export default function WeeklyTargetsCard({ S }) {
  const rows = weeklyMuscleSets(S)
  return <div className="card"><CardHead icon="target" title={t('Weekly sets per muscle')} action={<Button size="sm" onClick={muscleTargetsSheet}>{t('Edit targets')}</Button>} />
    <p className="muted small">{t('Effective work sets this week, including secondary muscles. Targets are starting points, not a prescription.')}</p>
    <div className="weekly-targets">{rows.map(r => <div className="weekly-target" key={r.slug}>
      <div className="row between"><span>{t(r.name)}</span><span className="small">{fmtNum(r.sets)} / {r.lo}–{r.hi}</span></div>
      <meter min="0" max={Math.max(r.hi,r.sets,1)} low={r.lo} high={r.hi} optimum={(r.lo+r.hi)/2} value={r.sets} aria-label={t(r.name)} />
    </div>)}</div>
  </div>
}
