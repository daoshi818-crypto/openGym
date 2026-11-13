// 传感器：心率订阅 + 震动。训练中订阅心率用于热量估算，震动用于"休息结束"提醒。
import health from '@blueos.health.health'
import vibrator from '@blueos.hardware.vibrator.vibrator'
import { runtime } from './runtime.js'
import { loadState, addHr, flushHr } from './session.js'
import { appTimeout, cancelAppTimeout } from './app-timers.js'

function captureActive(state, capture) {
  return state.active && !state.pausedAt && !state.closeIntent && state.sid === capture.sid &&
    (state.segmentStartedAt || state.startedAt) === capture.segmentStartedAt
}
function persistCaptureHr(capture, state) {
  cancelAppTimeout(capture.timer)
  capture.timer = null
  capture.persistedAt = Date.now(); capture.persistedBpm = state.hr.last
  return flushHr(state).then(result => { if (!result.ok) capture.persistedAt = null })
}

// The subscription belongs to the training session, across page bundles and navigation.
export function startSessionHr() {
  const shared = runtime()
  if (shared.closingSid) return
  const state = loadState()
  if (!state.active || state.pausedAt || state.closeIntent) { stopSessionHr(); return }
  const segmentStartedAt = state.segmentStartedAt || state.startedAt
  if (shared.hrCapture?.sid === state.sid && shared.hrCapture.segmentStartedAt === segmentStartedAt) return
  stopSessionHr()
  const capture = { sid: state.sid, segmentStartedAt, stop: stopSessionHr, persistedAt: null, persistedBpm: null, timer: null }
  shared.hrCapture = capture
  startHr(bpm => {
    if (shared.hrCapture !== capture) return
    // A failed close must leave the subscription usable; a successful freeze stops it.
    if (shared.closingSid === capture.sid) return
    const latest = loadState()
    if (!captureActive(latest, capture)) { stopSessionHr(); return }
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 220) return
    addHr(latest, bpm)
    const at = Date.now()
    if (capture.persistedAt == null || at - capture.persistedAt >= 10000 || Math.abs(bpm - capture.persistedBpm) >= 10) {
      persistCaptureHr(capture, latest)
    } else if (capture.timer == null) {
      // App-owned deadline also flushes the tail if the sensor stops reporting.
      capture.timer = appTimeout(() => {
        capture.timer = null
        if (shared.hrCapture !== capture) return
        const current = loadState()
        if (!captureActive(current, capture)) { stopSessionHr(); return }
        persistCaptureHr(capture, current)
      }, 10000 - (at - capture.persistedAt))
    }
  }, () => { if (shared.hrCapture === capture) stopSessionHr() })
}

export function stopSessionHr() {
  const shared = runtime()
  const capture = shared.hrCapture
  if (!capture) return
  // Detach first: flushing must never re-enter stop through session persistence.
  shared.hrCapture = null
  cancelAppTimeout(capture.timer)
  stopHr()
  return flushHr(capture)
}

export function startHr(onSample, onError = () => {}) {
  health.subscribeSample({
    dataType: health.DATA_TYPES.HEART_RATE,
    callback: (sample) => {
      // sample: { timeStamp, value }
      if (sample && sample.value) onSample(sample.value)
    },
    fail: (msg, code) => { onError(code); console.log('hr subscribe failed', code) },
  })
}

export function stopHr() {
  try {
    health.unsubscribeSample({ dataType: health.DATA_TYPES.HEART_RATE })
  } catch (e) { /* 未订阅时忽略 */ }
}

// 记一组的轻反馈
export function tick() {
  vibrator.vibrate({ mode: 'short' })
}

// 休息结束：连震三下（durations/interval/count 都是毫秒）
export function restOver() {
  vibrator.start({
    priority: 1,
    duration: 400,
    interval: 200,
    count: 3,
    fail: (msg, code) => console.log('vibrate failed', msg, code),
  })
}
