const KEY = 'opengym.watch.diagnostics.v1'
const WATCH_KEY = 'opengym.watch.last-log.v1'
const FIELDS = ['t', 'sid', 'eventId', 'entryInstanceId', 'setId', 'commitRev', 'baseCommitRev', 'status', 'phase', 'pending', 'code', 'ex', 'set', 'ok', 'bytes']

export function createWatchDiagnosticLog(storage = () => globalThis.localStorage) {
  let events = null, timer = null
  const read = key => { try { return JSON.parse(storage()?.getItem(key) || 'null') } catch { return null } }
  const write = (key, value) => { try { storage()?.setItem(key, JSON.stringify(value)) } catch { /* Optional log only. */ } }
  const clean = data => Object.fromEntries(FIELDS.filter(k => ['string', 'number', 'boolean'].includes(typeof data[k]))
    .map(k => [k, typeof data[k] === 'string' ? data[k].slice(0, 80) : data[k]]))
  function load() {
    if (!events) {
      const saved = read(KEY)
      events = (Array.isArray(saved) ? saved : []).filter(e => e && typeof e === 'object').slice(-160)
        .map(e => ({ at: e.at, stage: String(e.stage).slice(0, 40), ...clean(e) }))
    }
    return events
  }
  function flush() { if (timer != null) clearTimeout(timer); timer = null; write(KEY, load()) }
  return {
    record(stage, data = {}) {
      try {
        load().push({ at: Date.now(), stage: String(stage).slice(0, 40), ...clean(data) })
        if (events.length > 160) events.splice(0, events.length - 160)
        if (timer == null) timer = setTimeout(flush, 500)
      } catch { /* Logging never gates training. */ }
    },
    snapshot() { flush(); return load().map(e => ({ ...e })) },
    cacheWatch(log) { write(WATCH_KEY, log) },
    cachedWatch() { return read(WATCH_KEY) },
    flush,
  }
}
export const phoneWatchLog = createWatchDiagnosticLog()
