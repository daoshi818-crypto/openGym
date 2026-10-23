// 传感器：心率订阅 + 震动。训练中订阅心率用于热量估算，震动用于"休息结束"提醒。
import health from '@blueos.health.health'
import vibrator from '@blueos.hardware.vibrator.vibrator'
import { runtime } from './runtime.js'
import { loadState, addHr, save } from './session.js'

// The subscription belongs to the training session, across page bundles and navigation.
export function startSessionHr() {
  const shared = runtime()
  const state = loadState()
  if (!state.active || state.pausedAt) { stopSessionHr(); return }
  if (shared.hrCapture?.sid === state.sid) return
  stopSessionHr()
  const capture = { sid: state.sid, stop: stopSessionHr }
  shared.hrCapture = capture
  startHr(bpm => {
    if (shared.hrCapture !== capture) return
    const latest = loadState()
    if (!latest.active || latest.pausedAt || latest.sid !== capture.sid) { stopSessionHr(); return }
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 220) return
    addHr(latest, bpm)
    save(latest)
  }, () => { if (shared.hrCapture === capture) stopSessionHr() })
}

export function stopSessionHr() {
  const shared = runtime()
  if (!shared.hrCapture) return
  shared.hrCapture = null
  stopHr()
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
