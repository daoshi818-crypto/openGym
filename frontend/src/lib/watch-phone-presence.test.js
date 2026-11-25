import { describe, expect, it, vi } from 'vitest'
import { createPhoneWatchPresence, nextPhoneSessionGeneration, stalePhoneActivationEvent } from './watch-phone-presence.js'

function rig({ foreground = true, ready = true, active = true } = {}) {
  let S = { active: active ? { start: 1000, watchSid: 'sid-a', syncRev: 4 } : null }
  const sendPresence = vi.fn(async () => true), sendSnapshot = vi.fn(async () => true), checkpoint = vi.fn(async () => {})
  const controller = createPhoneWatchPresence({
    getState: () => S,
    update: fn => { const next = structuredClone(S); fn(next); S = next },
    checkpoint, canSend: () => ready, isForeground: () => foreground,
    sendPresence, sendSnapshot: value => sendSnapshot(value),
  })
  return { controller, state: () => S, setState: next => { S = next }, sendPresence, sendSnapshot, checkpoint }
}

describe('phone watch presence lease', () => {
  it('advances and persists activation generation before snapshot and presence reassertion', async () => {
    const a = rig()
    expect(await a.controller.activate()).toBe(true)
    expect(a.state().active).toMatchObject({ watchPhoneSession: true, watchSessionGeneration: 1 })
    expect(a.checkpoint).toHaveBeenCalledOnce()
    expect(a.sendSnapshot).toHaveBeenCalledOnce()
    expect(a.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(a.sendSnapshot.mock.invocationCallOrder[0])
    expect(a.sendSnapshot.mock.invocationCallOrder[0]).toBeLessThan(a.sendPresence.mock.invocationCallOrder[0])
    expect(a.sendPresence).toHaveBeenCalledWith({ t: 'session_presence', sid: 'sid-a', sessionGeneration: 1, active: true, commitRev: 4, sentAt: expect.any(Number) })
  })

  it('increases generation on each foreground activation and reuses it for heartbeat/reassertion', async () => {
    const a = rig()
    await a.controller.activate()
    await a.controller.activate()
    expect(a.state().active.watchSessionGeneration).toBe(2)
    a.sendPresence.mockClear(); a.sendSnapshot.mockClear()
    await a.controller.heartbeat()
    await a.controller.reassert()
    expect(a.sendPresence.mock.calls[0][0].sessionGeneration).toBe(2)
    expect(a.sendSnapshot).toHaveBeenCalledOnce()
  })

  it('does not assert while inactive or disconnected, and revokes the previous lease when suspended', async () => {
    const a = rig()
    await a.controller.activate()
    a.sendPresence.mockClear()
    await a.controller.deactivate()
    expect(a.sendPresence).toHaveBeenCalledWith(expect.objectContaining({ sid: 'sid-a', active: false }))
    const b = rig({ ready: false })
    expect(await b.controller.activate()).toBe(false)
    expect(b.sendPresence).not.toHaveBeenCalled()
  })

  it('does not assert an old foreground lease when a snapshot completes after suspension', async () => {
    const a = rig()
    let resolveSnapshot
    a.sendSnapshot.mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))
    const activating = a.controller.activate()
    await vi.waitFor(() => expect(a.sendSnapshot).toHaveBeenCalledOnce())
    await a.controller.deactivate()
    resolveSnapshot(true)
    expect(await activating).toBe(false)
    expect(a.sendPresence).not.toHaveBeenCalled()
  })

  it('does not publish a session when there is no active phone-led workout', async () => {
    const a = rig({ active: false })
    expect(await a.controller.activate()).toBe(false)
    expect(a.sendSnapshot).not.toHaveBeenCalled()
    expect(a.sendPresence).not.toHaveBeenCalled()
  })

  it('advances numeric generations monotonically and resets malformed values safely', () => {
    expect(nextPhoneSessionGeneration(8)).toBe(9)
    expect(nextPhoneSessionGeneration('sid-a')).toBe(1)
    expect(stalePhoneActivationEvent({ active: { start: 1, watchPhoneSession: true, watchSessionGeneration: 4 } }, { sid: '1', protocolVersion: 3, phoneSessionGeneration: 4 }, true, false)).toBe(true)
  })
})
