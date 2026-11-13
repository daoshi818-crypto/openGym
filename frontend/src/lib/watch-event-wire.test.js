import { expect, it } from 'vitest'
import { compactStartEvent, createEventWire, nextEventFrame, EVENT_FRAME_BYTES } from '../../../watch-app/src/lib/event-wire.js'
import { wireBytes, wireHash } from '../../../watch-app/src/lib/sync-wire.js'

it('removes duplicate watch catalog data without changing phone entries or identities', () => {
  const entries = [{ entryInstanceId: 'one', sets: [{ setId: 'a', w: 8, r: 12 }], plan: { policy: 'linear' }, target: { restSec: 60 } }]
  const event = { t: 'watch_start', sid: 's', eventId: 'e', dependsOn: [], plan: { id: 'p', name: '训练', weightUnit: 'kg', entries,
    exercises: [{ lastTime: 'irrelevant' }], rows: [1], preview: 'a', profile: { weight: 70 } } }
  expect(compactStartEvent(event)).toEqual({ ...event, plan: { id: 'p', name: '训练', weightUnit: 'kg', entries } })
  expect(event.plan.exercises).toHaveLength(1)
  expect(compactStartEvent({ t: 'set' })).toEqual({ t: 'set' })
})

it.each(['中文🏋️'.repeat(3000), '\\"\n'.repeat(10000)])('bounds the actual JSON envelope and round-trips non-ASCII and escapes', value => {
  const event = { t: 'session_close', sid: 's', eventId: 'e', name: value }
  const wire = createEventWire(event), frames = []
  while (wire.offset < wire.text.length) {
    const next = nextEventFrame(wire)
    expect(wireBytes(JSON.stringify(next.data))).toBeLessThanOrEqual(EVENT_FRAME_BYTES)
    expect(next.end).toBeGreaterThan(wire.offset)
    frames.push(next.data); wire.offset = next.end
  }
  const text = frames.map(f => f.data).join('')
  expect(JSON.parse(text)).toEqual(event)
  expect(wireHash(text)).toBe(wire.hash)
  expect(frames.every(f => f.eventId === event.eventId && f.sid === event.sid)).toBe(true)
})

it('rejects oversized transfer without truncating accepted training data', () => {
  expect(() => createEventWire({ t: 'watch_start', plan: { entries: ['x'.repeat(131072)] } })).toThrow('event_too_large')
})
