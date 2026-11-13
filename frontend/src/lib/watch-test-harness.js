// Shared loader for the shipped watch modules in tests: the real source runs with only the
// device APIs replaced, and every import a module needs is loaded into the same context
// (so the close journal and the event clock behave exactly as they do on the watch).
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { persistentReceiver } from '../../../watch-app/src/lib/persistent-transfer.js'
import { commitPageAction } from '../../../watch-app/src/lib/local-action.js'
import { rotationStep, valueStep } from '../../../watch-app/src/lib/value-step.js'
import { captureRow, rowTarget, setDotWindow, createSetDotPicker } from '../../../watch-app/src/lib/workout-interaction.js'

// Real page imports, not stubs: keep VM tests in sync with the shipped page modules.
export const watchInteractionDeps = { replayPendingEvents: () => {}, commitPageAction, rotationStep, valueStep, captureRow, rowTarget, setDotWindow, createSetDotPicker }

export const watchSource = path => readFileSync(new URL('../../../watch-app/src/' + path, import.meta.url), 'utf8')
export const stripImports = code => code
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?$/gm, '')
  .replace(/^export const /gm, 'const ')
  .replace(/^export async function /gm, 'async function ')
  .replace(/^export function /gm, 'function ')

export function loadWatchModule(name, ctx, names) {
  if (['rpc', 'session'].includes(name) && !ctx.compactStartEvent) {
    if (!ctx.wireBytes) loadWatchModule('sync-wire', ctx, ['wireHash', 'wireBytes', 'acceptWireChunk', 'expandWireDelta'])
    loadWatchModule('event-wire', ctx, ['compactStartEvent', 'createEventWire', 'nextEventFrame', 'EVENT_FRAME_BYTES'])
  }
  if (name === 'rpc' && !ctx.recordDiagnostic) loadWatchModule('diagnostic-log', ctx, ['recordDiagnostic', 'flushDiagnosticLog', 'diagnosticLog', 'diagnosticLogPage'])
  if (name === 'diagnostic-log' && !ctx.appTimeout) loadWatchModule('app-timers', ctx, ['appTimeout', 'cancelAppTimeout', 'appInterval', 'cancelAppInterval'])
  if (name === 'diagnostic-log' && !ctx.wireBytes) loadWatchModule('sync-wire', ctx, ['wireHash', 'wireBytes', 'acceptWireChunk', 'expandWireDelta'])
  if (['rpc', 'persistence'].includes(name) && !ctx.appTimeout) loadWatchModule('app-timers', ctx, ['appTimeout', 'cancelAppTimeout', 'appInterval', 'cancelAppInterval'])
  if (name === 'rpc') ctx.persistentReceiver = persistentReceiver
  if (name === 'rpc' && !ctx.acceptWireChunk) loadWatchModule('sync-wire', ctx, ['wireHash', 'wireBytes', 'acceptWireChunk', 'expandWireDelta'])
  if (['rpc', 'session'].includes(name) && !ctx.selectReadyEvent) loadWatchModule('event-dependencies', ctx, ['dependenciesFor', 'selectReadyEvent', 'dependencyDecision'])
  if (['rpc', 'session', 'close-journal'].includes(name) && !ctx.writeStoredAtomic && ctx.storage) loadWatchModule('persistence', ctx, ['writeStoredAtomic'])
  if (name === 'close-journal' && !ctx.wireBytes) loadWatchModule('sync-wire', ctx, ['wireBytes'])
  if (name === 'close-journal') names = [...new Set([...names, 'pendingCloseEvents', 'markEntry'])]
  if (name === 'rpc' && !ctx.pendingCloseEvents) ctx.pendingCloseEvents = () => [] // Legacy isolated transport fixtures.
  if (name === 'session' && !ctx.wireHash) loadWatchModule('sync-wire', ctx, ['wireHash', 'expandWireDelta'])
  if (name === 'session') names = [...new Set([...names, 'readSessionHr', 'commitSessionAction', 'stageSessionEvent', 'commitLocalClose', 'commitWireSnapshot', 'commitSessionStart', 'recoverLocalClose', 'reconcileCommittedSnapshot'])]
  const body = stripImports(watchSource('lib/' + name + '.js'))
  // Each module gets its own function scope, like a real ES module: the flattened global
  // would otherwise let one module's top-level `save`/`loadState` overwrite another's.
  const wrapper = '(function(){\n' + body + '\nreturn { ' + names.join(', ') + ' }\n}).call(globalThis)'
  const exports = runInNewContext(wrapper, ctx)
  Object.assign(ctx, exports)
  return exports
}

/** A synchronous fake disk plus the shipped persistence layer on top of it. */
export function watchPersistence(disk = new Map(), shared = {}) {
  const storage = {
    getSync: ({ key }) => disk.has(key) ? JSON.parse(JSON.stringify(disk.get(key))) : null,
    set: ({ key, value, success }) => { disk.set(key, JSON.parse(JSON.stringify(value))); if (success) success() },
  }
  const ctx = { storage, runtime: () => shared, Date, setTimeout, clearTimeout, setInterval, clearInterval }
  loadWatchModule('persistence', ctx, ['readStored', 'writeStored', 'writeStoredConfirmed', 'retryStorage', 'storageStatus', 'writeStoredAtomic'])
  return { disk, shared, storage, ctx }
}

// Model the SDK's per-instance timers: callbacks from a destroyed Page are discarded.
// The App remains alive. This is a lifecycle simulation, not a device crash test.
export function watchTimerOwner() {
  let alive = true
  return {
    setTimeout: (fn, ms) => setTimeout(() => { if (alive) fn() }, ms),
    clearTimeout: id => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(() => { if (alive) fn() }, ms),
    clearInterval: id => clearInterval(id),
    destroy: () => { alive = false },
  }
}

// BlueOS Studio framework.js (COMMITID 7af9d62), Instance.setTimer -> `$`:
// only the [object Function] case registers a callback ID. AsyncFunction falls
// through JSON.stringify and cannot be invoked by the native timer bridge.
// Node timers accept both, so ordinary fake timers cannot expose this failure.
export function watchSdkTimers() {
  const rejected = []
  return {
    rejected,
    setTimeout(fn, ms) {
      const type = Object.prototype.toString.call(fn)
      const callback = type === '[object Function]' ? fn : null
      if (!callback) rejected.push(type)
      return setTimeout(() => { callback?.() }, ms)
    },
    clearTimeout: id => clearTimeout(id),
  }
}
export function startWatchApp(shared) {
  const timers = watchTimerOwner(), definition = { openGymRuntime: shared }
  const ctx = { ...timers, console: { log() {} }, runtime: () => shared,
    bindRuntime: owner => { if (owner !== definition) throw new Error('wrong runtime owner') } }
  const source = watchSource('app.ux').match(/<script>([\s\S]*?)<\/script>/)[1]
  runInNewContext(stripImports(source).replace('export default', 'this.app ='), ctx)
  ctx.app.onCreate.call({ $def: definition })
  return timers
}
