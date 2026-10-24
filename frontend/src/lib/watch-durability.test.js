// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { loadWatchModule } from './watch-test-harness.js'

function harness() {
  const shared = {}, disk = new Map(), writes = [], sent = [], failures = []
  const storage = { getSync: ({key}) => structuredClone(disk.get(key)), set: item => writes.push(item) }
  const runtime = () => shared
  const context = { runtime, storage, console, Date, setTimeout, clearTimeout }
  loadWatchModule('persistence', context, ['readStored', 'writeStored', 'writeStoredConfirmed', 'retryStorage', 'storageStatus'])
  const persistence = { readStored: context.readStored, writeStored: context.writeStored, retryStorage: context.retryStorage, storageStatus: context.storageStatus }
  const connection = { getReadyState: ({success}) => success({status:1}), send: item => { sent.push(item); if (!connection.hang) item.success() } }
  const transport = () => {
    const ctx = { runtime, ...persistence, writeStoredConfirmed: context.writeStoredConfirmed, storage,
      interconnect: { instance: () => connection }, loadState: () => ({}), save() {},
      buildSessionSummary: () => ({ sets: [] }), summaryEventOf: () => ({}), closeSession() {},
      WATCH_VERSION: 'test', Date, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, console }
    loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
    loadWatchModule('close-journal', ctx, ['pendingSummaries', 'pendingEntry', 'journalEntry', 'prepareClose', 'releaseCandidate', 'markPhase', 'markDelivered'])
    loadWatchModule('rpc', ctx, ['startServer', 'sendEvent', 'pendingCount', 'persistenceStatus'])
    return { startServer: ctx.startServer, sendEvent: ctx.sendEvent, pendingCount: ctx.pendingCount, persistenceStatus: ctx.persistenceStatus }
  }
  const commit = index => { const item = writes[index]; disk.set(item.key, structuredClone(item.value)); item.success?.() }
  return { shared, disk, writes, sent, failures, persistence, connection, transport, commit }
}
afterEach(() => vi.useRealTimers())

it('serializes session snapshots and retains the latest state while a write is delayed or fails', () => {
  const h = harness(), p = h.persistence
  p.writeStored('session_state', {rev:1}); p.writeStored('session_state', {rev:2})
  expect(h.writes).toHaveLength(1)
  expect(p.readStored('session_state')).toEqual({rev:2})
  h.commit(0); expect(h.writes).toHaveLength(2)
  h.writes[1].fail(); expect(p.storageStatus().failed).toBe(true)
  p.retryStorage(); h.commit(2)
  expect(h.disk.get('session_state')).toEqual({rev:2})
  expect(p.storageStatus()).toEqual({failed:false,pending:false})
})

it('shares one outbox across independent page bundles and sends only durable events', () => {
  const h = harness(), first = h.transport(), second = h.transport()
  first.startServer({onError:e=>h.failures.push(e)}); h.connection.onOpen()
  h.commit(0) // Persist empty outbox at connection setup, if any.
  first.sendEvent({t:'weight',sid:'s',ex:0,set:1,weight:20,eventId:'a',at:1})
  second.startServer({})
  second.sendEvent({t:'reps',sid:'s',ex:0,set:1,reps:10,eventId:'b',at:2})
  expect(h.sent.filter(x=>x.data.eventId)).toHaveLength(0)
  // Skip the event_clock writes: explicit event IDs avoid those writes here.
  for(let i=1;i<h.writes.length;i++) h.commit(i)
  expect(first.pendingCount()).toBe(2); expect(second.pendingCount()).toBe(2)
  expect(h.sent.filter(x=>x.data.eventId).map(x=>x.data.eventId)).toEqual(['a','b'])
  h.connection.onMessage({t:'ack',eventId:'a'})
  expect(second.pendingCount()).toBe(1)
})

it('releases a lost send callback after six seconds and ignores its later completion', () => {
  vi.useFakeTimers()
  const h = harness(), rpc = h.transport()
  rpc.startServer({}); h.connection.onOpen(); h.commit(0); h.connection.hang = true
  rpc.sendEvent({t:'set',sid:'s',ex:0,set:1,eventId:'a',at:1}); h.commit(1)
  const first = h.sent.find(x=>x.data.eventId==='a')
  expect(first).toBeTruthy()
  vi.advanceTimersByTime(6000)
  expect(h.sent.filter(x=>x.data.eventId==='a')).toHaveLength(2)
  first.success()
  expect(rpc.pendingCount()).toBe(1)
})
