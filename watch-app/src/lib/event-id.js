import storage from '@blueos.storage.storage'
import { runtime } from './runtime.js'
// One clock for every id the watch hands out. The outbox and the close journal must not
// allocate the same seq for two different messages (the phone compares seq/eventId), and a
// value written to storage keeps ordering across a restart.
const CLOCK_KEY = 'event_clock'
const clock = () => runtime().eventClock ||= { last: 0 }

export function allocateEventIdentity(sid, prefix = 'watch') {
  const c = clock()
  if (!c.installationId) {
    let identity
    try { identity = storage.getSync({ key: 'sync_identity' }) } catch { /* first launch */ }
    c.installationId = identity?.installationId || 'watch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
    c.deviceSeq = Number(identity?.deviceSeq) || 0
  }
  c.deviceSeq++
  c.bootNonce ||= Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  try { storage.set({ key: 'sync_identity', value: { installationId: c.installationId, deviceSeq: c.deviceSeq }, fail() {} }) } catch { /* event envelope also retains this identity */ }
  let stored = 0
  try { stored = Number(storage.getSync({ key: CLOCK_KEY })) || 0 } catch { stored = 0 }
  c.last = Math.max(Date.now(), c.last + 1, stored + 1)
  try { storage.set({ key: CLOCK_KEY, value: c.last, fail() {} }) } catch { /* 内存序仍保证本次唯一 */ }
  return { at: c.last, seq: c.last, eventId: prefix + ':' + sid + ':' + c.last + ':' + c.installationId + ':' + c.deviceSeq + ':' + c.bootNonce,
    installationId: c.installationId, deviceSeq: c.deviceSeq }
}

export function lastEventAt() { return clock().last }
export function rememberEventAt(at) { const c = clock(); if (at > c.last) c.last = at }
