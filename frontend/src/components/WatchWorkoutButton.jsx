import { useSyncExternalStore } from 'react'
import Icon from './Icon.jsx'
import { currentWorkoutWatchStatus, onCurrentWorkoutWatchStatus, retryCurrentWorkoutOnWatch } from '../lib/watch-current-workout.js'

const label = '通过手表练'
const hidden = { phase: 'idle' }
const server = () => hidden

export default function WatchWorkoutButton() {
  const { phase } = useSyncExternalStore(onCurrentWorkoutWatchStatus, currentWorkoutWatchStatus, server)
  if (!['ready', 'failed', 'conflict', 'launching', 'handshake', 'starting'].includes(phase)) return null
  const busy = ['launching', 'handshake', 'starting'].includes(phase)
  const title = phase === 'conflict' ? '手表已有训练，先在手表上结束后再同步'
    : phase === 'failed' ? '重试同步本次训练到手表'
      : busy ? '正在连接并同步本次训练' : label
  return <button className="iconbtn" aria-label={label} title={title} disabled={busy}
    onClick={retryCurrentWorkoutOnWatch}><Icon name="watch" /></button>
}
