import { wireBytes, wireHash } from './sync-wire.js'

// The phone starts from entries. Watch presentation/history/rows are duplicated
// catalog data, not part of that operation. Keep every phone entry field intact.
export function compactStartEvent(event) {
  if (event.t !== 'watch_start' || !event.plan) return event
  const { id, name, weightUnit, entries } = event.plan
  return { ...event, plan: { id, name, weightUnit, entries } }
}

// This is our conservative envelope budget, not a claimed SDK firmware limit.
export const EVENT_FRAME_BYTES = 3000
export function createEventWire(event) {
  const message = compactStartEvent(event), text = JSON.stringify(message)
  if (wireBytes(text) > 131072) throw new Error('event_too_large')
  return { eventId: event.eventId, sid: event.sid, text, hash: wireHash(text), offset: 0 }
}
export function nextEventFrame(wire) {
  let end = Math.min(wire.text.length, wire.offset + 1000)
  const packet = () => ({ t: 'watch_event_chunk', eventId: wire.eventId, sid: wire.sid,
    hash: wire.hash, offset: wire.offset, total: wire.text.length, data: wire.text.slice(wire.offset, end) })
  while (end > wire.offset) {
    if (end < wire.text.length && /[\uD800-\uDBFF]/.test(wire.text[end - 1])) end--
    const frame = packet()
    if (wireBytes(JSON.stringify(frame)) <= EVENT_FRAME_BYTES) return { data: frame, end }
    end -= Math.max(1, Math.floor((end - wire.offset) / 4))
  }
  throw new Error('event_envelope_too_large')
}
