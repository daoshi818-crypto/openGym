import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collectWatchDiagnosticReport } from './watch-diagnostic-export.js'
import { requestWatchDiagnostics, requestWatchLog, getWatchLogs, getWatchDiagnostics } from './watch-link.js'

vi.mock('./watch-link.js', () => ({ requestWatchDiagnostics: vi.fn(), requestWatchLog: vi.fn(), getWatchLogs: vi.fn(), getWatchDiagnostics: vi.fn() }))
vi.mock('./watch-diagnostic-log.js', () => ({ phoneWatchLog: { snapshot: () => [{ stage: 'phone_commit' }], cachedWatch: () => ({ collectedAt: 123, events: [{ stage: 'old' }] }) } }))
beforeEach(() => {
  requestWatchDiagnostics.mockResolvedValue(true)
  requestWatchLog.mockResolvedValue({ status: 'received', events: [{ stage: 'dot_tap' }] })
  getWatchLogs.mockResolvedValue({ logs: 'SDK log' })
  getWatchDiagnostics.mockResolvedValue({ watchVersion: 'test' })
})
describe('diagnostic report collection', () => {
  it('combines phone SDK, business, watch interaction and environment records', async () => {
    const report = await collectWatchDiagnosticReport()
    expect(report).toMatchObject({ formatVersion: 1, watchProbeReceived: true, cachedWatchLog: null,
      watchLog: { events: [{ stage: 'dot_tap' }] }, nativeSdk: { logs: 'SDK log' }, phoneEvents: [{ stage: 'phone_commit' }] })
    expect(report.exportedAt).toMatch(/^\d{4}-/)
    expect(report.limitations.join(' ')).toContain('not BlueOS system crash dumps')
  })
  it('exports phone and explicitly dated cached watch logs even while disconnected', async () => {
    requestWatchDiagnostics.mockRejectedValue(new Error('offline'))
    requestWatchLog.mockResolvedValue({ status: 'timeout', events: [] })
    getWatchLogs.mockRejectedValue(new Error('SDK unavailable'))
    const report = await collectWatchDiagnosticReport()
    expect(report).toMatchObject({ watchProbeReceived: false, watchLog: { status: 'timeout' },
      cachedWatchLog: { collectedAt: 123 }, phoneEvents: [{ stage: 'phone_commit' }] })
  })
})
