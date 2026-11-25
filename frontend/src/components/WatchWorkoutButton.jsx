import { useSyncExternalStore } from 'react'
import Icon from './Icon.jsx'
import { currentWorkoutWatchStatus, onCurrentWorkoutWatchStatus, retryCurrentWorkoutOnWatch } from '../lib/watch-current-workout.js'

const label = '重试同步本次训练到手表'
const hidden = { phase: 'idle' }
const server = () => hidden

export default function WatchWorkoutButton() {
  const { phase } = useSyncExternalStore(onCurrentWorkoutWatchStatus, currentWorkoutWatchStatus, server)
  if (phase !== 'failed' && phase !== 'conflict') return null
  return <button className="iconbtn" aria-label={label} title={phase === 'conflict' ? '手表已有训练，先在手表上结束，再重试' : label}
    onClick={retryCurrentWorkoutOnWatch}><Icon name="watch" /></button>
}
