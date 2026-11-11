// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { broadcastPhoneRest } from './watch-rest-broadcast.js'
beforeEach(() => {
  useStore.setState({ S: { ...structuredClone(DEF), active: { start: 1, watchSid: 's' } } })
  useUI.setState({ timer: null, restStop: null })
})
afterEach(() => { useUI.getState().stopRest(); vi.useRealTimers() })
function broadcast() {
  const { timer, restStopSource, restStop } = useUI.getState()
  const update = vi.fn(), send = vi.fn()
  broadcastPhoneRest({ enabled: true, active: { start: 1, watchSid: 's' }, timer, stopSource: restStopSource, stopIntent: restStop, update, send })
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

it('idle mount, repeated cleanup and new session do not invent a phone rest edit', () => {
  vi.useFakeTimers()
  expect(broadcast().send).not.toHaveBeenCalled()
  useUI.getState().stopRest()
  expect(broadcast().send).not.toHaveBeenCalled()
  useUI.getState().startRest(90)
  useUI.getState().stopRest()
  const intent = useUI.getState().restStop
  expect(broadcast().send).toHaveBeenCalledOnce()
  useUI.getState().stopRest()
  expect(useUI.getState().restStop).toEqual(intent)
  const send = vi.fn(), update = vi.fn()
  broadcastPhoneRest({ enabled: true, active: { start: 2, watchSid: 'new' }, timer: null, stopIntent: intent, send, update })
  expect(send).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})
it('does not rebroadcast a stop already covered by the phone snapshot', () => {
  const send = vi.fn(), update = vi.fn()
  broadcastPhoneRest({ enabled: true, active: { start: 1, watchSid: 's', restVersion: 22 }, timer: null,
    stopIntent: { source: 'phone', sid: 's', seq: 22 }, send, update })
  expect(send).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})
