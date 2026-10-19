import { useState } from 'react'
import Icon from './Icon.jsx'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { continueOnWatch } from '../lib/watch-link.js'
import { watchSnapshotOf } from '../lib/watch-workout.js'

export default function WatchWorkoutButton() {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('在手表上继续训练')
  const open = async () => {
    const snapshot = watchSnapshotOf(useStore.getState().S, useUI.getState().timer)
    if (!snapshot || busy) return
    setBusy(true)
    try { await continueOnWatch(snapshot, msg => { setStatus(msg); useUI.getState().toast(msg) }) }
    finally { setBusy(false) }
  }
  return <button className="iconbtn" disabled={busy} aria-label="在手表上继续训练" title={status} onClick={open}><Icon name="watch" /></button>
}
