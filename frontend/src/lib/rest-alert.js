// Rest-over alert for the Capacitor app.
//
// The in-page countdown is a setInterval in the WebView. Android freezes that as soon as the
// screen locks, so the beep never runs and nothing is posted. Scheduling a real alarm at
// startRest() is what still fires with the screen off: the receiver posts the notification
// and plays the end tone. The card in the notification shade is the in-app shape: clock plus
// a shrinking bar. The lock screen shows it only when notifications are allowed and the
// system is set to show them there.
//
// The web build keeps Web Push (useUI). This file no-ops there; MOBILE is a build-time flag.
import { t } from './i18n-core.js'
import { argb } from './format.js'
import { accentPair } from './accent.js'
import { MOBILE, isAndroid } from './mobile.js'
import { REST_SOUNDS } from './rest-sounds.js'

export const REST_ALERT_ID = 42
export const REST_CHANNEL_ID = 'rest-over'
// Settings → Vibrate off. A notification channel's vibration is the system's to keep once the
// channel exists, so the app cannot switch it off on 'rest-over': an end that must not buzz is
// posted on a second channel that never vibrates (RestAlert.java).
export const REST_QUIET_CHANNEL_ID = 'rest-over-quiet'

// One object the native side schedules. Public + high is what the notification shade can show.
// The lock screen follows the user's notification settings.
// `key` is a preset's key or the user's own colour as '#rrggbb' (lib/accent.js accentValue).
export function accentColors(key) {
  const { accent, ink } = accentPair(key)
  return { accent: argb(accent), ink: argb(ink) }
}

export function buildRestAlert({ at, title, countdownTitle, totalSec, accent, sound = true, classic = false, tone = null, vibrate = true, alarmBuzz = false, restId = '', context = '', now = Date.now() } = {}) {
  if (typeof at !== 'number' || !(at > now)) return null
  // Settings → Sound (#306): one of lib/sound.js REST_SOUNDS; without one, `classic` decides, as before.
  const kind = Object.hasOwn(REST_SOUNDS, tone) ? tone : classic === true ? 'classic' : 'chime'
  const totalMs = Math.max(1000, Math.round((totalSec > 0 ? totalSec : (at - now) / 1000) * 1000))
  const colors = accentColors(accent)
  return {
    id: REST_ALERT_ID,
    channelId: vibrate ? REST_CHANNEL_ID : REST_QUIET_CHANNEL_ID,
    title: title || t('Rest’s over. Next set!'),
    countdownTitle: countdownTitle || t('Rest'),
    pause: t('Pause'),
    resume: t('Resume'),
    minus: '− 15s',
    plus: '+ 15s',
    skip: t('Skip'),
    accent: colors.accent,
    ink: colors.ink,
    totalMs,
    at,
    // 休息身份 + 训练摘要（rest-context.js）：原生用它画紧凑卡片、展开控制；
    // 之后的内容更新走 setOverlayContext，不再带 `at`，因此不会重排闹钟。
    restId: String(restId || ''),
    context: typeof context === 'string' ? context : '',
    allowWhileIdle: true,
    sound: !!sound,
    // Settings → Sound: the native side plays the same end tone the page does (RestTone.java).
    // `tone` names it; `classic` stays for an app shell from before #306, which reads only that
    // and plays the chime for every other pick.
    tone: kind,
    classic: kind === 'classic',
    vibrate: !!vibrate,
    // Settings → "Vibrate when the phone is on silent" (#375): the end buzzes as an alarm, which
    // silent mode lets through, instead of through the notification channel, which it mutes.
    alarmBuzz: !!vibrate && !!alarmBuzz,
    localOnly: false,
    visibility: 'public',
    importance: 'high',
  }
}

// Serialises schedule/cancel. startRest() disarms the previous alarm and arms the next in
// the same turn; if those two bridge calls raced, a cancel finishing last would swallow the
// new alarm. `token` stops a slow schedule from adopting the beep after a later disarm.
let chain = Promise.resolve()
let token = 0

const enqueue = fn => {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {})
  return run
}

// The native plugin, registered once: registerPlugin() warns on every call after the first. It
// travels inside an object because a Capacitor plugin proxy answers `then` with a native call that
// never settles, so a promise resolved with the bare proxy hangs for good (the Coach hang, #42).
// Anything but the Android app gets null and registers nothing: iOS has no RestAlert, and every
// call to it there, addListener included, rejects.
let pluginP = null
const restPlugin = () => pluginP || (pluginP = (async () => {
  if (!(await isAndroid())) return null
  const { registerPlugin } = await import('@capacitor/core')
  return { RestAlert: registerPlugin('RestAlert') }
})().catch(() => null))

// 悬浮窗倒计时（原生 RestOverlay）：休息时贴在屏幕上，不依赖通知栏。
// 权限是 Android 的"显示在其他应用上层"（SYSTEM_ALERT_WINDOW），只能在设置页里由用户授予。
// 非 Android 平台一律返回 null/false，设置页据此不显示这一项。

/** 权限是否已授予；null = 这台设备不支持（网页/iOS）。 */
export async function overlayStatus() {
  const p = await restPlugin()
  if (!p) return null
  try {
    const r = await p.RestAlert.canDrawOverlay()
    return !!r.granted
  } catch { return null }
}

/** 跳系统设置页请求授权，返回授权后的状态。 */
export async function requestOverlay() {
  const p = await restPlugin()
  if (!p) return false
  try {
    const r = await p.RestAlert.requestOverlayPermission()
    return !!r.granted
  } catch { return false }
}

/** 关掉开关时立即移除正在显示的悬浮窗。 */
export async function hideOverlay() {
  const p = await restPlugin()
  if (!p) return
  try { await p.RestAlert.hideOverlay() } catch { /* 没显示过就无所谓 */ }
}

// 悬浮窗样式：'card'（卡片+进度条）或 'ring'（圆形进度环）。存 profile，切换即生效。
export function overlayStyleOf(S) {
  return S && S.overlayStyle === 'ring' ? 'ring' : 'card'
}

/** 设置页切换样式时下发；正在显示的悬浮窗按新样式重建。 */
export async function setOverlayStyle(style) {
  const p = await restPlugin()
  if (!p) return
  try { await p.RestAlert.setOverlayStyle({ style: overlayStyleOf({ overlayStyle: style }) }) } catch { /* 非 Android */ }
}

// Resolves true only when an Android alarm was scheduled. Callers use false as
// "fall back to the server push" — web, iOS, and a failed schedule.
export function armRestAlert(at, opts = {}) {
  if (!MOBILE) return Promise.resolve(false)
  const mine = ++token
  const alert = buildRestAlert({ at, title: opts.title, countdownTitle: opts.countdownTitle, totalSec: opts.totalSec, accent: opts.accent, sound: opts.sound, classic: opts.classic === true, tone: opts.tone, vibrate: opts.vibrate !== false, alarmBuzz: !!opts.alarmBuzz, restId: opts.restId, context: opts.context })
  if (!alert) return Promise.resolve(false)
  // Outside the chain and never awaited: the alarm, its tone and the alarm buzz do not need the
  // notification permission, and a dialog left open while the phone is put away must not hold
  // the alarm back until the rest is long over.
  askNotifPermissionOnce()
  return enqueue(async () => {
    let kind = 'failed'
    try { kind = await deliver(alert) } catch { kind = 'failed' }
    if (mine !== token) return false
    return kind === 'android'
  })
}

export function disarmRestAlert() {
  token++
  if (!MOBILE) return
  enqueue(async () => {
    try { await cancelDelivered() } catch { /* the next arm replaces this alarm */ }
  })
}

// The rest was paused in the app (#193): the notification stops its clock at the time held and
// offers Resume, and the alarm for the old end is called off. Resuming arms it again for the new
// end like any other rest; time added or taken while paused holds it again at the new figure.
export function holdRestAlert(leftSec, totalSec) {
  token++
  if (!MOBILE) return
  enqueue(async () => {
    const p = await restPlugin()
    if (p) await p.RestAlert.hold({ id: REST_ALERT_ID, leftMs: Math.max(1, leftSec) * 1000, totalMs: Math.max(1, totalSec) * 1000 })
  })
}

// What the notification's own buttons did (pause, ±15s, skip), for useUI to mirror in the bar.
let onNativeRest = null
export function bindNativeRest(cb) { onNativeRest = cb }

// Caught, and only on Android: in the iOS app this listener used to reject at startup with
// nobody to catch it.
if (MOBILE) {
  restPlugin()
    .then(p => p && p.RestAlert.addListener('rest', ev => { if (onNativeRest) onNativeRest(ev) }))
    .catch(() => {})
}

// A buzz that silent mode lets through (#375): the native side vibrates as an alarm. Resolves true
// once it did, false anywhere it cannot (the web, iOS, a failed call) for the caller to buzz the
// ordinary way instead. Never resolves with the plugin itself — see restPlugin.
export function buzzAsAlarm(pattern) {
  if (!MOBILE) return Promise.resolve(false)
  const p = Array.isArray(pattern) ? pattern.filter(n => Number.isFinite(n) && n >= 0).map(Math.round) : (Number.isFinite(pattern) && pattern > 0 ? [Math.round(pattern)] : [])
  if (!p.length) return Promise.resolve(false)
  return restPlugin()
    .then(plugin => (plugin ? plugin.RestAlert.buzz({ pattern: p }).then(() => true) : false))
    .catch(() => false)
}

// The end tone through the native side, which ducks music for it (a page cannot). Resolves true
// once it was handed over, false anywhere it cannot (the web, iOS, a failed call) for the caller
// to play the page's own chime instead. Never resolves with the plugin itself — see restPlugin.
export function toneNative(kind) {
  if (!MOBILE) return Promise.resolve(false)
  return restPlugin()
    .then(plugin => (plugin ? plugin.RestAlert.tone({ kind: String(kind || 'chime') }).then(() => true) : false))
    .catch(() => false)
}

// The running countdown repaints with this swatch. No-op when no rest is on screen.
export function setRestAccent(key) {
  if (!MOBILE) return
  const { accent, ink } = accentColors(key)
  enqueue(async () => {
    const p = await restPlugin()
    if (p) await p.RestAlert.setAccent({ accent, ink })
  })
}

// The notification permission is asked once, the first time a rest starts. The answer is kept:
// Android lets an app ask again after a "Don't allow", and asking on every rest would pop the
// dialog between every set. Settings → Notifications in the system is where it changes later.
export const NOTIF_ASKED_KEY = 'gym_rest_notif_asked'
let askP = null
const readAsked = () => { try { return localStorage.getItem(NOTIF_ASKED_KEY) } catch { return null } }
const writeAsked = v => { try { localStorage.setItem(NOTIF_ASKED_KEY, v) } catch { /* asked again next launch */ } }

export function askNotifPermissionOnce() {
  if (askP) return askP
  askP = (async () => {
    try {
      if (!(await isAndroid())) return false
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      const perm = await LocalNotifications.checkPermissions()
      if (perm.display === 'granted') return true
      if (perm.display === 'denied' || readAsked()) return false
      const got = await LocalNotifications.requestPermissions()
      // Kept only once really answered. Leaving the app closes the dialog and reports "denied",
      // but the permission still reads 'prompt' then: nobody chose, so the next launch asks again
      // (this one does not: askP holds the answer for the rest of the session).
      const after = got.display === 'granted' ? got : await LocalNotifications.checkPermissions().catch(() => got)
      if (after.display !== 'prompt') writeAsked(got.display === 'granted' ? 'granted' : 'denied')
      return got.display === 'granted'
    } catch {
      return false
    }
  })()
  return askP
}

// Test seam: a fresh launch.
export function _resetNotifAsk() { askP = null }

async function deliver(alert) {
  // The end passed while the call waited its turn (a slow bridge, a frozen WebView): nothing to
  // ring any more, and the plugin would refuse it ("at must be in the future").
  if (!(alert.at > Date.now())) return 'expired'
  const p = await restPlugin()
  if (!p) return 'skipped'
  const { RestAlert } = p
  if (!(alert.at > Date.now())) return 'expired'
  // Sound, the alarm buzz and the alarm itself need no notification permission; only the
  // countdown card does, and askNotifPermissionOnce() asks for it on the side.
  await RestAlert.schedule({
    id: alert.id,
    at: alert.at,
    title: alert.title,
    sound: alert.sound,
    classic: alert.classic,
    tone: alert.tone,
    // The end of a rest the app is not in front for: the notification, or the buzz standing in
    // for it where notifications are off. With the app in front the page buzzes (lib/sound.js).
    vibrate: alert.vibrate,
    alarmBuzz: alert.alarmBuzz,
    channelId: alert.channelId,
    visibility: alert.visibility,
    importance: alert.importance,
    localOnly: alert.localOnly,
    countdownTitle: alert.countdownTitle,
    totalMs: alert.totalMs,
    restId: alert.restId,
    context: alert.context,
    pause: alert.pause,
    resume: alert.resume,
    minus: alert.minus,
    plus: alert.plus,
    skip: alert.skip,
    accent: alert.accent,
    ink: alert.ink,
  })
  return 'android'
}

async function cancelDelivered() {
  const p = await restPlugin()
  if (p) await p.RestAlert.cancel({ id: REST_ALERT_ID })
}

/**
 * 训练摘要更新：只刷新悬浮窗内容，不重新安排闹钟、不改变截止时间、不重置休息。
 * restId 不匹配时原生忽略，避免旧休息的摘要盖到新一轮上。
 */
export function setRestContext(restId, context) {
  if (!MOBILE || !restId || !context) return Promise.resolve(false)
  return restPlugin()
    .then(p => (p ? p.RestAlert.setOverlayContext({ restId: String(restId), context: String(context) }).then(() => true) : false))
    .catch(() => false)
}

/**
 * 原生休息状态（服务在后台活着时最可信）：APP 回前台时用它裁决旧 WebView 计时，
 * 已跳过/已结束的休息不能被旧状态复活。
 */
export function getRestState() {
  if (!MOBILE) return Promise.resolve(null)
  return restPlugin()
    .then(p => (p ? p.RestAlert.getRestState().then(r => r || null) : null))
    .catch(() => null)
}
