// 传感器：心率订阅 + 震动。训练中订阅心率用于热量估算，震动用于"休息结束"提醒。
import health from '@blueos.health.health'
import vibrator from '@blueos.hardware.vibrator.vibrator'

export function startHr(onSample) {
  health.subscribeSample({
    dataType: health.DATA_TYPES.HEART_RATE,
    callback: (sample) => {
      // sample: { timeStamp, value }
      if (sample && sample.value) onSample(sample.value)
    },
    fail: (msg, code) => console.log('hr subscribe failed', msg, code),
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
