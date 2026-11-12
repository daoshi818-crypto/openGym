import { getWatchLogs, getWatchDiagnostics, requestWatchDiagnostics, requestWatchLog } from './watch-link.js'
import { phoneWatchLog } from './watch-diagnostic-log.js'

export async function collectWatchDiagnosticReport() {
  const exportedAt = new Date().toISOString()
  const [transport, log] = await Promise.all([
    requestWatchDiagnostics().catch(() => false),
    requestWatchLog().catch(() => ({ status: 'failed', events: [] })),
  ])
  const [native, diagnostics] = await Promise.all([
    getWatchLogs().catch(() => ({ logs: '', lastError: 'unavailable' })),
    getWatchDiagnostics().catch(() => null),
  ])
  return { format: 'opengym-watch-diagnostics', formatVersion: 1, exportedAt,
    phoneVersion: typeof __APP_VERSION__ === 'undefined' ? 'unknown' : __APP_VERSION__,
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    limitations: ['App metadata only; not BlueOS system crash dumps.', 'Batched persistence can lose the final second or more if storage is stalled or fails before an abrupt exit.',
      'Cached watch log is explicitly dated and is not a live device response.'],
    watchProbeReceived: transport, watchLog: log,
    cachedWatchLog: log.status === 'received' ? null : phoneWatchLog.cachedWatch(),
    phoneEvents: phoneWatchLog.snapshot(), nativeSdk: native, diagnostics }
}
