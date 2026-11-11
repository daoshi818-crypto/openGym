// Fixed-fixture business JSON measurements, not BLE/DeviceRpc radio traffic.
// Run from the repository root: node scripts/watch/measure-sync.mjs
import { watchPlanOf, watchSnapshotOf } from '../../frontend/src/lib/watch-workout.js'
import { ensureWatchIdentity } from '../../frontend/src/lib/watch-identity.js'
import { canonicalWire, wireHash, compactWire } from '../../watch-app/src/lib/sync-wire.js'
import { persistentSender, persistentReceiver } from '../../watch-app/src/lib/persistent-transfer.js'
import { watchPersistence, loadWatchModule } from '../../frontend/src/lib/watch-test-harness.js'
import { createDurableWatchLifecycle } from '../../frontend/src/lib/watch-commit.js'
import { createCommandStateCache } from '../../frontend/src/lib/watch-command-state.js'
import { stampWatchRevision } from '../../frontend/src/lib/watch-revision.js'
const now = 1794412800000
Date.now = () => now
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const copy = value => JSON.parse(JSON.stringify(value))
function fixture(counts) {
  const S = { unit: 'kg', restSec: 90, effort: 'none', workouts: [], bodyweight: [{ w: 75 }],
    active: { start: now - 60000, watchSid: 'phone:1794412740000', name: '同步测量训练', syncRev: 1, cur: 0,
      entries: counts.map((count, i) => ({ name: i === 0 ? '杠铃卧推' : '哑铃划船', entryInstanceId: `entry:measure:${String(i).padStart(2, '0')}`,
        sets: Array.from({ length: count }, (_, j) => ({ setId: `set:measure:${String(i).padStart(2, '0')}:${String(j).padStart(2, '0')}`, w: 60, r: 8, done: false })) })) } }
  ensureWatchIdentity(S.active, S.active.watchSid)
  return S
}
function snapshot(S, timer = null, at = now) {
  const value = { ...watchSnapshotOf(S, timer, at), t: 'sync', protocolVersion: 3 }
  return { ...value, wireHash: wireHash(value) }
}
function disk() { const m = new Map(); return { read: async k => copy(m.get(k) ?? null), write: async (k, v) => { m.set(k, copy(v)); return true } } }
async function transfer(message) {
  const tx = persistentSender(disk(), () => {}, () => now), rx = persistentReceiver(disk(), async () => ({ ok: true }), () => now)
  await tx.enqueue(message)
  let toWatch = 0, toPhone = 0, downMessages = 0, upMessages = 0
  for (let i = 0; i < 300; i++) {
    const m = await tx.next(); if (!m) return { toWatch, toPhone, total: toWatch + toPhone, downMessages, upMessages }
    toWatch += bytes(m); downMessages++
    for (const ack of await rx.receive(m)) { toPhone += bytes(ack); upMessages++; await tx.receipt(ack) }
  }
  throw new Error('transfer did not drain')
}
function events(S, base) {
  const h = watchPersistence(), c = h.ctx
  loadWatchModule('event-id', c, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', c, ['prepareClose', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markDelivered', 'releaseCandidate', 'markPhase'])
  loadWatchModule('session', c, ['startSession', 'stageSessionEvent'])
  const state = c.startSession({ ...base, name: S.active.name })
  state.commitRev = base.commitRev
  const common = { sid: base.sid, installationId: 'watch-install:measure', seq: 1, eventId: 'watch-install:measure:1', ex: 0, set: 1, at: now }
  const weight = c.stageSessionEvent(state, { ...common, t: 'weight', weight: '62.5', editAt: now })
  state.pendingEdits = []
  const set = c.stageSessionEvent(state, { ...common, t: 'set', reps: '8', weight: '60', rest: {
    restId: String(now), startedAt: now, endsAt: now + 90000, leftSec: 90, totalSec: 90, paused: false, seq: now } })
  return { weight: copy(weight), set: copy(set) }
}
async function commandRoundTrip(source, base, event, inline) {
  const S = copy(source), states = createCommandStateCache(), replies = [], snapshots = []
  states.remember(base)
  let timer = null
  const command = inline ? { ...event, appliedHash: base.wireHash, appliedRev: base.commitRev } : event
  const receive = createDurableWatchLifecycle({ getState: () => S, getTimer: () => timer,
    update: (fn, ev) => { const before = copy(S); fn(S); stampWatchRevision(before, S, ev?.installationId || 'watch', ev?.eventId) },
    rest: ev => { timer = ev.leftSec ? { ...ev, source: 'watch' } : null },
    checkpoint: async () => {}, commandState: inline ? states.prepare : undefined,
    send: msg => replies.push(copy(msg)), sendAck() {}, sendEnded() {}, finish() {},
    sendSync: snap => snapshots.push(canonicalWire(snap)),
  })
  try { receive(command); await receive.idle() } finally { receive.dispose() }
  const committed = replies.find(m => m.t === 'committed')
  if (committed?.status !== 'applied' || inline && !committed.state) throw new Error('fixture command was not applied inline')
  let stateTransfer = null, appliedAck = null
  if (snapshots.length) stateTransfer = await transfer(compactWire(base, snapshots.at(-1)))
  if (committed.state) appliedAck = { t: 'sync_ack', sid: base.sid, wireHash: committed.state.wireHash, commitRev: committed.commitRev, status: 'applied' }
  const replyBytes = replies.reduce((sum, msg) => sum + bytes(msg), 0)
  const ackBytes = appliedAck ? bytes(appliedAck) : 0
  return { commandBytes: bytes(command), replyBytes, appliedAckBytes: ackBytes, stateTransfer,
    total: bytes(command) + replyBytes + ackBytes + (stateTransfer?.total || 0),
    messages: 1 + replies.length + (appliedAck ? 1 : 0) + (stateTransfer ? stateTransfer.downMessages + stateTransfer.upMessages : 0) }
}
const results = []
for (const counts of [[5, 2], Array(10).fill(5), Array(20).fill(5)]) {
  const S = fixture(counts), base = snapshot(S), ev = events(S, base)
  const commandBefore = await commandRoundTrip(S, base, ev.set, false), commandAfter = await commandRoundTrip(S, base, ev.set, true)
  const weightBefore = await commandRoundTrip(S, base, ev.weight, false), weightAfter = await commandRoundTrip(S, base, ev.weight, true)
  S.active.entries[0].sets[0].done = true; S.active.entries[0].sets[0].at = now
  S.active.syncRev++
  S.active.watchEvents = [ev.set.eventId]
  S.active.watchFocus = { ex: 0, set: 2, at: now }
  const timer = { sid: base.sid, restId: String(now), startedAt: now, endsAt: now + 90000, total: 90, seq: now }
  const next = snapshot(S, timer, now + 1), delta = compactWire(base, next)
  results.push({ exercises: counts.length, sets: counts.reduce((a, b) => a + b, 0), planBytes: bytes(watchPlanOf(fixture(counts))),
    bootstrapBytes: bytes(base), setEventBytes: bytes(ev.set), weightEventBytes: bytes(ev.weight),
    nextFullBytes: bytes(next), nextDeltaBytes: bytes(delta),
    fullTransfer: await transfer(next), deltaTransfer: await transfer(delta), commandBefore, commandAfter, weightBefore, weightAfter })
}
const xunjiWeightExample = { command: 'Change_Move_Data', payload: { moveidx: 2, setidx: 1, data: '80', type: 'weight' }, trainID: 123456 }
console.log(JSON.stringify({ scope: 'UTF-8 business JSON only; fixed fixture, no retries. No SDK framing/radio bytes. Competitor example only; KeepStrong total unknown.',
  xunjiWeightExampleBytes: bytes(xunjiWeightExample), results }, null, 2))
