import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'

function device(mode = 'success') {
  const { ctx, shared, disk } = watchPersistence()
  const sent = [], controls = [], errors = []
  const connection = {
    getReadyState: ({ success }) => success({ status: 0 }),
    send(options) {
      sent.push(options.data)
      if (options.data.eventId) {
        controls.push(options)
        if (mode === 'fail') return options.fail({ code: 12345, data: 'transport unavailable' })
        if (mode === 'fail-pair') return options.fail('transport unavailable', 12345)
        if (mode === 'throw') throw new Error('SDK threw')
        if (mode === 'timeout') return
      }
      options.success?.()
    },
  }
  Object.assign(ctx, { console: { info: vi.fn() }, WATCH_VERSION: 'test', interconnect: { instance: () => connection },
    loadState: () => ({ sid: 's' }), save() {}, closeSession() {}, buildSessionSummary() {}, summaryEventOf() {},
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', ctx, ['pendingSummaries', 'pendingEntry', 'journalEntry', 'prepareClose', 'releaseCandidate', 'markPhase', 'markDelivered'])
  loadWatchModule('rpc', ctx, ['startServer', 'sendEvent', 'sendControl', 'pendingCount', 'transportDiagnostics'])
  ctx.startServer({ onSync: () => ({ status: 'applied' }), onError: e => errors.push(e) })
  const snapshot = { t: 'sync', sid: 's', protocolVersion: 3, commitRev: 1 }
  connection.onMessage({ ...snapshot, wireHash: ctx.wireHash(snapshot) })
  expect(shared.rpc.peerProtocol).toBe(3)
  let sequence = Date.now()
  const emit = () => ctx.sendEvent({ t: 'rest', sid: 's', leftSec: 0, totalSec: 0, seq: ++sequence, at: sequence })
  return { ctx, shared, disk, connection, sent, controls, errors, emit }
}
afterEach(() => vi.useRealTimers())

describe('watch RPC transport diagnostics without delivery changes', () => {
  it('retains SDK failure details without acknowledging or bypassing the queue head', () => {
    const d = device('fail'); d.emit(); d.emit()
    const snapshot = d.ctx.transportDiagnostics()
    expect(snapshot.pending).toBe(2)
    expect(snapshot.phonePending).toBe(0)
    expect(d.controls).toHaveLength(1)
    expect(snapshot.events).toContainEqual(expect.objectContaining({ stage: 'send_fail', type: 'rest', code: '12345', detail: 'transport unavailable' }))
    expect(d.errors).toHaveLength(0)
  })
  it('also retains failure details when an API supplies message and code separately', () => {
    const d = device('fail-pair'); d.emit()
    expect(d.ctx.transportDiagnostics().events).toContainEqual(expect.objectContaining({
      stage: 'send_fail', type: 'rest', code: '12345', detail: 'transport unavailable',
    }))
    expect(d.ctx.pendingCount()).toBe(1)
    expect(d.controls).toHaveLength(1)
  })
  it('captures synchronous SDK exceptions without deleting the event', () => {
    const d = device('throw'); d.emit()
    expect(d.ctx.pendingCount()).toBe(1)
    expect(d.ctx.transportDiagnostics().events).toContainEqual(expect.objectContaining({ stage: 'send_exception', detail: 'SDK threw' }))
  })
  it('records callback timeouts and preserves the existing six-second retry', () => {
    vi.useFakeTimers()
    const d = device('timeout'); d.emit()
    vi.advanceTimersByTime(6000)
    expect(d.ctx.pendingCount()).toBe(1)
    expect(d.controls).toHaveLength(2)
    expect(d.ctx.transportDiagnostics().events).toContainEqual(expect.objectContaining({ stage: 'send_timeout', type: 'rest' }))
  })
  it('distinguishes transport success from received and terminal committed receipts', async () => {
    const d = device(); d.emit()
    const event = d.sent.find(m => m.eventId)
    expect(d.ctx.pendingCount()).toBe(1)
    expect(d.ctx.transportDiagnostics().events).toContainEqual(expect.objectContaining({ stage: 'send_success', eventId: event.eventId }))
    d.connection.onMessage({ t: 'received', sid: 's', eventId: event.eventId })
    expect(d.ctx.transportDiagnostics().phonePending).toBe(1)
    expect(d.ctx.transportDiagnostics().events).toContainEqual(expect.objectContaining({ stage: 'received', eventId: event.eventId }))
    d.connection.onMessage({ t: 'committed', sid: 's', eventId: event.eventId, status: 'applied', commitRev: 2 })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(d.ctx.pendingCount()).toBe(0)
    expect(d.ctx.transportDiagnostics().events).toContainEqual(expect.objectContaining({ stage: 'committed', eventId: event.eventId }))
  })
  it('makes a bounded snapshot with queue identities but no workout payload or extra disk writes', () => {
    const d = device(); const keys = [...d.disk.keys()]
    for (let i = 0; i < 60; i++) d.ctx.sendControl({ t: 'focus', sid: 's', secret: 'private-workout' })
    const snapshot = d.ctx.transportDiagnostics()
    expect(snapshot.events.length).toBeGreaterThan(0)
    expect(snapshot.events.length).toBeLessThanOrEqual(40)
    expect(JSON.stringify(snapshot)).not.toContain('private-workout')
    expect([...d.disk.keys()]).toEqual(keys)
    snapshot.events.length = 0
    expect(d.ctx.transportDiagnostics().events.length).toBeGreaterThan(0)
  })
  it('replies to an explicit diagnostic request out of band even with a blocked queue', () => {
    const d = device('fail'); d.emit(); d.emit()
    d.connection.onMessage({ t: 'watch_diagnostics_request', requestId: 'probe-1' })
    const reply = d.sent.find(m => m.t === 'watch_diagnostics')
    expect(reply).toMatchObject({ requestId: 'probe-1', sid: 's', pending: 2, phonePending: 0 })
    expect(reply.events.length).toBeLessThanOrEqual(8)
    expect(JSON.stringify(reply).length).toBeLessThan(4096)
    expect(reply.head).toMatchObject({ type: 'rest', eventId: d.controls[0].data.eventId })
    expect(d.ctx.pendingCount()).toBe(2)
    expect(d.controls).toHaveLength(1)
  })
  it('keeps diagnostic replies within the existing UTF-8 wire budget', () => {
    const d = device('fail'); d.emit()
    const large = '\u6d4b'.repeat(80)
    for (let i = 0; i < 8; i++) d.shared.rpc.trace.push({ at: Date.now(), stage: 'send_fail', type: 'rest',
      sid: large, eventId: large, headEventId: large, code: large, detail: large })
    d.connection.onMessage({ t: 'watch_diagnostics_request', requestId: 'unicode-probe' })
    const reply = d.sent.find(m => m.t === 'watch_diagnostics')
    expect(Buffer.byteLength(JSON.stringify(reply), 'utf8')).toBeLessThanOrEqual(6000)
    expect(reply.events.length).toBeGreaterThan(0)
    expect(reply.events.length).toBeLessThan(8)
    expect(d.ctx.pendingCount()).toBe(1)
  })
  it('records readiness and connection errors for a device that cannot send', () => {
    const d = device()
    d.connection.onError({ code: 77, data: 'link lost' })
    d.emit()
    const snapshot = d.ctx.transportDiagnostics()
    expect(snapshot.connected).toBe(false)
    expect(snapshot.readyState).toBe(0)
    expect(snapshot.events).toContainEqual(expect.objectContaining({ stage: 'connection_error', code: '77' }))
    expect(snapshot.events).toContainEqual(expect.objectContaining({ stage: 'ready_state', status: 0 }))
  })
  it('cannot let a throwing log sink change SDK send or queue behavior', () => {
    const d = device(); d.ctx.console = { info() { throw new Error('console unavailable') } }
    expect(() => d.emit()).not.toThrow()
    expect(d.controls).toHaveLength(1)
    expect(d.ctx.pendingCount()).toBe(1)
  })
})
