import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchPersistence, loadWatchModule } from './watch-test-harness.js'
import { createWatchDiagnosticLog } from './watch-diagnostic-log.js'

function watch(disk = new Map()) {
  const d = watchPersistence(disk)
  loadWatchModule('diagnostic-log', d.ctx, ['recordDiagnostic', 'flushDiagnosticLog', 'diagnosticLog', 'diagnosticLogPage'])
  return d
}
afterEach(() => vi.useRealTimers())
describe('bounded independent watch diagnostic journal', () => {
  it('coalesces 1000 taps into one bounded record and one batched write', async () => {
    vi.useFakeTimers()
    const d = watch(), set = vi.spyOn(d.storage, 'set')
    for (let i = 0; i < 1000; i++) d.ctx.recordDiagnostic('dot_tap', { sid: 's', setId: 'row-' + i, secret: 'private' })
    expect(set).not.toHaveBeenCalled()
    expect(d.ctx.diagnosticLog().events).toMatchObject([{ stage: 'dot_tap', count: 1000, setId: 'row-999' }])
    await vi.advanceTimersByTimeAsync(1000)
    expect(set).toHaveBeenCalledOnce()
    expect([...d.disk.keys()]).toEqual(['watch_diagnostic_log_v1'])
    expect(JSON.stringify(d.ctx.diagnosticLog())).not.toContain('private')
  })
  it('retains flushed pre-exit records across runtime restart without touching session storage', () => {
    vi.useFakeTimers()
    const d = watch()
    d.ctx.recordDiagnostic('dot_commit_begin', { sid: 's', setId: 'five' })
    d.ctx.flushDiagnosticLog()
    const boot = d.ctx.diagnosticLog().boot
    vi.advanceTimersByTime(10)
    const reopened = watch(d.disk)
    reopened.ctx.recordDiagnostic('app_start', { version: 'test' })
    expect(reopened.ctx.diagnosticLog().events).toMatchObject([
      { stage: 'dot_commit_begin', setId: 'five', boot }, { stage: 'app_start' },
    ])
    expect(reopened.ctx.diagnosticLog().boot).not.toBe(boot)
    expect([...d.disk.keys()]).toEqual(['watch_diagnostic_log_v1'])
  })
  it('preserves interaction evidence through persisted restart and reconnect traffic', () => {
    vi.useFakeTimers()
    const d = watch()
    d.ctx.recordDiagnostic('dot_tap', { sid: 's', setId: 'second' })
    d.ctx.recordDiagnostic('dot_blocked', { sid: 's', setId: 'second', detail: 'rest', status: 'tap' })
    d.ctx.flushDiagnosticLog()
    vi.advanceTimersByTime(1000)
    const reopened = watch(d.disk)
    for (let i = 0; i < 200; i++) reopened.ctx.recordDiagnostic(i % 2 ? 'send_success' : 'rpc_receive', { type: 'session_close', sid: 'old-' + i })
    const log = reopened.ctx.diagnosticLog()
    expect(log.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'dot_tap', setId: 'second' }),
      expect.objectContaining({ stage: 'dot_blocked', detail: 'rest' }),
    ]))
    expect(log.events).toHaveLength(64)
    expect(log.dropped).toBe(138)
    expect(log.droppedInteractions).toBe(0)
    expect(reopened.ctx.diagnosticLogPage({ requestId: 'kept', offset: 0 }, 'test')).toMatchObject({ dropped: 138, droppedInteractions: 0, total: 64 })
    reopened.ctx.flushDiagnosticLog()
    expect(watch(d.disk).ctx.diagnosticLog()).toMatchObject({ dropped: 138, droppedInteractions: 0 })
  })
  it('keeps recent interaction and transport evidence within the existing count and byte limits', () => {
    vi.useFakeTimers()
    const d = watch(), long = '\u6d4b'.repeat(80)
    for (let i = 0; i < 100; i++) {
      d.ctx.recordDiagnostic('dot_tap', { set: i })
      d.ctx.recordDiagnostic('rpc_receive', { set: i })
    }
    let log = d.ctx.diagnosticLog()
    expect(log.events.filter(e => e.stage === 'dot_tap').map(e => e.set)).toEqual(Array.from({ length: 32 }, (_, i) => 68 + i))
    expect(log.events.filter(e => e.stage === 'rpc_receive').map(e => e.set)).toEqual(Array.from({ length: 32 }, (_, i) => 68 + i))
    expect(log.droppedInteractions).toBe(68)
    for (let i = 0; i < 100; i++) {
      d.ctx.recordDiagnostic('dot_blocked', { sid: long, eventId: long, detail: long, entryInstanceId: long })
      d.ctx.recordDiagnostic('send_success', { sid: long, eventId: long, detail: long, entryInstanceId: long })
    }
    log = d.ctx.diagnosticLog()
    expect(log.events.length).toBeLessThanOrEqual(64)
    expect(Buffer.byteLength(JSON.stringify(log.events))).toBeLessThanOrEqual(24000)
  })
  it('rate limits urgent tap checkpoints to one write per second', async () => {
    vi.useFakeTimers()
    const d = watch(), set = vi.spyOn(d.storage, 'set')
    for (let i = 0; i < 1000; i++) { d.ctx.recordDiagnostic('dot_tap', { set: i }); d.ctx.flushDiagnosticLog() }
    expect(set).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(set).toHaveBeenCalledTimes(2)
    expect(d.disk.get('watch_diagnostic_log_v1').events).toMatchObject([{ count: 1000, set: 999 }])
  })
  it('bounds byte size, freezes paged exports and returns repeatable retry pages', () => {
    vi.useFakeTimers()
    const d = watch(), long = '\u6d4b'.repeat(80)
    for (let i = 0; i < 200; i++) d.ctx.recordDiagnostic('stage-' + i, { sid: long, eventId: long, detail: long, entryInstanceId: long })
    const log = d.ctx.diagnosticLog()
    expect(log.events.length).toBeLessThanOrEqual(64)
    expect(Buffer.byteLength(JSON.stringify(log.events))).toBeLessThanOrEqual(24000)
    let offset = 0, all = []
    do {
      const request = { requestId: 'probe', offset }, page = d.ctx.diagnosticLogPage(request, 'test')
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(5500)
      d.ctx.recordDiagnostic('new-event')
      expect(d.ctx.diagnosticLogPage(request, 'test')).toEqual(page)
      all.push(...page.events); offset = page.nextOffset
    } while (offset < log.events.length)
    expect(all).toEqual(log.events)
    expect(d.ctx.diagnosticLogPage({ requestId: 'stale', offset: 12 }, 'test').status).toBe('expired')
  })
  it.each(['fail', 'throw', 'timeout'])('isolates %s storage without infinite writes or timers', async mode => {
    vi.useFakeTimers()
    const d = watch(), set = vi.spyOn(d.storage, 'set').mockImplementation(options => {
      if (mode === 'fail') options.fail()
      if (mode === 'throw') throw new Error('disk unavailable')
    })
    expect(() => d.ctx.recordDiagnostic('test')).not.toThrow()
    await vi.advanceTimersByTimeAsync(7000)
    for (let i = 0; i < 100; i++) d.ctx.recordDiagnostic('more')
    await vi.advanceTimersByTimeAsync(10000)
    expect(set).toHaveBeenCalledOnce()
    expect(d.ctx.diagnosticLog().storageFailed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('permits just one write in flight and persists the latest buffer afterward', async () => {
    vi.useFakeTimers()
    const d = watch(), writes = []
    vi.spyOn(d.storage, 'set').mockImplementation(o => writes.push(o))
    d.ctx.recordDiagnostic('first'); await vi.advanceTimersByTimeAsync(1000)
    d.ctx.recordDiagnostic('second'); d.ctx.flushDiagnosticLog()
    expect(writes).toHaveLength(1)
    writes[0].success(); await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toHaveLength(2)
    expect(writes[1].value.events).toMatchObject([{ stage: 'first' }, { stage: 'second' }])
    writes[1].success()
  })
})

describe('phone watch diagnostics', () => {
  it('persists only bounded scalar metadata and reloads it after reopening', async () => {
    vi.useFakeTimers()
    const disk = new Map(), setItem = vi.fn((k, v) => disk.set(k, v)), storage = () => ({ getItem: k => disk.get(k), setItem })
    const log = createWatchDiagnosticLog(storage)
    for (let i = 0; i < 500; i++) log.record('receive', { t: 'focus', eventId: String(i), workout: 'secret', token: 'secret' })
    expect(setItem).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(setItem).toHaveBeenCalledOnce()
    const reopened = createWatchDiagnosticLog(storage)
    expect(reopened.snapshot()).toHaveLength(160)
    expect(reopened.snapshot().at(-1)).toMatchObject({ eventId: '499' })
    expect(JSON.stringify(reopened.snapshot())).not.toContain('secret')
    log.cacheWatch({ status: 'received', collectedAt: 42, events: [] })
    expect(reopened.cachedWatch()).toMatchObject({ collectedAt: 42 })
  })
  it('continues recording/exporting in memory when phone storage is unavailable', () => {
    vi.useFakeTimers()
    const log = createWatchDiagnosticLog(() => { throw new Error('blocked') })
    expect(() => log.record('receive', { t: 'focus' })).not.toThrow()
    expect(log.snapshot()).toMatchObject([{ t: 'focus' }])
  })
})
