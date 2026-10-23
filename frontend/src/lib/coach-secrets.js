// Where the phone keeps the user's own API key: the platform's secure storage — the Keychain on
// iOS, the Keystore-backed EncryptedSharedPreferences on Android — and nowhere else. Never in
// S (which syncs and exports), never in localStorage (which the WebView evicts and any page on
// the same origin can read), never in the coach device file next to it.
//
// The plugin is imported lazily and every call is wrapped: on a plain web dev run it stores
// to localStorage by its own admission, and in a test there is no platform at all. In both
// cases the fallback is a process-local map that forgets on reload, which is the honest
// behaviour for a place that cannot keep a secret.
import { Capacitor } from '@capacitor/core'
import { credentialScope } from './coach-credential-scope.js'
import { loadCoachDevice, saveCoachDevice } from './coach-device.js'
const KEY = 'coach.apiKey'
const memory = new Map()

// The loaded plugin travels inside a plain object, never as a promise's own value (no `await`
// or `.then` may ever hand the proxy back bare — the wrapper below is the whole point). Capacitor's
// registerPlugin() hands out a Proxy that answers EVERY property name with a native-method
// wrapper — `then` included — so a promise that resolves to the proxy itself takes it for a
// thenable, calls SecureStorage.then() on the native side ("not implemented on android"), and
// never settles. That one await hung the whole feature on the phone: "Save and use the Coach"
// greyed out forever, the key "not saved", the Coach "thinking" without end (issues #42, #58).
let pluginPromise = null
function plugin() {
  if (!pluginPromise) {
    pluginPromise = import('@aparajita/capacitor-secure-storage')
      .then(m => ({ store: m && m.SecureStorage && typeof m.SecureStorage.get === 'function' ? m.SecureStorage : null }))
      .catch(() => ({ store: null }))
  }
  return pluginPromise
}

// A native call that never answers must not hang the setup screen behind a greyed-out button
// (issue #42: "Save and use the Coach" stayed disabled forever on one Android 16 phone). After
// this long the platform store is treated as unavailable and the process-local map takes over.
const NATIVE_TIMEOUT_MS = 4000
export const withTimeout = (promise, ms = NATIVE_TIMEOUT_MS) => new Promise((resolve, reject) => {
  const tm = setTimeout(() => reject(new Error('secure storage timed out')), ms)
  promise.then(v => { clearTimeout(tm); resolve(v) }, e => { clearTimeout(tm); reject(e) })
})

// Any small secret under a key of its own, with the same fallbacks: lib/cf-access.js keeps the
// Cloudflare Access service token here, beside the Coach's API key.
export async function secureGet(key) {
  const { store: p } = await plugin()
  if (p) {
    try { const v = await withTimeout(p.get(key)); return typeof v === 'string' && v ? v : null } catch { /* fall through */ }
  }
  return memory.get(key) || null
}
export async function secureSet(key, value) {
  const v = String(value || '').trim()
  if (!v) return secureRemove(key)
  const { store: p } = await plugin()
  if (p) {
    try { await withTimeout(p.set(key, v)); memory.delete(key); return } catch { /* fall through */ }
  }
  memory.set(key, v)
}
export async function secureRemove(key) {
  const { store: p } = await plugin()
  if (p) { try { await withTimeout(p.remove(key)) } catch { /* nothing to clear */ } }
  memory.delete(key)
}

let operations = Promise.resolve()
function serialized(operation) {
  const result = operations.then(operation)
  operations = result.catch(() => {})
  return result
}
async function strictCall(method, key, value) {
  const { store } = Capacitor.isNativePlatform() ? await plugin() : { store: null }
  if (!store) {
    if (Capacitor.isNativePlatform()) throw new Error('Secure storage is unavailable')
    if (method === 'get') return memory.get(key) || null
    if (method === 'set') memory.set(key, value); else memory.delete(key)
    return null
  }
  // Timeout informs the UI but does not release serialization: native writes can
  // finish late, and a remove must not overtake the write it is meant to remove.
  return store[method](key, ...(method === 'set' ? [value] : []))
}
export function getApiKey(settings) {
  return withTimeout(serialized(async () => {
    if (!settings) return strictCall('get', KEY)
    const scope = credentialScope(settings), d = await loadCoachDevice()
    if (!scope || d.credentialDisabled) return null
    const value = await strictCall('get', KEY + '.' + scope)
    if (value) return value
    if (!d.credentialScope && credentialScope(d) === scope) {
      const old = await strictCall('get', KEY)
      if (old) {
        await strictCall('set', KEY + '.' + scope, old)
        if (await strictCall('get', KEY + '.' + scope) !== old) throw new Error('Secure storage verification failed')
        await saveCoachDevice({ credentialScope: scope })
        await strictCall('remove', KEY)
        return old
      }
    }
    return null
  }))
}
export function setApiKey(value, settings) {
  return withTimeout(serialized(async () => {
    const scope = settings ? credentialScope(settings) : null
    if (settings && !scope) throw new Error('Invalid credential scope')
    const key = scope ? KEY + '.' + scope : KEY
    const v = String(value || '').trim()
    if (!v) throw new Error('Enter your API key')
    await strictCall('set', key, v)
    if (scope && await strictCall('get', key) !== v) throw new Error('Secure storage verification failed')
  }))
}
export async function clearApiKey(settings) {
  if (settings) await saveCoachDevice({ credentialDisabled: true })
  await withTimeout(serialized(async () => {
    const scope = settings ? credentialScope(settings) : null
    if (scope) await strictCall('remove', KEY + '.' + scope)
    await strictCall('remove', KEY)
  }))
}
