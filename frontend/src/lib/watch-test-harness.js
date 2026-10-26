// Shared loader for the shipped watch modules in tests: the real source runs with only the
// device APIs replaced, and every import a module needs is loaded into the same context
// (so the close journal and the event clock behave exactly as they do on the watch).
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

export const watchSource = path => readFileSync(new URL('../../../watch-app/src/' + path, import.meta.url), 'utf8')
export const stripImports = code => code
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?$/gm, '')
  .replace(/^export const /gm, 'const ')
  .replace(/^export async function /gm, 'async function ')
  .replace(/^export function /gm, 'function ')

export function loadWatchModule(name, ctx, names) {
  if (name === 'rpc' && !ctx.acceptWireChunk) loadWatchModule('sync-wire', ctx, ['wireHash', 'wireBytes', 'acceptWireChunk', 'expandWireDelta'])
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
  const ctx = { storage, runtime: () => shared, Date, setTimeout, clearTimeout }
  loadWatchModule('persistence', ctx, ['readStored', 'writeStored', 'writeStoredConfirmed', 'retryStorage', 'storageStatus'])
  return { disk, shared, storage, ctx }
}
