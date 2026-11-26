import { useEffect, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { MOBILE, isAndroid, shareExport, onAppActive } from '../lib/mobile.js'
import { watchAvailable, watchState, onWatchState, connectWatch, disconnectWatch, openWatchApp, getWatchDeviceInfo, watchDevice, watchLastError, getWatchLogs, getWatchDiagnostics, requestWatchDiagnostics, onWatchCommitStatus, watchConnection, onWatchConnection, discoverWatchDevices, probeWatchConnection, openWatchHealth } from '../lib/watch-link.js'
import { collectWatchDiagnosticReport } from '../lib/watch-diagnostic-export.js'
import { Row, Button } from './ui.jsx'

export default function WatchIntegration() {
  const [android, setAndroid] = useState(false)
  const [status, setStatus] = useState(() => watchState())
  const [connection, setConnection] = useState(watchConnection)
  const [reason, setReason] = useState(null)
  useEffect(() => {
    if (!MOBILE) return
    let live = true
    isAndroid().then(async ok => {
      if (!live) return
      setAndroid(ok)
      if (ok) {
        const available = await watchAvailable()
        if (live) setReason(available.reason || null)
      }
    }).catch(() => {})
    const off = onWatchState(value => { if (live) setStatus(value) })
    const offConnection = onWatchConnection(value => { if (live) setConnection(value) })
    const expiry = setInterval(() => { if (!document.hidden) setConnection(watchConnection()) }, 5000)
    return () => { live = false; clearInterval(expiry); off?.(); offConnection?.() }
  }, [])
  if (!android) return null
  return <>
    <Row icon="watch" iconTint="var(--green)" title={t('vivo BlueOS watch')}
      subtitle={connection.appConnected ? '手表已确认连接'
        : connection.differentDevice ? '正在确认当前手表应用'
        : connection.selectionRequired ? '已发现手表，正在确认连接'
        : status === 'connected' ? '运动健康通道已连接，手表应用待确认'
        : status === 'connecting' ? t('Connecting… Make sure vivo Health is connected to the watch.')
        : reason === 'notVivo' ? t('Watch support needs a vivo phone.')
        : reason === 'healthMissing' ? t('vivo Health is not installed.')
        : t('Open the training app on the watch. The plan follows when a workout starts.')}
      accessory="chevron" onClick={() => useUI.getState().openSheet(close => <WatchPairSheet close={close} />)} />
  </>
}

export function WatchPairSheet({ close }) {
  const [status, setStatus] = useState(() => watchState())
  const [delivery, setDelivery] = useState({ phase: 'idle', pending: 0 })
  useEffect(() => onWatchCommitStatus(setDelivery), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState(() => watchDevice())
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState('')
  const [diag, setDiag] = useState(null)
  const [opening, setOpening] = useState(false)
  const [launchResult, setLaunchResult] = useState('')
  const [exportingLogs, setExportingLogs] = useState(false)
  const [connection, setConnection] = useState(watchConnection)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const off = onWatchState(setStatus)
    const offConnection = onWatchConnection(setConnection)
    return () => { off?.(); offConnection?.() }
  }, [])

  useEffect(() => {
    if (status !== 'ready' && status !== 'connected') return
    getWatchDeviceInfo().then(d => { if (d) setInfo(d) }).catch(() => {})
  }, [status])

  useEffect(() => {
    let live = true, running = false
    const refresh = async () => {
      if (!live || running || document.hidden) return
      running = true
      try {
        if (!watchConnection().peerId || watchConnection().differentDevice) await discoverWatchDevices()
        await probeWatchConnection()
        if (live) { setConnection(watchConnection()); setInfo(watchDevice()) }
      } catch { /* A failed probe stays unconfirmed. */ }
      finally { running = false }
    }
    refresh()
    const timer = setInterval(refresh, 5000), offActive = onAppActive(refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { live = false; clearInterval(timer); offActive?.(); document.removeEventListener('visibilitychange', refresh) }
  }, [])

  const check = async () => {
    if (checking) return
    setChecking(true); setError('')
    try {
      await discoverWatchDevices()
      if (!(await probeWatchConnection())) setError('手表应用尚未确认连接，请在运动健康中连接手表并打开手表应用')
      setInfo(watchDevice()); setConnection(watchConnection())
    } finally { setChecking(false) }
  }
  const connect = async () => {
    setError('')
    setBusy(true)
    const ok = await connectWatch()
    if (!ok) setError(watchLastError() || t('Could not connect'))
    setBusy(false)
  }

  const openLogs = async () => {
    setShowLogs(true)
    try {
      await requestWatchDiagnostics()
      const [l, d] = await Promise.all([getWatchLogs(), getWatchDiagnostics()])
      setLogs([(l && l.logs) || '', d ? `diagnostics=${JSON.stringify(d, null, 2)}` : ''].filter(Boolean).join('\n'))
      setDiag(d || null)
    } catch (e) {
      setLogs(String(e))
    }
  }

  const launch = async () => {
    setError('')
    setLaunchResult('')
    setOpening(true)
    try {
      const r = await openWatchApp()
      if (r.ok) setLaunchResult(t('Launch request accepted. Check the watch screen.'))
      else setError(`${t('Could not open watch app')} (code=${r.code}): ${r.data || ''}`)
    } finally { setOpening(false) }
  }

  const exportLogs = async () => {
    if (exportingLogs) return
    setExportingLogs(true); setError('')
    try {
      const report = await collectWatchDiagnosticReport()
      const json = JSON.stringify(report, null, 2), name = `openGym-watch-diagnostics-${Date.now()}.json`
      if (MOBILE) await shareExport(json, name)
      else {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
        const a = document.createElement('a'); a.href = url; a.download = name; a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch { setError('日志导出失败，请重试') }
    finally { setExportingLogs(false) }
  }

  const connected = status === 'connected'
  const dev = info && (info.device || info)
  return <>
    <h3>{t('Connect watch')}</h3>
    <p className="muted small">
      请先在 vivo 运动健康中绑定并连接手表。首次连接时，请在手表上打开 OpenGym。
    </p>
    <p className="muted small" role="status">手表连接：{connection.appConnected ? '已确认连接' : connection.sdkConnected ? '通道已连接，等待手表应用确认' : '未连接'}
      {connection.appConnected && connection.lastVerifiedAt > 0 && ` · 最近确认 ${new Date(connection.lastVerifiedAt).toLocaleTimeString()}`}
    </p>
    <p className="muted small">手机不会自动打开手表应用。训练中可点训练页的手表按钮启动并同步；手表应用主动打开时，也会同步手机当前训练和已完成组。</p>
    {dev && connected && <div className="list" style={{ margin: '10px 0 14px' }}>
      <div className="item">
        <span className="lrow-m">
          <span className="lrow-t">{dev.deviceName || dev.name || 'vivo WATCH'}</span>
          <span className="lrow-s">
            {dev.battery != null ? `${dev.battery}%` : ''}
            {dev.totalStorage != null && dev.freeStorage != null ? ` · ${Math.round(dev.freeStorage / 1048576)} / ${Math.round(dev.totalStorage / 1048576)} MB` : ''}
          </span>
        </span>
      </div>
    </div>}
    {status === 'connecting' && <p className="muted small">{t('Connecting…')}</p>}
    {delivery.phase !== 'idle' && <p className={delivery.phase === 'storage_failed' ? 'small danger' : 'muted small'} role="status">
      {delivery.phase === 'storage_failed' ? '保存失败，手表记录仍保留，释放手机存储后会重试' : delivery.pending ? `手机待保存 ${delivery.pending} 条` : '收到的手表记录已保存'}
    </p>}
    <p className="muted small">如两端有不同的进行中训练，请在手表上选择保存或放弃手表训练，手机训练继续。</p>
    {error && <p className="small danger" role="alert">{error}</p>}
    {launchResult && <p className="small muted" role="status">{launchResult}</p>}
    {showLogs && <>
      {diag && <p className="muted small" style={{ marginTop: 8 }}>
        vivo: {String(diag.vivo)} · health: {String(diag.healthInstalled)} · init: {String(diag.initialized)} · health RPC: {String(diag.healthDeviceVersion)} · bound: {String(diag.boundWatchDeviceCount)} · watch: {String(diag.watchConnected)}
      </p>}
      <pre className="small" style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: 8, borderRadius: 8 }}>
        {logs || t('No logs yet. Press Connect first.')}
      </pre>
    </>}
    <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
      <Button variant="ghost" disabled={checking || busy} onClick={check}>{checking ? '正在确认连接…' : '刷新并确认连接'}</Button>
      <Button variant="ghost" onClick={async () => { if (!(await openWatchHealth())) setError('无法打开 vivo 运动健康，请手动打开后切换设备') }}>打开运动健康</Button>
      <Button variant="primary" disabled={busy || opening || status === 'connecting'} onClick={launch}>{opening ? t('Opening watch app…') : t('Open watch app')}</Button>
      {!connected && <Button variant="ghost" disabled={busy || opening || status === 'connecting'} onClick={connect}>{busy ? t('Connecting…') : t('Connect')}</Button>}
      {(connected || status === 'ready') && <Button variant="danger" disabled={busy || opening} onClick={async () => { await disconnectWatch(); close() }}>{t('Disconnect')}</Button>}
      <Button variant="ghost" onClick={openLogs}>{t('Diagnostics')}</Button>
      <Button variant="ghost" icon="download" disabled={exportingLogs} onClick={exportLogs}>{exportingLogs ? '正在收集日志…' : '导出诊断日志'}</Button>
      <Button variant="ghost" onClick={close}>{t('Cancel')}</Button>
    </div>
  </>
}
