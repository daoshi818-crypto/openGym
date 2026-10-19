import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  events: {},
  addListener: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
  getDeviceInfo: vi.fn(), isSupported: vi.fn(),
}))
vi.mock('./mobile.js', () => ({ MOBILE: true, isAndroid: async () => true }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }))

let link
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  native.events = {}
  native.addListener.mockImplementation((name, cb) => { native.events[name] = cb })
  native.connect.mockResolvedValue({ connected: false })
  native.disconnect.mockResolvedValue({})
  link = await import('./watch-link.js')
})

describe('watch connection state', () => {
  it('reads device fields from the SDK device envelope', async () => {
    native.getDeviceInfo.mockResolvedValue({
      ok: true, data: JSON.stringify({ device: { deviceName: 'WATCH', connected: true } }),
    })
    await link.connectWatch()
    const result = await link.getWatchDeviceInfo()
    expect(result.deviceName).toBe('WATCH')
    expect(link.watchDevice()).toMatchObject({ deviceName: 'WATCH', connected: true })
    expect(link.watchState()).toBe('connected')
  })

  it('clears cached connection on a native disconnect and explicit disconnect', async () => {
    await link.connectWatch()
    native.events.watchState({ state: 'connected', connected: true })
    native.events.watchState({ state: 'ready', connected: false })
    expect(link.watchDevice().connected).toBe(false)
    native.events.watchState({ state: 'connected', connected: true })
    await link.disconnectWatch()
    expect(link.watchState()).toBe('off')
    expect(link.watchDevice().connected).toBe(false)
  })

  it('clears an initialization error after a successful retry', async () => {
    native.connect.mockRejectedValueOnce(new Error('health service unavailable'))
    expect(await link.connectWatch()).toBe(false)
    expect(link.watchLastError()).toBe('health service unavailable')
    expect(await link.connectWatch()).toBe(true)
    expect(link.watchState()).toBe('ready')
    expect(link.watchLastError()).toBe('')
  })

  it('does not report a watch connected when only SDK initialization succeeded', async () => {
    await link.connectWatch()
    expect(link.watchState()).toBe('ready')
    expect(link.watchDevice()?.connected).not.toBe(true)
  })
})
