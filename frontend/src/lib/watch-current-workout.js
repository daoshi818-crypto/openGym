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

// Phone-led starts require an explicit request. A watch app opened during an active phone
// session is also a request, after the pinned installation and fresh idle snapshot are verified.
export function createCurrentWorkoutWatchHandoff({ getState, getConnection, getSnapshot, launch, start, publish }) {
  let foreground = false, disposed = false, sid = '', phase = 'idle', attempt = null
  let launchRequested = false, attempted = false, startAttempted = false, sawDisconnect = false, resumePreStart = false
  let lastAppConnected = false, watchOpenedForSession = false
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
    const link = getConnection()
    const appConnected = route(link) && link.appConnected && link.selectedId === link.peerId
    const nextSid = currentPhoneSid(getState())
    if (sid !== nextSid) {
      stop()
      sid = nextSid; launchRequested = false; attempted = false; startAttempted = false; sawDisconnect = false; resumePreStart = false
      watchOpenedForSession = false
      report(sid ? 'waiting' : 'idle')
    }
    if (sid && appConnected && !lastAppConnected) watchOpenedForSession = true
    lastAppConnected = appConnected
    if (!sid) return
    if (link.sdkOffline && launchRequested && attempted && !startAttempted && ['failed', 'handshake', 'launching', 'starting'].includes(phase)) sawDisconnect = true
    if (attempt && (!route(link) || link.selectedId !== attempt.device)) { fail(attempt, 'disconnected'); return }
    if (!foreground) return
    if (sawDisconnect && route(link)) { sawDisconnect = false; attempted = false; launchRequested = true }
    // Only the verified selected installation can reconcile an uncertain delivery.
    if (route(link) && link.appConnected && link.selectedId === link.peerId) {
      if (link.workoutSid === sid) { stop('synced'); return }
      if (link.terminalSid === sid) { stop('closed'); return }
      if (link.workoutSid) { launchRequested = false; attempted = true; stop('conflict'); return }
      // Opening OpenGym on the watch is itself a request to continue the active phone
      // session. The phone only wakes the app after an explicit training-page action.
      if (link.canStartWorkout && !startAttempted && (launchRequested || watchOpenedForSession)) {
        const token = attempt || { device: link.selectedId, abort: new AbortController(), launched: true, starting: false }
        attempt = token; token.launched = true
        if (token.starting) return
        const snapshot = getSnapshot()
        if (!snapshot || snapshot.sid !== sid) { fail(token, 'workout_changed'); return }
        token.starting = true; startAttempted = true
        report('starting')
        Promise.resolve().then(() => current(token) && start(snapshot, token.abort.signal)).then(ok => {
          if (ok) { launchRequested = false; settle(token, 'synced') }
          else fail(token, 'unconfirmed')
        }).catch(() => fail(token, 'unconfirmed'))
        return
      }
      if (!attempt && !startAttempted) report('handshake')
      return
    }
    if (phase === 'synced' || phase === 'closed') return
    if (!launchRequested) { report(route(link) ? 'ready' : 'waiting'); return }
    if (!route(link)) return
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
  }
  return {
    refresh,
    setForeground(next) {
      if (foreground === next) return
      foreground = next
      if (!next && attempt) {
        resumePreStart = launchRequested && !startAttempted
        fail(attempt, 'background')
      } else if (next && resumePreStart) {
        attempted = false; launchRequested = true
        resumePreStart = false
      }
      refresh()
    },
    retry() {
      if (!foreground || !sid || (startAttempted && phase !== 'failed') || !['ready', 'handshake', 'failed', 'conflict'].includes(phase)) return
      launchRequested = true; attempted = false; startAttempted = false; sawDisconnect = false
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
