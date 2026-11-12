import { afterEach, expect, it, vi } from 'vitest'
import { createSetDotPicker } from '../../../watch-app/src/lib/workout-interaction.js'
import { loadWatchModule, watchSdkTimers } from './watch-test-harness.js'

afterEach(() => vi.useRealTimers())
const dot = setIdx => ({ sid: 's', entryInstanceId: 'ex', setId: 'row' + setIdx, exIdx: 0, setIdx, baseCommitRev: 1 })

it('finishes the selected dot through the BlueOS callback-ID timer bridge', async () => {
  vi.useFakeTimers()
  const timers = watchSdkTimers(), ctx = { Date, ...timers }
  loadWatchModule('workout-interaction', ctx, ['createSetDotPicker'])
  const apply = vi.fn(() => true), picker = ctx.createSetDotPicker(apply)
  const result = picker.request(dot(2))
  await vi.advanceTimersByTimeAsync(150)
  expect(apply).toHaveBeenCalledExactlyOnceWith(dot(2))
  expect(timers.rejected).toEqual([])
  expect(picker.pending()).toBe(false)
  expect(await result).toBe(true)
})

it('bounds a prolonged burst to one timer, one promise and the final primitive target', async () => {
  vi.useFakeTimers()
  const apply = vi.fn(() => true), picker = createSetDotPicker(apply), first = picker.request(dot(1))
  let last
  for (let i = 0; i < 1000; i++) {
    last = picker.request({ ...dot(i % 5), nativeEvent: {} })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
  }
  expect(last).toBe(first); expect(apply).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(120)
  expect(await last).toBe(true); expect(apply).toHaveBeenCalledExactlyOnceWith(dot(4))
  expect(picker.pending()).toBe(false); expect(vi.getTimerCount()).toBe(0)
})

it('copies input rather than retaining the native repeat item', async () => {
  vi.useFakeTimers()
  const apply = vi.fn(() => true), picker = createSetDotPicker(apply), item = dot(2)
  const done = picker.request(item)
  item.setId = 'mutated'; item.baseCommitRev = 99
  await vi.advanceTimersByTimeAsync(120); await done
  expect(apply).toHaveBeenCalledExactlyOnceWith(dot(2))
})

it('allows a new batch after cancellation during an accepted write without overlapping it', async () => {
  vi.useFakeTimers()
  let finish
  const apply = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockReturnValue(true)
  const picker = createSetDotPicker(apply), old = picker.request(dot(1))
  await vi.advanceTimersByTimeAsync(120)
  picker.request(dot(2)); picker.cancel(); expect(await old).toBe(false)
  const next = picker.request(dot(4))
  await vi.advanceTimersByTimeAsync(120); expect(apply).toHaveBeenCalledTimes(1)
  finish(true); await vi.advanceTimersByTimeAsync(1)
  expect(await next).toBe(true)
  expect(apply.mock.calls.map(([target]) => target.setIdx)).toEqual([1, 4])
  expect(picker.pending()).toBe(false); expect(vi.getTimerCount()).toBe(0)
})

it('settles failed input and permits an explicit retry', async () => {
  vi.useFakeTimers()
  const apply = vi.fn().mockRejectedValueOnce(new Error('disk')).mockReturnValue(true), picker = createSetDotPicker(apply)
  const failed = picker.request(dot(1)); await vi.advanceTimersByTimeAsync(120)
  expect(await failed).toBe(false); expect(picker.pending()).toBe(false)
  const retry = picker.request(dot(1)); await vi.advanceTimersByTimeAsync(120)
  expect(await retry).toBe(true); expect(apply).toHaveBeenCalledTimes(2)
})
