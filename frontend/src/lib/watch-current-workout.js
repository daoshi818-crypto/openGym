import { watchSidOf } from './session-resume.js'
import { watchSnapshotOf } from './watch-workout.js'
import { continueOnV4Watch, onWatchConnection, openWatchApp, watchConnection } from './watch-link.js'

const idle = { phase: 'idle' }
const subscribers = new Set()
let handoff, status = idle
const publish = value => { status = value; for (const cb of subscribers) cb() }
export const currentWorkoutWatchStatus = () => status
export const onCurrentWorkoutWatchStatus = cb => { subscribers.add(cb); return () => subscribers.delete(cb) }
export const retryCurrentWorkoutOnWatch = () => handoff?.retry()

const currentPhoneSid = state => {
  const active = state?.active, sid = watchSidOf(active)
  return active?.watchStarted || active?.editingWorkoutId || state?.watchClosed?.[sid] ? '' : sid
}

// A launch is an untargeted SDK wake; a v4 start is separate and only follows proof of
// the pinned installation and its fresh idle snapshot. No background or durable queue owns a start.
export function createCurrentWorkoutWatchHandoff({ getState, getConnection, getSnapshot, launch, start, publish }) {
  let foreground = false, disposed = false, sid = '', phase = 'idle', attempt = null
  let attempted = false, startAttempted = false, sawDisconnect = false, resumePreStart = false
  const report = (next, reason) => {
    if (phase !== next || reason) { phase = next; publish({ phase, reason }) }
  }
  const stop = next => {
    const prior = attempt
    attempt = null
    if (prior) { clearTimeout(prior.timer); prior.abort.abort() }
    if (next) report(next)
  }
  const route = connection => connection.sdkConnected && connection.selectedId && !connection.differentDevice
  const current = token => {
    const link = getConnection()
    return !disposed && foreground && attempt === token && sid === currentPhoneSid(getState()) &&
      route(link) && link.selectedId === token.device
  }
  const fail = (token, reason) => {
    if (attempt !== token) return
    stop()
    report('failed', reason)
  }
  const settle = (token, next) => {
    if (attempt !== token) return
    stop()
    report(next)
  }
  function refresh() {
    if (disposed) return
    const nextSid = currentPhoneSid(getState())
    if (sid !== nextSid) {
      stop()
      sid = nextSid; attempted = false; startAttempted = false; sawDisconnect = false; resumePreStart = false
      report(sid ? 'waiting' : 'idle')
    }
    if (!sid) return
    const link = getConnection()
    if (link.sdkOffline && attempted && !startAttempted && ['failed', 'handshake', 'launching', 'starting'].includes(phase)) sawDisconnect = true
    if (attempt && (!route(link) || link.selectedId !== attempt.device)) { fail(attempt, 'disconnected'); return }
    if (!foreground) return
    if (sawDisconnect && route(link)) { sawDisconnect = false; attempted = false }
    // Only the verified selected installation can reconcile an uncertain delivery.
    if (route(link) && link.appConnected && link.selectedId === link.peerId) {
      if (link.workoutSid === sid) { stop('synced'); return }
      if (link.terminalSid === sid) { stop('closed'); return }
      if (link.workoutSid && (attempt || !attempted)) { attempted = true; stop('conflict'); return }
    }
    if (phase === 'synced' || phase === 'closed' || !route(link)) return
    if (!attempt) {
      if (attempted) return
      attempted = true
      const token = attempt = { device: link.selectedId, abort: new AbortController(), launched: false, starting: false }
      report('launching')
      token.timer = setTimeout(() => fail(token, 'unconfirmed'), 20000)
      token.timer.unref?.()
      Promise.resolve().then(() => current(token) && launch(() => current(token), token.abort.signal)).then(result => {
        if (!current(token)) return
        if (!result?.ok) { fail(token, 'launch'); return }
        token.launched = true
        report('handshake')
        refresh()
      }).catch(() => fail(token, 'launch'))
      return
    }
    const token = attempt
    if (!token.launched || token.starting || !link.canStartWorkout || link.selectedId !== link.peerId) return
    const snapshot = getSnapshot()
    if (!snapshot || snapshot.sid !== sid) { fail(token, 'workout_changed'); return }
    token.starting = true
    clearTimeout(token.timer)
    report('starting')
    Promise.resolve().then(() => {
      if (!current(token)) return false
      startAttempted = true
      return start(snapshot, token.abort.signal)
    }).then(ok => {
      if (ok) settle(token, 'synced')
      else fail(token, 'unconfirmed')
    }).catch(() => fail(token, 'unconfirmed'))
  }
  return {
    refresh,
    setForeground(next) {
      if (foreground === next) return
      foreground = next
      if (!next && attempt) {
        resumePreStart = !startAttempted
        fail(attempt, 'background')
      } else if (next && resumePreStart) {
        attempted = false
        resumePreStart = false
      }
      refresh()
    },
    retry() {
      if (!foreground || !sid || !['failed', 'conflict'].includes(phase)) return
      attempted = false; sawDisconnect = false
      report('waiting')
      refresh()
    },
    dispose() { disposed = true; stop('idle') },
  }
}

export function bindCurrentWorkoutWatchHandoff({ getState, getTimer, subscribe, subscribeForeground }) {
  const receiver = handoff = createCurrentWorkoutWatchHandoff({ getState, getConnection: watchConnection,
    getSnapshot: () => watchSnapshotOf(getState(), getTimer()),
    launch: (stillCurrent, signal) => openWatchApp({ stillCurrent, signal }),
    start: (snapshot, signal) => continueOnV4Watch(snapshot, undefined, signal), publish })
  const offConnection = onWatchConnection(receiver.refresh)
  const offStore = subscribe(receiver.refresh)
  const offForeground = subscribeForeground(receiver.setForeground)
  return () => { offForeground?.(); offStore(); offConnection(); receiver.dispose(); if (handoff === receiver) handoff = null }
}
