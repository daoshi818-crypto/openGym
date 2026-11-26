// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadWatchModule, watchPersistence, watchTimerOwner, startWatchApp } from './watch-test-harness.js'

function device(count = 40, disk = new Map(), lifecycle = false) {
  const { shared, storage, ctx } = watchPersistence(disk)
  const pageTimers = watchTimerOwner()
  if (lifecycle) { startWatchApp(shared); Object.assign(ctx, pageTimers) }
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
  if (lifecycle) Object.assign(ctx, pageTimers)
  loadWatchModule('rpc', ctx, ['startServer', 'stopServer', 'sendEvent', 'pendingCount', 'transportDiagnostics', 'replayPendingEvents'])
  ctx.startServer({})
  return { pageTimers, ctx, disk, shared, connection, sent, writes, save, loadState, edits }
}
const events = h => h.sent.filter(e => e.eventId)
function openLegacy(h, protocolVersion = 3) {
  h.connection.onOpen()
  h.connection.onMessage({ t: 'hello_ack', protocolVersion, capabilities: { dependencyEvents: protocolVersion >= 3 } })
}
afterEach(() => vi.useRealTimers())
describe('watch backlog fairness and durable replay', () => {
  it('reads only heart rate on clock ticks without traversing the workout or backlog', () => {
    const h = watchPersistence()
    loadWatchModule('session', h.ctx, ['readSessionHr'])
    const hr = { last: 120, sampleAt: Date.now() }
    h.ctx.writeStored('session_state', { sid: 's', hr })
    const cached = h.shared.persistence.values.session_state
    Object.defineProperty(cached, 'workout', { enumerable: true, get() { throw new Error('full workout traversal') } })
    Object.defineProperty(cached, 'pendingEdits', { enumerable: true, get() { throw new Error('backlog traversal') } })
    expect(h.ctx.readSessionHr('s')).toEqual(hr)
    h.ctx.readSessionHr('s').last = 1
    expect(h.ctx.readSessionHr('s').last).toBe(120)
    expect(h.ctx.readSessionHr('other')).toBeNull()
  })
  it('hydrates a cold cache before projecting fields and retains normal full reads', () => {
    const h = watchPersistence(new Map([['session_state', { sid: 's', hr: { last: 90 }, workout: { rows: [1] } }]]))
    expect(h.ctx.readStored('session_state', ['sid', 'hr'])).toEqual({ sid: 's', hr: { last: 90 } })
    expect(h.ctx.readStored('session_state').workout.rows).toEqual([1])
    expect(h.ctx.readStored('missing', ['sid'])).toBeNull()
  })
  it('projects transport and replay identity without traversing workout rows', () => {
    const h = watchPersistence()
    loadWatchModule('session', h.ctx, ['loadState'])
    h.ctx.readStored('cache-bootstrap')
    const cached = { sid: 's', active: true, sessionOrigin: 'phone', phoneSession: { sid: 's' },
      pendingEdits: [{ eventId: 'e' }], syncBase: { wireHash: 'hash', commitRev: 4 } }
    Object.defineProperty(cached, 'workout', { enumerable: true, get() { throw new Error('workout cloned on transport hot path') } })
    h.shared.persistence.values.session_state = cached
    expect(h.ctx.loadState('rpc')).toMatchObject({ sid: 's', active: true, syncBase: { wireHash: 'hash', commitRev: 4 } })
    expect(h.ctx.loadState('replay')).toMatchObject({ sid: 's', pendingEdits: [{ eventId: 'e' }] })
  })
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
    openLegacy(h)
    expect(events(h).length).toBeLessThanOrEqual(1)
    expect(h.sent.some(e => e.t === 'hello')).toBe(true)
    vi.advanceTimersByTime(120)
    expect(events(h).length).toBeLessThanOrEqual(2)
    expect(h.ctx.pendingCount()).toBe(40) // transport success is not a saved receipt
  })
  it('recovers 40 keypad edits in bounded batches and ignores rapid replay requests', () => {
    vi.useFakeTimers()
    const h = device(40, new Map([['rpc_outbox', []]]))
    openLegacy(h)
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
    h.connection.onOpen()
    h.loadState.mockImplementationOnce(() => { throw new Error('temporary read error') })
    h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true } })
    h.ctx.replayPendingEvents()
    expect(h.ctx.pendingCount()).toBe(2)
    vi.advanceTimersByTime(120)
    expect(h.ctx.pendingCount()).toBe(4)
  })
  it('cancels batched replay on stop and resumes from durable edits on restart', () => {
    vi.useFakeTimers()
    const h = device(6, new Map([['rpc_outbox', []]]))
    openLegacy(h)
    h.ctx.replayPendingEvents()
    expect(h.ctx.pendingCount()).toBe(2)
    h.ctx.stopServer()
    vi.advanceTimersByTime(1000)
    expect(h.ctx.pendingCount()).toBe(2)
    h.ctx.startServer({})
    openLegacy(h)
    h.ctx.replayPendingEvents()
    vi.advanceTimersByTime(120)
    expect(h.ctx.pendingCount()).toBe(6)
  })
  it('keeps v3 commits ordered and retains every unacknowledged event after connection loss', () => {
    vi.useFakeTimers()
    const h = device()
    openLegacy(h)
    vi.advanceTimersByTime(1000)
    expect(events(h).map(e => e.eventId)).toEqual(['event-0'])
    h.connection.onMessage({ t: 'received', sid: 's', eventId: 'event-0' })
    expect(h.ctx.pendingCount()).toBe(40)
    h.connection.onClose()
    vi.advanceTimersByTime(12000)
    expect(events(h).map(e => e.eventId)).toEqual(['event-0'])
    expect(h.disk.get('rpc_outbox')).toHaveLength(40)
    openLegacy(h)
    expect(events(h).at(-1).eventId).toBe('event-0')
  })
  it('spaces rapid clicks, commits exact IDs and recovers all records after restart', async () => {
    vi.useFakeTimers()
    const h = device()
    openLegacy(h, 2)
    const initiallySent = events(h).length
    for (let i = 0; i < 20; i++) h.ctx.sendEvent({ t: 'focus', sid: 's', eventId: 'tap-' + i, at: 100 + i })
    expect(events(h).length).toBe(initiallySent)
    expect(h.ctx.pendingCount()).toBe(60)
    h.connection.onMessage({ t: 'ack', eventId: 'event-0' })
    h.connection.onMessage({ t: 'ack', eventId: 'event-0' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.ctx.pendingCount()).toBe(59)
    h.ctx.stopServer()
    const restored = device(0, h.disk)
    expect(restored.ctx.pendingCount()).toBe(59)
    openLegacy(restored, 2)
    vi.advanceTimersByTime(10000)
    expect(new Set(events(restored).map(e => e.eventId)).size).toBe(59)
    for (const row of [...restored.disk.get('rpc_outbox')]) restored.connection.onMessage({ t: 'ack', eventId: row.msg.eventId })
    await vi.advanceTimersByTimeAsync(0)
    expect(restored.ctx.pendingCount()).toBe(0)
    expect(restored.disk.get('rpc_outbox')).toEqual([])
  })
})

describe('application lifetime transport', () => {
  it('replays a close created after transport initialization in batches after the page is destroyed', async () => {
    vi.useFakeTimers()
    const h = device(0, new Map([['rpc_outbox', []]]), true), c = h.ctx
    openLegacy(h)
    loadWatchModule('event-id', c, ['allocateEventIdentity', 'rememberEventAt'])
    loadWatchModule('close-journal', c, ['prepareClose', 'journalEntry', 'pendingSummaries', 'pendingEntry'])
    loadWatchModule('session', c, ['startSession', 'loadState', 'save'])
    c.startSession({ sid: 's', name: 'Bench', protocolVersion: 3, exercises: [{ name: 'Bench', sets: 1, reps: 8, weight: 50 }] })
    for (let i=0;i<7;i++) await c.commitSessionAction('s', s => c.stageSessionEvent(s, { t: 'weight', sid: 's', ex: 0, set: 1, weight: 50+i, eventId: 'new-'+i, at: i+1 }))
    const closed = await c.commitLocalClose('s', 'saved')
    expect(closed.ok).toBe(true); expect(c.loadState().active).toBe(false)
    c.replayPendingEvents()
    expect(c.pendingCount()).toBe(2)
    h.pageTimers.destroy()
    await vi.advanceTimersByTimeAsync(1000)
    const queued = h.shared.rpc.outbox.map(e=>e.msg)
    expect(queued).toHaveLength(9)
    expect(queued.slice(0,7).map(e=>e.eventId)).toEqual(Array.from({length:7},(_,i)=>'new-'+i))
    expect(queued[7]).toEqual(closed.entry.closeEvent)
    expect(queued[8]).toEqual(closed.entry.summaryEvent)
    expect(h.shared.rpc.replaying).toBe(false)
    c.replayPendingEvents(); await vi.advanceTimersByTimeAsync(1000)
    expect(c.pendingCount()).toBe(9)
  })
  it('stops rapid replay retries when a full outbox accepts no events and retains the journal', () => {
    vi.useFakeTimers()
    const h = device(4096), errors = [], pending = Array.from({length:8},(_,i)=>({ t:'weight',sid:'s',eventId:'close-edit-'+i,dependencyEvents:true,dependsOn:[],at:5000+i }))
    h.ctx.pendingCloseEvents = () => structuredClone(pending)
    h.ctx.startServer({ onError: e=>errors.push(e) })
    openLegacy(h)
    h.ctx.replayPendingEvents()
    expect(h.shared.rpc.replaying).toBe(false)
    expect(errors).toHaveLength(1)
    vi.advanceTimersByTime(3000)
    expect(errors).toHaveLength(1)
    expect(h.ctx.pendingCount()).toBe(4096)
    expect(h.ctx.pendingCloseEvents()).toEqual(pending)
  })
  it('continues draining after page destruction when legacy events receive exact acknowledgements', async () => {
    vi.useFakeTimers()
    const h = device(40, new Map([['rpc_outbox', []]]), true)
    h.connection.send = ({ data, success }) => {
      h.sent.push(data)
      success?.()
      if (data.eventId) h.connection.onMessage({ t: 'ack', eventId: data.eventId })
    }
    openLegacy(h, 2)
    h.ctx.replayPendingEvents()
    h.pageTimers.destroy()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.ctx.pendingCount()).toBeLessThan(40)
    expect(events(h).length).toBeGreaterThan(2)
    expect(h.shared.rpc.replaying).toBe(false)
  })
  it('releases a lost send callback and retries after page destruction', () => {
    vi.useFakeTimers()
    const h = device(1, new Map(), true)
    h.connection.send = ({ data, success }) => { h.sent.push(data); if (!data.eventId) success() }
    openLegacy(h)
    h.pageTimers.destroy()
    vi.advanceTimersByTime(6500)
    expect(events(h)).toHaveLength(1) // Timeout releases the gate, but must respect failure backoff.
    vi.advanceTimersByTime(5500)
    expect(events(h).length).toBeGreaterThan(1)
    expect(h.ctx.pendingCount()).toBe(1)
  })
  it('does not send a new hello or rebind native callbacks just for a page change', () => {
    vi.useFakeTimers()
    const h = device(0)
    openLegacy(h)
    const callback = h.connection.onMessage
    const hellos = h.sent.filter(e => e.t === 'hello').length
    for (let i = 0; i < 20; i++) h.ctx.startServer({})
    expect(h.sent.filter(e => e.t === 'hello')).toHaveLength(hellos)
    expect(h.connection.onMessage).toBe(callback)
  })
  it('storage watchdog survives page destruction and leaves failed writes retryable', async () => {
    vi.useFakeTimers()
    const h = watchPersistence(), page = watchTimerOwner()
    startWatchApp(h.shared)
    Object.assign(h.ctx, page)
    h.storage.set = () => {} // dropped native callback
    const result = h.ctx.writeStoredConfirmed('session_state', { sid: 's' })
    page.destroy()
    vi.advanceTimersByTime(5001)
    expect(h.ctx.storageStatus().failed).toBe(true)
    expect(await result).toBe(false)
    h.storage.set = ({ success }) => success()
    h.ctx.retryStorage()
    expect(h.ctx.storageStatus()).toEqual({ failed: false, pending: false })
  })
})


describe('bounded Outbox insertion',()=>{
  it('refuses oversized insertion without dropping an existing durable event',()=>{
    vi.useFakeTimers()
    const h=device(1), errors=[]
    h.ctx.startServer({onError:e=>errors.push(e)})
    const before=structuredClone(h.disk.get('rpc_outbox'))
    expect(h.ctx.sendEvent({t:'weight',sid:'s',eventId:'oversized',at:3,dependencyEvents:true,dependsOn:[],weight:'x'.repeat(2*1024*1024)})).toBe(false)
    expect(h.ctx.pendingCount()).toBe(1)
    expect(h.disk.get('rpc_outbox')).toEqual(before)
    expect(errors).toContainEqual({code:'outbox_capacity'})
  })
})
