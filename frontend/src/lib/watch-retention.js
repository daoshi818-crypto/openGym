const DAY = 86400000
export const WATCH_RECOVERY_DAYS = 30
// Pending user decisions and the active session are protected from automatic pruning.
export function pruneWatchClosed(S, now = Date.now()) {
  const protectedSids = new Set(Object.values(S.watchPendingSaves || {}).map(e => e.sid))
  if (S.active) protectedSids.add(String(S.active.watchSid || S.active.start))
  const rows = Object.entries(S.watchClosed || {}).sort((a,b) => (b[1].closedAt || 0) - (a[1].closedAt || 0))
  const kept = {}
  let ordinary = 0
  for (const [sid, close] of rows) {
    if (protectedSids.has(sid)) { kept[sid] = close; continue }
    const expired = Number.isFinite(close.closedAt) && now - close.closedAt > WATCH_RECOVERY_DAYS * DAY
    if (expired || ordinary >= 500) continue
    ordinary++
    const { entries, ...compact } = close
    kept[sid] = close.acknowledgedAt ? compact : close
  }
  S.watchClosed = kept
}
