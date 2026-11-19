import { expect, it } from 'vitest'
import { createWatchDevices } from './watch-devices.js'

it('remembers the concrete selection on this phone and never follows a different hello', () => {
  const values = new Map(), storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) }
  const registry = createWatchDevices(storage)
  registry.discover('watch-one', { deviceName: 'WATCH GT' }, 1)
  expect(registry.read().selectedId).toBe('')
  expect(registry.select('watch-one')).toBe(true)
  registry.discover('watch-two', { deviceName: 'WATCH 5' }, 2)
  expect(registry.accepts('watch-two')).toBe(false)
  expect(createWatchDevices(storage).read().selectedId).toBe('watch-one')
  expect(registry.select('invented')).toBe(false)
})

it('rejects malformed identity and tolerates unavailable preference storage', () => {
  const registry = createWatchDevices({ getItem() { throw Error() }, setItem() { throw Error() } })
  expect(registry.discover('../other')).toBe(false)
  registry.discover('watch-one'); expect(registry.select('watch-one')).toBe(true)
  expect(registry.accepts('')).toBe(false)
})
