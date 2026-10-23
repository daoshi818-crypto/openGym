// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// A stand-in for what @capacitor/core's registerPlugin() really returns: a Proxy that turns ANY
// property — `then` included — into a method wrapper whose native call fails asynchronously
// without ever invoking the callbacks it was handed. Resolving a promise with that object makes
// the promise wait for `then` to call back, which it never does (issues #42 / #58).
const calls = []
const backing = new Map()
const impl = {
  get: async k => (backing.has(k) ? backing.get(k) : null),
  set: async (k, v) => { backing.set(k, v) },
  remove: async k => backing.delete(k)
}
const SecureStorage = new Proxy({}, {
  get(_, prop) {
    if (prop === '$$typeof') return undefined
    if (prop === 'toJSON') return () => ({})
    return (...args) => {
      calls.push(String(prop))
      if (impl[prop]) return impl[prop](...args)
      return Promise.reject(new Error(`"SecureStorage.${String(prop)}()" is not implemented on android`))
    }
  }
})
const platform = vi.hoisted(() => ({ native: true }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => platform.native } }))
vi.mock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage }))

const device = { data: { mode: 'byok', provider: 'openai', baseUrl: null } }
vi.mock('./coach-device.js', () => ({ loadCoachDevice: async () => device.data, saveCoachDevice: async patch => { Object.assign(device.data, patch); return device.data } }))
const secrets = await import('./coach-secrets.js')

const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`hung for ${ms} ms`)), ms))])

describe('coach-secrets against a Capacitor-style plugin proxy', () => {
  beforeEach(() => { calls.length = 0; backing.clear(); device.data = { mode: 'byok', provider: 'openai', baseUrl: null } })

  it('a round trip settles instead of waiting on the proxy\'s never-answering then()', async () => {
    await within(secrets.setApiKey('sk-live-1'), 1000)
    expect(await within(secrets.getApiKey(), 1000)).toBe('sk-live-1')
    await within(secrets.clearApiKey(), 1000)
    expect(await within(secrets.getApiKey(), 1000)).toBe(null)
    expect(calls).not.toContain('then')
  })

  it('goes through the platform store, not the in-memory fallback', async () => {
    await within(secrets.setApiKey('sk-live-2'), 1000)
    expect([...backing.keys()]).toEqual(['coach.apiKey'])
    expect(calls).toEqual(['set'])
  })
})

describe('scoped Coach credentials', () => {
  it('keeps keys isolated by provider and normalized endpoint', async () => {
    await secrets.setApiKey('one', { provider: 'compatible', baseUrl: 'https://host.test/a' })
    await secrets.setApiKey('two', { provider: 'compatible', baseUrl: 'https://host.test/b' })
    expect(await secrets.getApiKey({ provider: 'compatible', baseUrl: 'https://host.test/a/' })).toBe('one')
    expect(await secrets.getApiKey({ provider: 'compatible', baseUrl: 'https://host.test/b' })).toBe('two')
    expect(await secrets.getApiKey({ provider: 'anthropic' })).toBeNull()
  })
  it('migrates a legacy key only into the currently saved provider scope', async () => {
    await secrets.setApiKey('legacy')
    expect(await secrets.getApiKey({ provider: 'anthropic' })).toBeNull()
    expect(await secrets.getApiKey({ provider: 'openai' })).toBe('legacy')
    expect(backing.has('coach.apiKey')).toBe(false)
  })
  it('surfaces native write failure, and disables credentials even if removal fails', async () => {
    const originalSet = impl.set, originalRemove = impl.remove
    try {
      impl.set = async () => { throw new Error('keystore locked') }
      await expect(secrets.setApiKey('secret', { provider: 'openai' })).rejects.toThrow('keystore locked')
      impl.remove = async () => { throw new Error('remove failed') }
      await expect(secrets.clearApiKey({ provider: 'openai' })).rejects.toThrow('remove failed')
      expect(device.data.credentialDisabled).toBe(true)
      expect(await secrets.getApiKey({ provider: 'openai' })).toBeNull()
    } finally { impl.set = originalSet; impl.remove = originalRemove }
  })
})

it('web credentials remain in process memory and never call the storage plugin', async () => {
  platform.native = false; calls.length = 0; device.data = { mode: 'byok' }
  try {
    const scope = { provider: 'compatible', baseUrl: 'https://web-memory.test' }
    await secrets.setApiKey('memory-only', scope)
    expect(await secrets.getApiKey(scope)).toBe('memory-only')
    await secrets.clearApiKey(scope)
    expect(await secrets.getApiKey(scope)).toBeNull()
    expect(calls).toEqual([])
  } finally { platform.native = true }
})
