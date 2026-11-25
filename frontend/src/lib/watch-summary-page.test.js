// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { loadWatchModule, stripImports, watchPersistence, watchSource } from './watch-test-harness.js'
import { summaryDurationLabel, summaryMinutesOf, summaryNameLabel, summarySetsLabel,
  summaryVolumeOf, summaryHeartOf, summaryCaloriesOf, summarySyncLabel } from '../../../watch-app/src/lib/summary-view.js'

it('reads only one close-journal delivery field from a hydrated cache', () => {
  const h = watchPersistence(new Map([['watch_close_journal_v1', { schemaVersion: 1, entries: {
    current: { delivery: 'pending', summaryEvent: { payload: 'large frozen summary' } },
    other: { delivery: 'delivered', summaryEvent: { payload: 'another frozen summary' } },
  } }]]))
  loadWatchModule('close-journal', h.ctx, ['journalDelivery'])
  h.ctx.readStored('watch_close_journal_v1')
  const entries = h.shared.persistence.values.watch_close_journal_v1.entries
  for (const sid of ['current', 'other']) Object.defineProperty(entries[sid], 'summaryEvent', {
    enumerable: true, get() { throw new Error('delivery read cloned frozen summary payload') },
  })

  expect(h.ctx.journalDelivery('current')).toBe('pending')
  expect(h.ctx.journalDelivery('other')).toBe('delivered')
  expect(h.ctx.journalDelivery('missing')).toBeNull()
  expect(h.ctx.journalDelivery('')).toBeNull()
})

describe('watch summary page lifecycle', () => {
  it('refreshes delivery immediately on show and keeps the one-second clock timer', () => {
    let delivery = 'pending', intervalCallback = null
    const setInterval = vi.fn((fn, ms) => { intervalCallback = fn; return 12 })
    const clearInterval = vi.fn()
    const ctx = {
      bindRuntime() {}, storage: { getSync: () => ({ sid: 'current', workout: 'Workout', totalMinutes: 12, sets: 1 }) },
      router: { replace: vi.fn() }, startServer: vi.fn(() => () => {}), pendingCount: vi.fn(() => 0),
      isConnected: vi.fn(() => true), journalDelivery: vi.fn(() => delivery),
      startSession() {}, applySync() {}, setInterval, clearInterval,
      summaryDurationLabel, summaryMinutesOf, summaryNameLabel, summarySetsLabel,
      summaryVolumeOf, summaryHeartOf, summaryCaloriesOf, summarySyncLabel,
    }
    const script = stripImports(watchSource('Summary/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1])
      .replace('export default', 'globalThis.page =')
    runInNewContext(script, ctx)
    Object.assign(ctx.page, ctx.page.data)

    ctx.page.onShow()
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 1000)
    expect(ctx.journalDelivery).toHaveBeenCalledTimes(1)
    expect(ctx.page.syncLabel).toBe('已本地保存 · 待手机确认')

    delivery = 'delivered'
    intervalCallback()
    expect(ctx.page.clockLabel).toMatch(/^\d{2}:\d{2}$/)
    expect(ctx.journalDelivery).toHaveBeenCalledTimes(2)
    expect(ctx.page.syncLabel).toBe('已同步到手机')

    ctx.page.onHide()
    expect(clearInterval).toHaveBeenCalledWith(12)
  })
})
