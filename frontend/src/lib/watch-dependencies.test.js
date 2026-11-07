import { describe, it, expect } from 'vitest'
import { dependenciesFor, dependencyDecision, eventsOverlap, selectReadyEvent } from '../../../watch-app/src/lib/event-dependencies.js'
const ev = (id, row, field = 'weight') => ({ t: field, eventId: id, sid: 's', entryInstanceId: 'entry', setId: row, dependencyEvents: true, dependsOn: [] })
const item = (msg, nextAttemptAt = 0) => ({ msg, sent: false, nextAttemptAt })
describe('dependency scheduling contract', () => {
  it('E001 backoff permits independent E002/E003, but E004 waits for exact applied E001', () => {
    const a = ev('E001', '1'), b = ev('E002', '2'), c = ev('E003', '3'), d = { ...ev('E004', '1'), dependsOn: ['E001'] }
    const q = [item(a, 60000), item(b), item(c), item(d)], durable = new Set(q.map(e => e.msg.eventId))
    expect(selectReadyEvent(q, durable, {}, 1, true).msg.eventId).toBe('E002')
    expect(selectReadyEvent([q[0], q[2], q[3]], durable, {}, 1, true).msg.eventId).toBe('E003')
    expect(selectReadyEvent([q[3]], durable, {}, 1, true)).toBeNull()
    expect(selectReadyEvent([q[3]], durable, { E001: { status: 'applied', sid: 's' } }, 1, true).msg.eventId).toBe('E004')
  })
  it('multi-field completion/rest, structure, session and legacy messages are conservative', () => {
    const weight = ev('w', '1'), reps = ev('r', '1', 'reps'), done = ev('set', '1', 'set')
    expect(eventsOverlap(weight, reps)).toBe(false)
    expect(dependenciesFor(done, [weight, reps])).toEqual(['w', 'r'])
    for (const t of ['rest','focus','pause','add_set','remove_set','session_close','watch_start']) expect(eventsOverlap({ ...weight, t }, ev('x', '2'))).toBe(true)
    expect(eventsOverlap(weight, { ...ev('x', '2'), sid: 'other' })).toBe(true)
    expect(selectReadyEvent([item({ ...weight, dependencyEvents: false }, 60), item(ev('b','2'))], new Set(['w','b']), {}, 1, true)).toBeNull()
  })
  it('never treats conflict/rejection/unknown, sequence maxima or transport receipts as applied', () => {
    const child = { ...ev('child','1'), dependsOn: ['parent'] }
    for (const status of ['conflict','rejected','received']) expect(dependencyDecision(child, () => ({ sid:'s', status })).status).toBe('rejected')
    expect(dependencyDecision(child, () => null).status).toBe('missing')
    expect(dependencyDecision({ ...child, dependsOn: ['child'] }, () => null).reason).toBe('invalid_dependencies')
    expect(selectReadyEvent([item(ev('a','1'))], new Set(), {}, 1, true)).toBeNull()
  })
})
