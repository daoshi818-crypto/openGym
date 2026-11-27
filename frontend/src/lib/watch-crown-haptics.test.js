// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { loadWatchModule } from './watch-test-harness.js'

afterEach(() => vi.useRealTimers())

it('requests a short, low-priority crown pulse and leaves a pause between detents', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000000)
  const vibrator = { start: vi.fn(), vibrate: vi.fn() }
  const ctx = { Date, vibrator, console }
  loadWatchModule('sensors', ctx, ['crownTick'])

  ctx.crownTick()
  expect(vibrator.start).toHaveBeenCalledExactlyOnceWith({
    priority: 8, duration: 24, interval: 140, count: 1,
    fail: expect.any(Function),
  })
  expect(vibrator.vibrate).not.toHaveBeenCalled()

  vi.advanceTimersByTime(139)
  ctx.crownTick()
  expect(vibrator.start).toHaveBeenCalledTimes(1)

  vi.advanceTimersByTime(1)
  ctx.crownTick()
  expect(vibrator.start).toHaveBeenCalledTimes(2)
})
