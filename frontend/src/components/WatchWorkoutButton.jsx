import { useRef, useState, useSyncExternalStore } from 'react'
import Icon from './Icon.jsx'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { continueOnWatch, onWatchConnection, watchConnection } from '../lib/watch-link.js'
import { watchSnapshotOf } from '../lib/watch-workout.js'

const available = () => watchConnection().canStartWorkout === true
const unavailable = () => false
const label = '在手表上继续训练'

export default function WatchWorkoutButton() {
  const canStart = useSyncExternalStore(onWatchConnection, available, unavailable)
  const launching = useRef(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(label)
  const open = async () => {
    if (launching.current || !available()) return
    const snapshot = watchSnapshotOf(useStore.getState().S, useUI.getState().timer)
    if (!snapshot) return
    launching.current = true
    setBusy(true)
    const report = msg => { setStatus(msg); useUI.getState().toast(msg) }
    try { await continueOnWatch(snapshot, report) }
    catch { report('手表未确认，请检查连接') }
    finally { launching.current = false; setBusy(false) }
  }
  if (!canStart && !busy) return null
  return <button className="iconbtn" disabled={busy || !canStart} aria-busy={busy} aria-label={label} title={status} onClick={open}><Icon name="watch" /></button>
}
