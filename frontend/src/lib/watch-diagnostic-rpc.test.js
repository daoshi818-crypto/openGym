import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('watch diagnostics RPC replies', () => {
  it('stamps actual diagnostic and log sends after device-selection negotiation', () => {
    vi.useFakeTimers()
    const h = watchPersistence(), sent = []
    const connection = {
      getReadyState: ({ success }) => success({ status: 1 }),
      send: item => { sent.push(structuredClone(item.data)); item.success?.() },
    }
    const c = h.ctx
    Object.assign(c, {
      interconnect: { instance: () => connection },
      WATCH_VERSION: 'test', console,
      loadState: () => ({ sid: 'session-1', active: true }),
      save: () => {}, buildSessionSummary: () => ({}), summaryEventOf: () => ({}), closeSession() {},
    })
    loadWatchModule('event-id', c, ['allocateEventIdentity', 'rememberEventAt'])
    loadWatchModule('close-journal', c, ['journalEntry', 'pendingCloseEvents', 'pendingSummaries', 'pendingEntry', 'prepareClose', 'releaseCandidate', 'markPhase', 'markEntry', 'markDelivered'])
    loadWatchModule('rpc', c, ['startServer'])
    c.startServer({}); connection.onOpen()

    const hello = sent.find(message => message.t === 'hello')
    expect(hello.installationId).toBeTruthy()
    connection.onMessage({ t: 'hello_ack', protocolVersion: 3, capabilities: { deviceSelection: true } })
    connection.onMessage({ t: 'watch_diagnostics_request', requestId: 'diag-1', targetInstallationId: hello.installationId })
    const diagnostic = sent.find(message => message.t === 'watch_diagnostics')
    expect(diagnostic).toMatchObject({ requestId: 'diag-1', sourceInstallationId: hello.installationId })

    vi.advanceTimersByTime(120)
    connection.onMessage({ t: 'watch_log_request', requestId: 'log-1', offset: 0, targetInstallationId: hello.installationId })
    const log = sent.find(message => message.t === 'watch_log')
    expect(log).toMatchObject({ requestId: 'log-1', offset: 0, sourceInstallationId: hello.installationId })
  })
})
