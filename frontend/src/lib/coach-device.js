// Mobile build only: how the Coach runs on this phone, and the little it keeps between runs.
//
// Deliberately NOT part of S. S is the training log — it syncs to a paired server, travels in
// the JSON export, and is what "back up your data" means. Which provider this phone talks to,
// the pseudonym it uses, today's run count and a proposal waiting to be looked at are device
// facts, so they live in their own file next to the remote-pairing one. The API key itself is
// not even here: see coach-secrets.js.
//
// This module is intentionally light. The setup screen imports it before the user has chosen
// anything, and the promise there is that nothing AI-shaped loads until they do.
import { readJsonFile, writeJsonFile } from './mobile.js'
import { fingerprint } from '../../../api/coach/core/debrief-selection.js'

const FILE = 'opengym-coach.json'

export const COACH_MODES = ['off', 'server', 'byok']

const DEFAULTS = { mode: 'off', provider: null, model: null, baseUrl: null, handle: null, daily: null, pending: null }

const validSaved = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.schemaVersion != null && value.schemaVersion !== 2) return false
  if (value.revision != null && (!Number.isSafeInteger(value.revision) || value.revision < 0)) return false
  if (value.mode != null && !COACH_MODES.includes(value.mode)) return false
  if (value.checksum) { const { checksum, ...body } = value; if (fingerprint(body) !== checksum) return false }
  return true
}
let cache = null
let loading = null
let writes = Promise.resolve()
let persistenceError = null
export async function loadCoachDevice() {
  if (cache) return cache
  if (!loading) loading = (async () => {
    const reads = await Promise.allSettled([FILE, FILE + '.a', FILE + '.b'].map(name => readJsonFile(name, { strict: true })))
    const valid = reads.filter(r => r.status === 'fulfilled' && validSaved(r.value)).map(r => r.value)
    const bad = reads.find(r => r.status === 'rejected' || r.value != null && !validSaved(r.value))
    if (!valid.length && bad) throw bad.reason || new Error('Coach settings file is invalid')
    const saved = valid.sort((a,b) => (b.revision || 0) - (a.revision || 0))[0] || null
    cache = { ...DEFAULTS, schemaVersion: 2, revision: 0, ...(saved || {}) }
    if (!COACH_MODES.includes(cache.mode)) cache.mode = 'off'
    return cache
  })().catch(e => { loading = null; persistenceError = e; throw e })
  return loading
}
export function saveCoachDevice(patch) {
  const operation = writes.then(async () => {
    const current = await loadCoachDevice()
    const delta = typeof patch === 'function' ? patch(current) : patch
    if (delta == null) return current
    const { checksum, ...body } = { ...current, ...delta, schemaVersion: 2, revision: (current.revision || 0) + 1 }
    const next = { ...body, checksum: fingerprint(body) }
    // Alternate slots: an interrupted write leaves the previous committed revision readable.
    await writeJsonFile(FILE + (next.revision % 2 ? '.a' : '.b'), next, { strict: true })
    cache = next
    persistenceError = null
    return next
  })
  writes = operation.catch(e => { persistenceError = e })
  return operation
}
export const coachPersistenceError = () => persistenceError
/** The part of it a UI may show: never the pending proposal, never the handle. */
export const coachDeviceSettings = d => d ? { mode: d.mode, provider: d.provider, model: d.model, baseUrl: d.baseUrl } : null

// Test seam.
export function _resetCoachDevice() { cache = null; loading = null; writes = Promise.resolve(); persistenceError = null }
