// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'

function device(count = 40, disk = new Map()) {
  const { shared, storage, ctx } = watchPersistence(disk)
  const writes = [], sent = []
  const put = storage.set
  storage.set = item => { writes.push(item.key); put(item) }
  let state = { active: true, sid: 's', pendingEdits: [], workout: { exercises: [], rows: [] } }
  const edits = Array.from({ length: count }, (_, i) => ({ t: 'weight', sid: 's', ex: 0,
    set: i + 1, weight: 20 + i, at: i + 1, eventId: 'event-' + i }))
  if (!disk.has('rpc_outbox')) disk.set('rpc_outbox', edits.map(msg => ({ at: msg.at, msg, sent: false })))
  state.pendingEdits = edits
  const loadState = vi.fn(() => structuredClone(state))
  const save = vi.fn(s => { state = structuredClone(s) })
  const connection = { send: ({ data, success }) => { sent.push(data); success?.() },
    getReadyState: ({ success }) => success({ status: 0 }) }
  Object.assign(ctx, { console: { info() {} }, loadState, save,
    interconnect: { instance: () => connection }, WATCH_VERSION: 'test',
    setInterval, clearInterval, pendingSummaries: () => [], pendingEntry: () => null,
    journalEntry: () => null, rememberEventAt() {}, allocateEventIdentity: () => ({ eventId: 'new' }) })
  loadWatchModule('rpc', ctx, ['startServer', 'stopServer', 'sendEvent', 'pendingCount', 'transportDiagnostics', 'replayPendingEvents'])
  ctx.startServer({})
  return { ctx, disk, shared, connection, sent, writes, save, loadState, edits }
}
const events = h => h.sent.filter(e => e.eventId)
afterEach(() => vi.useRealTimers())
describe('watch backlog fairness and durable replay', () => {
  it('does not read/rewrite the entire session when 40 already queued edits are replayed', () => {
    vi.useFakeTimers()
    const h = device()
    for (const edit of h.edits) h.ctx.sendEvent(edit)
    expect(h.loadState).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
    expect(h.writes).toHaveLength(0)
    expect(h.ctx.pendingCount()).toBe(40)
  })
  it('yields between sends instead of draining 40 records in one SDK callback stack', () => {
    vi.useFakeTimers()
    const h = device()
    h.connection.onOpen()
    expect(events(h).length).toBeLessThanOrEqual(1)
    expect(h.sent.some(e => e.t === 'hello')).toBe(true)
    vi.advanceTimersByTime(120)
    expect(events(h).length).toBeLessThanOrEqual(2)
    expect(h.ctx.pendingCount()).toBe(40) // transport success is not a saved receipt
  })
  it('recovers 40 keypad edits in bounded batches and ignores rapid replay requests', () => {
    vi.useFakeTimers()
    const h = device(40, new Map([['rpc_outbox', []]]))
    h.ctx.replayPendingEvents()
    expect(h.ctx.pendingCount()).toBe(2)
    for (let i = 0; i < 20; i++) h.ctx.replayPendingEvents()
    expect(h.ctx.pendingCount()).toBe(2)
    vi.advanceTimersByTime(2400)
    expect(h.ctx.pendingCount()).toBe(40)
    expect(h.save).toHaveBeenCalledTimes(40) // new events only, never quadratic replay writes
    h.ctx.replayPendingEvents()
    expect(h.save).toHaveBeenCalledTimes(40)
  })
  it('recovers from a failed session read without leaving replay permanently locked', () => {
    vi.useFakeTimers()
    const h = device(4, new Map([['rpc_outbox', []]]))
    h.loadState.mockImplementationOnce(() => { throw new Error('temporary read error') })
    h.ctx.replayPendingEvents()
    expect(h.ctx.pendingCount()).toBe(0)
    h.ctx.replayPendingEvents()
    vi.advanceTimersByTime(120)
    expect(h.ctx.pendingCount()).toBe(4)
  })
  it('cancels batched replay on stop and resumes from durable edits on restart', () => {
    vi.useFakeTimers()
    const h = device(6, new Map([['rpc_outbox', []]]))
    h.ctx.replayPendingEvents()
    expect(h.ctx.pendingCount()).toBe(2)
    h.ctx.stopServer()
    vi.advanceTimersByTime(1000)
    expect(h.ctx.pendingCount()).toBe(2)
    h.ctx.startServer({})
    h.ctx.replayPendingEvents()
    vi.advanceTimersByTime(120)
    expect(h.ctx.pendingCount()).toBe(6)
  })
  it('keeps v3 commits ordered and retains every unacknowledged event after connection loss', () => {
    vi.useFakeTimers()
    const h = device()
    h.shared.rpc.peerProtocol = 3
    h.connection.onOpen()
    vi.advanceTimersByTime(1000)
    expect(events(h).map(e => e.eventId)).toEqual(['event-0'])
    h.connection.onMessage({ t: 'received', sid: 's', eventId: 'event-0' })
    expect(h.ctx.pendingCount()).toBe(40)
    h.connection.onClose()
    vi.advanceTimersByTime(12000)
    expect(events(h).map(e => e.eventId)).toEqual(['event-0'])
    expect(h.disk.get('rpc_outbox')).toHaveLength(40)
    h.connection.onOpen()
    expect(events(h).at(-1).eventId).toBe('event-0')
  })
  it('spaces rapid clicks, commits exact IDs and recovers all records after restart', () => {
    vi.useFakeTimers()
    const h = device()
    h.connection.onOpen()
    const initiallySent = events(h).length
    for (let i = 0; i < 20; i++) h.ctx.sendEvent({ t: 'focus', sid: 's', eventId: 'tap-' + i, at: 100 + i })
    expect(events(h).length).toBe(initiallySent)
    expect(h.ctx.pendingCount()).toBe(60)
    h.connection.onMessage({ t: 'ack', eventId: 'event-0' })
    h.connection.onMessage({ t: 'ack', eventId: 'event-0' })
    expect(h.ctx.pendingCount()).toBe(59)
    h.ctx.stopServer()
    const restored = device(0, h.disk)
    expect(restored.ctx.pendingCount()).toBe(59)
    restored.connection.onOpen()
    vi.advanceTimersByTime(10000)
    expect(new Set(events(restored).map(e => e.eventId)).size).toBe(59)
    for (const row of [...restored.disk.get('rpc_outbox')]) restored.connection.onMessage({ t: 'ack', eventId: row.msg.eventId })
    expect(restored.ctx.pendingCount()).toBe(0)
    expect(restored.disk.get('rpc_outbox')).toEqual([])
  })
})
