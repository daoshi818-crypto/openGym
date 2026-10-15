// 手表连接（BLE）：设置页的「连接手表」与训练页的自动推计划都走这里。
//
// 手机 = BLE 中心设备（原生 WatchBlePlugin），手表 = GATT 服务端（watch-app/）。
// 协议见 watch-app/DESIGN.md 第 4 节：plan（手机→手表）、set/end（手表→手机）、ack。
//
// 不另开存储：收到手表的"完成一组"直接写进 useStore 的会话状态，和手动点完成同一条
// 代码路径，同步、撤销、编辑历史全都白送（DESIGN.md 第 6 节）。
import { t } from './i18n-core.js'
import { MOBILE, isAndroid } from './mobile.js'

let pluginP = null
const watchPlugin = () => pluginP || (pluginP = (async () => {
  if (!(await isAndroid())) return null
  try {
    const { registerPlugin } = await import('@capacitor/core')
    return { WatchBle: registerPlugin('WatchBle') }
  } catch { return null }
})().catch(() => null))

// ---- 状态广播：设置页与训练页都订阅这一个 ----
let state = 'off' // off | connecting | connected | ready | error
const listeners = new Set()

export function watchState() { return state }
export function onWatchState(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function setState(s) {
  state = s
  for (const cb of listeners) {
    try { cb(s) } catch { /* 单个订阅者出错不影响别人 */ }
  }
}

// 原生侧的连接状态事件（连接/断开/就绪/出错）
let bound = false
async function bindNative() {
  if (bound || !MOBILE) return
  const p = await watchPlugin()
  if (!p) return
  bound = true
  p.WatchBle.addListener('watchState', (ev) => {
    setState(ev && ev.state ? ev.state : 'off')
  })
  // 手表推来的事件：完成一组 / 结束训练 / 休息与重量调整
  p.WatchBle.addListener('watchEvent', (ev) => {
    try {
      if (ev && (ev.t === 'rest' || ev.t === 'weight')) onWatchSync(ev)
      else onWatchEvent(ev)
    } catch (e) { console.log('watch event failed', e) }
  })
}

// ---- 设置页 API ----

/** 手表功能在这台设备上是否可用（Android app 且蓝牙/权限就绪）。 */
export async function watchAvailable() {
  if (!MOBILE) return { available: false, reason: 'web' }
  const p = await watchPlugin()
  if (!p) return { available: false, reason: 'web' }
  try {
    const r = await p.WatchBle.isSupported()
    if (!r.bluetoothOn) return { available: false, reason: 'bluetoothOff' }
    if (!r.permission) return { available: false, reason: 'permission' }
    return { available: true }
  } catch { return { available: false, reason: 'web' } }
}

/** 申请蓝牙权限（Android 12+ 的运行时对话框）。 */
export async function requestWatchPermissions() {
  const p = await watchPlugin()
  if (!p) return false
  try { return !!(await p.WatchBle.requestPermissions()).granted } catch { return false }
}

/**
 * 连接手表：申请权限 → 按服务 UUID 扫描 → 连接。
 * 手表应用要在前台开着（开始页广播自己）。
 */
export async function connectWatch() {
  await bindNative()
  const p = await watchPlugin()
  if (!p) return false
  const ok = await requestWatchPermissions()
  if (!ok) { setState('error'); return false }
  setState('connecting')
  try {
    await p.WatchBle.connect({})
    // ready 由原生 watchState 事件带回来；这里不再轮询
    return true
  } catch (e) {
    setState('error')
    return false
  }
}

export async function disconnectWatch() {
  const p = await watchPlugin()
  if (!p) return
  try { await p.WatchBle.disconnect() } catch { /* 已经断开 */ }
  setState('off')
}

// ---- 训练页 API：把今天的训练推给手表 ----

/** 训练开始时调用一次；训练中途计划变了（加/删动作）再调一次，手表整包热替换。 */
export async function pushPlanToWatch(workout, sid) {
  if (!MOBILE || !workout) return
  await bindNative()
  const p = await watchPlugin()
  if (!p) return
  try {
    const r = await p.WatchBle.isConnected()
    if (!r || !r.connected) return
    const msg = {
      t: 'plan',
      v: 1,
      sid: sid || '',
      workout: workout.name || '',
      exercises: (workout.exercises || []).map(e => ({
        name: e.name || '',
        sets: e.sets || 1,
        reps: e.reps != null ? String(e.reps) : '',
        restSec: e.restSec || 60,
        weight: e.weight != null ? String(e.weight) : '',
      })),
    }
    await p.WatchBle.sendPlan({ json: JSON.stringify(msg) })
  } catch { /* 推送失败不打扰训练 */ }
}

// ---- 实时同步（双向，都走"完成"特征值，尽力而为、不排队） ----

let restSeq = 0
const lastSentRest = { leftSec: -1, at: 0 }

/** 手机调整了休息（±15s、暂停续跑、跳过）：立即推给手表。delta==null 表示"按剩余秒对齐"。 */
export async function pushRestToWatch(sid, leftSec) {
  if (!MOBILE || !sid) return
  const p = await watchPlugin()
  if (!p) return
  try {
    const now = Date.now()
    // 同一秒内相同剩余秒数不重发（暂停/续跑会连着来两次）
    if (leftSec === lastSentRest.leftSec && now - lastSentRest.at < 1000) return
    lastSentRest.leftSec = leftSec
    lastSentRest.at = now
    restSeq += 1
    await p.WatchBle.sendEvent({ json: JSON.stringify({ t: 'rest', sid, leftSec, totalSec: leftSec, seq: restSeq }) })
  } catch { /* 手表不在线就算了 */ }
}

/** 手机改了某组的重量：立即推给手表（ex=动作下标，set=第几组，1 起）。 */
export async function pushWeightToWatch(sid, ex, set, weight) {
  if (!MOBILE || !sid) return
  const p = await watchPlugin()
  if (!p) return
  try {
    await p.WatchBle.sendEvent({ json: JSON.stringify({ t: 'weight', sid, ex, set, weight: String(weight ?? '') }) })
  } catch { /* 手表不在线就算了 */ }
}

/** 手机上取消勾选了某组：手表端把那组的完成态抹掉（撤销重做对齐）。 */
export async function pushUnsetToWatch(sid, ex, set) {
  if (!MOBILE || !sid) return
  const p = await watchPlugin()
  if (!p) return
  try {
    await p.WatchBle.sendEvent({ json: JSON.stringify({ t: 'unset', sid, ex, set }) })
  } catch { /* 手表不在线就算了 */ }
}

// 收到手表的同步消息（rest/weight）后转给注册方（Workout 页落库）
let onWatchSync = () => {}

/** 训练页注册：收到手表 rest/weight 调整时怎么应用到会话。 */
export function bindWatchSync(cb) { onWatchSync = cb || (() => {}) }

// ---- 手表事件 → openGym 会话状态 ----

let onWatchEvent = () => {}
/** 训练页注册：收到手表"完成一组/结束训练"时怎么写进会话（useStore 的 action）。 */
export function bindWatchEvents(cb) { onWatchEvent = cb || (() => {}) }
