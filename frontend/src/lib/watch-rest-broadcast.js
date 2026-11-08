import { watchSidOf } from './session-resume.js'

// The phone broadcasts only locally originated rest changes.
export function broadcastPhoneRest({ enabled, active, timer, stopSource, update, send }) {
  if (!enabled || !active?.start || timer?.source === 'watch' || (!timer && stopSource === 'watch')) return
  const version = timer?.seq || Date.now()
  update(s => { if (s.active) s.active.restVersion = version })
  send(watchSidOf(active), timer && !timer.ready ? timer.paused ? timer.left : Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000)) : 0, timer)
}
