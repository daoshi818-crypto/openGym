const LEASE_MS = 15000
const MAX_ID = 128
const MAX_CLOCK_SKEW_MS = 5000

export function sessionGenerationOf(value) {
  const generation = value?.sessionGeneration ?? value?.generation ?? value?.sid
  return (typeof generation === 'string' && generation.length > 0 && generation.length <= MAX_ID) ||
    (Number.isSafeInteger(generation) && generation >= 0) ? generation : ''
}

export function validPhonePresence(message) {
  if (!message || message.t !== 'session_presence' || typeof message.sid !== 'string' || !message.sid || message.sid.length > MAX_ID) return false
  if (message.active !== true && message.active !== false) return false
  if (!Number.isSafeInteger(message.sessionGeneration) || message.sessionGeneration < 1) return false
  if (!Number.isSafeInteger(message.sentAt) || message.sentAt < 1) return false
  const generation = sessionGenerationOf(message)
  if (!generation) return false
  if (message.commitRev != null && (!Number.isSafeInteger(message.commitRev) || message.commitRev < 0)) return false
  return true
}

export function confirmPhoneSession(runtime, sid, generation = sid, at = Date.now()) {
  if (!runtime || typeof sid !== 'string' || !sid || sid.length > MAX_ID || !((typeof generation === 'string' && generation.length > 0 && generation.length <= MAX_ID) || (Number.isSafeInteger(generation) && generation >= 0))) return false
  runtime.phoneSessionPresence = { sid, generation, active: true, lastSeenAt: at }
  return true
}

export function applyPhonePresence(runtime, message, expectedSid, at = Date.now()) {
  if (!validPhonePresence(message) || message.sid !== expectedSid) return false
  const generation = sessionGenerationOf(message)
  const current = runtime?.phoneSessionPresence
  const age = at - message.sentAt
  if (age > LEASE_MS + MAX_CLOCK_SKEW_MS || age < -MAX_CLOCK_SKEW_MS) return false
  const seenAt = Math.min(at, message.sentAt)
  if (message.active) {
    if (current?.sid === message.sid && Number.isSafeInteger(current.generation) && generation < current.generation) return false
    if (current?.sid === message.sid && current.generation === generation && current.lastSeenAt > seenAt) return false
    return confirmPhoneSession(runtime, message.sid, generation, seenAt)
  }
  if (current?.sid === message.sid && (current.generation === generation ||
      Number.isSafeInteger(current.generation) && Number.isSafeInteger(generation) && generation >= current.generation)) runtime.phoneSessionPresence = null
  return true
}

export function isPhoneSessionLive(session, presence, at = Date.now()) {
  return !!session?.sid && session.sid === presence?.sid && sessionGenerationOf(presence) !== '' &&
    presence.active === true && Number.isFinite(presence.lastSeenAt) && at >= presence.lastSeenAt && at - presence.lastSeenAt < LEASE_MS
}

export function phonePresenceLeaseMs() { return LEASE_MS }
