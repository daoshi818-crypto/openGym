import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { isOn } from '../lib/modules.js'
import { confirmSheet } from '../sheets.jsx'
import { Button, Section, Row } from '../components/ui.jsx'

const EVENTS = ['workout.finished','workout.pr','weighin.logged']
export default function Integrations() {
  const S = useStore(s => s.S), user = useStore(s => s.user), nav = useNavigate()
  const [hub,setHub] = useState(null), [error,setError] = useState(''), [busy,setBusy] = useState(false)
  const [url,setUrl] = useState(''), [label,setLabel] = useState(''), [events,setEvents] = useState([EVENTS[0]])
  const [reveal,setReveal] = useState(null), [log,setLog] = useState(null), [result,setResult] = useState('')
  const load = async () => setHub(await api('/api/integrations'))
  useEffect(() => {let live = true; if(user) api('/api/integrations').then(v => {if(live) setHub(v)}).catch(e => {if(live) setError(e.message)}); return () => {live = false}},[user?.id])
  const action = async (name,body) => {
    setBusy(true); setError(''); setResult('')
    try {const out = await api('/api/integrations/'+name,{method:'POST',body:JSON.stringify(body)}); if(out.reveal) {setReveal(out.reveal.secret);setUrl('')}; if(name === 'test') setResult(out.ok ? t('Test delivered') : t('Delivery failed')+': '+(out.msg || out.status || '')); if(name === 'retry') setResult(t('Queued for retry: {0}',out.requeued)); await load()}
    catch(e) {setError(e.message)} finally {setBusy(false)}
  }
  const enabled = isOn(S,'integrations'), webhook = hub?.providers?.some(p => p.id === 'webhook')
  return <div className="narrow feature-page"><Button variant="ghost" onClick={() => nav('/settings')}>{t('Back')}</Button><h1>{t('Integrations')}</h1>
    <p className="muted">{t('Connect devices, health apps and your own services without changing your training log.')}</p>
    <Section title={t('On this device')}>
      {isOn(S,'watch') && <Row title={t('vivo BlueOS watch')} accessory="chevron" onClick={() => nav('/settings/alerts')} />}
      {isOn(S,'health') && <Row title={t('Health')} accessory="chevron" onClick={() => nav('/settings/data')} />}
      {isOn(S,'coach') && <Row title={t('AI Coach')} accessory="chevron" onClick={() => nav('/coach')} />}
      <Row title={t('Import and export')} accessory="chevron" onClick={() => nav('/settings/data')} />
    </Section>
    <div className="card"><h2>{t('Webhooks')}</h2><p>{t('When a workout finishes, a new best is recorded or a weigh-in is logged, the server sends a signed event to your URL. Use it with Home Assistant or your own automation.')}</p>
    {!enabled && <p role="status">{t('Integrations are paused in Modules. Existing connections are kept.')}</p>}
    {!user && <p>{t('Sign in to a server to configure Webhooks. Local-only profiles cannot send server events.')}</p>}
    {user && hub && !webhook && <p>{t('The server administrator must set INTEGRATIONS=webhook and restart the API. Private network addresses require an explicit INTEGRATIONS_ALLOW_LAN=1 setting.')}</p>}
    {error && <p role="alert" className="danger">{error}</p>}{result && <p role="status">{result}</p>}
    {reveal && <div className="feature-secret"><strong>{t('Signing secret — shown once')}</strong><p>{t('Save this secret in your receiver. It is never stored in your synced profile.')}</p><code>{reveal}</code><Button onClick={() => setReveal(null)}>{t('Done')}</Button></div>}
    {webhook && <><form onSubmit={e => {e.preventDefault(); action('connect',{provider:'webhook',url,label,events})}}>
      <label>{t('Connection name')}<input value={label} maxLength={60} onChange={e => setLabel(e.target.value)} /></label>
      <label>{t('Receiver URL')}<input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://" autoComplete="off" /></label>
      <fieldset><legend>{t('Events')}</legend>{EVENTS.map(ev => <label className="feature-check" key={ev}><input type="checkbox" checked={events.includes(ev)} onChange={e => setEvents(v => e.target.checked ? [...v,ev] : v.filter(x => x!==ev))} />{ev}</label>)}</fieldset>
      <Button type="submit" variant="primary" disabled={busy || !enabled || !events.length || !!reveal}>{t('Add connection')}</Button>
    </form>{hub.connections.map(c => <div className="feature-connection" key={c.id}><h3>{c.label}</h3><div className="small muted">{c.info?.url} · {c.status} · {t('Queued')}: {c.queued} · {t('Failed')}: {c.failed}</div>
      {c.lastError && <p role="status">{c.lastError.msg}</p>}
      <div className="feature-presets"><Button disabled={busy} onClick={() => action('update',{id:c.id,paused:!c.paused})}>{c.paused ? t('Resume') : t('Pause')}</Button><Button disabled={busy || !enabled || c.paused} onClick={() => action('test',{id:c.id})}>{t('Send test event')}</Button><Button disabled={busy || !enabled || c.paused} onClick={() => action('retry',{id:c.id})}>{t('Retry')}</Button>
      <Button disabled={busy} onClick={async () => {try {setLog(await api('/api/integrations/log?id='+encodeURIComponent(c.id)))} catch(e) {setError(e.message)}}}>{t('Delivery log')}</Button>
      <Button variant="danger" disabled={busy} onClick={() => confirmSheet({title:t('Disconnect?'),message:t('Queued deliveries for this connection will be removed.'),onConfirm:() => action('disconnect',{id:c.id})})}>{t('Disconnect')}</Button></div></div>)}</>}
    {log && <div className="feature-log"><h3>{t('Delivery log')}</h3>{log.log.map((e,i) => <p className="small" key={i}>{new Date(e.at).toLocaleString()} · {e.ev} · {e.ok ? t('Success') : t('Failed')} {e.status || ''} {e.msg || ''}</p>)}<Button onClick={() => setLog(null)}>{t('Done')}</Button></div>}</div>
    {enabled && <div className="card"><h3>MCP</h3><p className="muted">{t('The optional MCP server is configured separately in your AI client. It is not enabled automatically by this page.')}</p></div>}
  </div>
}
