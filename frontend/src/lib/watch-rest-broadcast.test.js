// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { useUI } from '../store/useUI.js'
import { broadcastPhoneRest } from './watch-rest-broadcast.js'
afterEach(() => { useUI.getState().stopRest(); vi.useRealTimers() })
function broadcast() {
  const { timer, restStopSource } = useUI.getState()
  const update = vi.fn(), send = vi.fn()
  broadcastPhoneRest({ enabled: true, active: { start: 1, watchSid: 's' }, timer, stopSource: restStopSource, update, send })
  return { update, send }
}
it('does not turn a watch rest skip into a new phone edit after the timer becomes null', () => {
  vi.useFakeTimers()
  useUI.getState().followWatchRest({ leftSec: 90, totalSec: 90, seq: 10 })
  expect(broadcast().send).not.toHaveBeenCalled()
  useUI.getState().followWatchRest({ leftSec: 0, totalSec: 0, endsAt: 0, seq: 11 })
  expect(useUI.getState().timer).toBeNull()
  const calls = broadcast()
  expect(calls.update).not.toHaveBeenCalled()
  expect(calls.send).not.toHaveBeenCalled()
})
it('still broadcasts a real phone skip, pause, adjustment or new rest after following the watch', () => {
  vi.useFakeTimers()
  for (const act of [() => useUI.getState().stopRest(), () => useUI.getState().pauseRest(), () => useUI.getState().addRest(15), () => useUI.getState().startRest(60)]) {
    useUI.getState().followWatchRest({ leftSec: 90, totalSec: 90, seq: 20 })
    act()
    expect(broadcast().send).toHaveBeenCalledOnce()
  }
})
