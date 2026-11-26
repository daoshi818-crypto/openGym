// Host regression: legacy session outbox, production RPC and phone reducer, fake SDK/storage only.
// This does not establish Android process wake or BlueOS device behavior.
import { afterEach, expect, it, vi } from 'vitest'
import { legacyWatchWorkout } from './watch-legacy-start-fixture.js'
import { createDurableWatchLifecycle } from './watch-commit.js'
import { applyEdit, applyRest } from '../../../watch-app/src/lib/protocol.js'
import { wireBytes, wireHash } from '../../../watch-app/src/lib/sync-wire.js'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

function setup({ count = 1, limit = Infinity } = {}) {
  vi.useFakeTimers()
  const S = { workouts: [], unit: 'kg' }, legacy = legacyWatchWorkout(count)
  const h = watchPersistence(), sent = []
  const delivered = [], fragments = new Map()
  const connection = { send: ({ data, success, fail }) => {
    sent.push(structuredClone(data))
    if (wireBytes(JSON.stringify(data)) > limit) { fail?.({ message: 'param error' }, 1000); return }
    if (data.t === 'watch_event_chunk') {
      fragments.set(data.offset, data.data)
      const text = [...fragments].sort((a, b) => a[0] - b[0]).map(e => e[1]).join('')
      if (text.length === data.total && wireHash(text) === data.hash) { delivered.push(JSON.parse(text)); fragments.clear() }
    } else delivered.push(structuredClone(data))
    success?.()
  }, getReadyState: ({ success }) => success({ status: 1 }) }
  Object.assign(h.ctx, { applyEdit, applyRest, console: { info() {} }, WATCH_VERSION: 'test', router: { replace: vi.fn() }, interconnect: { instance: () => connection } })
  loadWatchModule('event-id', h.ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', h.ctx, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
  loadWatchModule('session', h.ctx, ['commitSessionStart', 'loadState', 'save', 'closeSession', 'buildSessionSummary', 'summaryEventOf'])
  loadWatchModule('rpc', h.ctx, ['startServer', 'sendEvent', 'replayPendingEvents', 'pendingCount'])
  h.ctx.startServer({})
  // Simulate recovery of the previous version's durable queue without using the removed home screen.
  const writeLegacyStart = async () => {
    const result = await h.ctx.commitSessionStart(legacy, {})
    if (result.ok) h.ctx.replayPendingEvents()
    return result.ok
  }
  const onStarted = vi.fn(), replies = []
  const receive = createDurableWatchLifecycle({ getState: () => S, update: fn => fn(S), getTimer: () => null,
    checkpoint: async () => {}, onStarted, send: msg => { replies.push(msg); connection.onMessage(msg) },
    sendAck: () => {}, sendSync: () => {}, sendEnded: () => {}, completeInbox: async () => {} })
  return { ...h, S, sent, delivered, replies, connection, writeLegacyStart, receive, onStarted }
}

it('delivers a large start through a size-rejecting SDK without changing the durable event identity', async () => {
  const h = setup({ count: 8, limit: 3000 })
  h.connection.onOpen()
  h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true, watchEventChunks: true } })
  await h.writeLegacyStart()
  const frozen = structuredClone(h.disk.get('session_state').pendingEdits[0])
  await vi.advanceTimersByTimeAsync(3000)
  const event = h.delivered.find(e => e.t === 'watch_start')
  expect(event).toBeTruthy()
  expect(event.eventId).toBe(frozen.eventId)
  expect(event.plan.entries).toEqual(frozen.plan.entries)
  expect(h.ctx.pendingCount()).toBe(1) // SDK/chunk success never commits a training event.
  expect(h.receive(event)).toBe(true); await h.receive.idle()
  await vi.advanceTimersByTimeAsync(500)
  expect(h.S.active.watchSid).toBe(event.sid)
  expect(h.ctx.pendingCount()).toBe(0)
  h.receive.dispose()
})

it.each(['failure', 'reconnect'])('replays the whole large event after partial %s and consumes only the exact business commit', async mode => {
  const h = setup({ count: 8, limit: 3000 }), send = h.connection.send
  let chunks = 0, interrupted = false
  h.connection.send = args => {
    if (args.data.t === 'watch_event_chunk' && !interrupted && ++chunks === 2) {
      interrupted = true
      if (mode === 'failure') args.fail?.({ message: 'disconnected' }, 1007)
      // Restart resets the native gate; no callback is promised for the old send.
      return
    }
    send(args)
  }
  h.connection.onOpen()
  const hello = { t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true, watchEventChunks: true, commandReceipts: true } }
  h.connection.onMessage(hello)
  await h.writeLegacyStart(); await vi.advanceTimersByTimeAsync(500)
  expect(h.delivered.some(e => e.t === 'watch_start')).toBe(false)
  expect(h.disk.get('rpc_outbox')).toHaveLength(1)
  // A new snapshot proof must not change an in-flight fragment checksum.
  const state = h.ctx.loadState()
  state.syncBase = { wireHash: 'different-proof', commitRev: 12 }; h.ctx.save(state)
  if (mode === 'reconnect') {
    h.ctx.startServer({}); h.connection.onClose(); h.connection.onOpen(); h.connection.onMessage(hello)
  }
  await vi.advanceTimersByTimeAsync(8000)
  const event = h.delivered.find(e => e.t === 'watch_start')
  expect(event).toBeTruthy()
  expect(event.appliedHash).toBeUndefined()
  expect(h.ctx.pendingCount()).toBe(1)
  h.receive(event); await h.receive.idle(); await vi.advanceTimersByTimeAsync(500)
  expect(h.onStarted).toHaveBeenCalledOnce()
  expect(h.ctx.pendingCount()).toBe(0)
  h.receive.dispose()
})

it('replays a previously queued start through durable RPC and consumes the exact phone commit', async () => {
  const h = setup()
  h.connection.onOpen()
  h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true } })
  await h.writeLegacyStart()
  await vi.advanceTimersByTimeAsync(500)
  const event = h.sent.find(e => e.t === 'watch_start')
  expect(event).toBeTruthy()
  expect(event.dependsOn).toEqual([])
  expect(h.disk.get('session_state').pendingEdits[0].eventId).toBe(event.eventId)
  expect(h.receive(event)).toBe(true); await h.receive.idle()
  await vi.advanceTimersByTimeAsync(500)
  expect(h.S.active.watchSid).toBe(event.sid)
  expect(h.onStarted).toHaveBeenCalledExactlyOnceWith(event.sid)
  expect(h.ctx.loadState().pendingStart).toBe(false)
  expect(h.ctx.pendingCount()).toBe(0)
  h.receive.dispose()
})

it('does not replay an uncommitted legacy start and sends it after storage recovers', async () => {
  const h = setup(), write = h.storage.set
  h.connection.onOpen()
  h.connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { dependencyEvents: true } })
  let fail = true
  h.storage.set = args => { if (args.key === 'session_state' && fail) { fail = false; args.fail?.(); return } write(args) }
  expect(await h.writeLegacyStart()).toBe(false)
  expect(h.ctx.loadState().active).toBe(false)
  expect(h.sent.some(e => e.t === 'watch_start')).toBe(false)
  expect(await h.writeLegacyStart()).toBe(true)
  await vi.advanceTimersByTimeAsync(500)
  const event = h.sent.find(e => e.t === 'watch_start')
  expect(event).toBeTruthy()
  expect(h.receive(event)).toBe(true); await h.receive.idle()
  expect(h.onStarted).toHaveBeenCalledExactlyOnceWith(event.sid)
  h.receive.dispose()
})
