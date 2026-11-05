import { hasPendingWatchWork } from '../lib/watch-link.js'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { MODULES, GROUPS, PRESETS, isOn, setModule, presetModules, turnedOff } from '../lib/modules.js'
import { t } from '../lib/i18n.js'
import { confirmSheet } from '../sheets.jsx'
import { useUI } from '../store/useUI.js'
import { Button, Section, Row, Switch } from '../components/ui.jsx'

// Form-video logging is not implemented in this fork; never advertise a non-working switch.
const supported = MODULES.filter(m => m.id !== 'videos')
export default function Modules() {
  const S = useStore(s => s.S), update = useStore(s => s.update)
  const nav = useNavigate()
  const change = next => {
    const off = turnedOff(useStore.getState().S, next)
    const canApply = () => {
      if (!turnedOff(useStore.getState().S, next).includes('watch')) return true
      if (useStore.getState().S.active) {
        useUI.getState().toast(t('Finish your current workout first')); return false
      }
      if (hasPendingWatchWork()) {
        useUI.getState().toast(t('Wait for watch sync to finish before pausing.')); return false
      }
      return true
    }
    if (!canApply()) return
    const apply = () => { if (canApply()) update(s => { for (const [id, on] of Object.entries(next)) setModule(s, id, on) }) }
    if (off.length) confirmSheet({ title: t('Pause these modules?'), message: t('Saved data is kept. Background work already in progress may finish; new work is paused until you turn the module back on.'), onConfirm: apply })
    else apply()
  }
  return <div className="narrow feature-page">
    <Button variant="ghost" onClick={() => nav('/settings')}>{t('Back')}</Button>
    <h1>{t('Modules')}</h1><p className="muted">{t('Choose what appears in openGym. Switching a module off never deletes its data.')}</p>
    <div className="feature-presets">{PRESETS.map(p => <Button key={p.id} onClick={() => change(presetModules(p.id))}>{t(p.title)}</Button>)}</div>
    {GROUPS.map(g => <Section key={g.id} title={t(g.title)}>{supported.filter(m => m.group === g.id).map(m => <Row key={m.id} title={t(m.title)} subtitle={m.id === 'watch' ? t('Log sets and sync workouts with your vivo BlueOS watch.') : t(m.desc)} children={<Switch aria-label={t(m.title)} checked={isOn(S,m.id)} onChange={v => change({[m.id]: v})} />} />)}</Section>)}
  </div>
}
