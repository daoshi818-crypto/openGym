import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { resolveWatchSave } from '../lib/watch-recovery.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from './Icon.jsx'

export default function WatchSaveReview() {
  const pending = useStore(s => s.S.watchPendingSaves)
  const first = Object.entries(pending || {})[0]
  if (!first) return null
  const [key, ev] = first
  const decide = accept => {
    try { useStore.getState().update(s => resolveWatchSave(s, key, accept)) }
    catch (e) { useUI.getState().toast(e.message) }
  }
  const review = () => confirmSheet({ title: '手表离线训练待确认',
    message: '手机已结束这场训练。是否将手表补记的 ' + (ev.completedSets?.length || 0) + ' 组和训练总结合并到手机记录？',
    confirmText: '确认合并', cancelText: '保留手机记录',
    onConfirm: () => decide(true), onCancel: () => decide(false) })
  return <button className="btn ghost" onClick={review}><Icon name="watch" />手表离线训练待确认</button>
}
