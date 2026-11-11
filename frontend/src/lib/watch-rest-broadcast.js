import { watchSidOf } from './session-resume.js'

// An absent timer is not a phone action. Only a real, session-scoped stop
// may supersede a watch edit; mount/reconnect/cleanup must not invent revisions.
export function broadcastPhoneRest({ enabled, active, timer, stopIntent, update, send }) {
  if (!enabled || !active?.start || timer?.source === 'watch') return
  const sid = watchSidOf(active)
  if (timer?.sid && timer.sid !== sid) return
  if (!timer && (!stopIntent || stopIntent.source !== 'phone' || stopIntent.sid !== sid || stopIntent.seq <= (active.restVersion || 0))) return
  const version = timer?.seq || stopIntent?.seq
  if (!version) return
  update(s => { if (watchSidOf(s.active) === sid) s.active.restVersion = version })
  send(sid, timer && !timer.ready ? timer.paused ? timer.left : Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000)) : 0, timer)
}
