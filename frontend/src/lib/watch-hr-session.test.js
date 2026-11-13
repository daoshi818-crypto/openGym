// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { loadWatchModule, watchPersistence, watchTimerOwner, startWatchApp } from './watch-test-harness.js'
import { applyEdit, applyRest } from '../../../watch-app/src/lib/protocol.js'
import { wireHash } from '../../../watch-app/src/lib/sync-wire.js'

function harness() {
  vi.useFakeTimers()
  vi.setSystemTime(1000000)
  const h = watchPersistence(), samples = []
  const health = { DATA_TYPES: { HEART_RATE: 1 }, subscribeSample: vi.fn(o => samples.push(o)), unsubscribeSample: vi.fn() }
  const original = h.storage.set
  h.storage.set = vi.fn(original)
  const page = () => {
    const ctx = { ...h.ctx, health, vibrator: {}, console, applyEdit, applyRest }
    loadWatchModule('event-id', ctx, ['allocateEventIdentity'])
    loadWatchModule('close-journal', ctx, ['prepareClose', 'journalEntry'])
    loadWatchModule('session', ctx, ['startSession', 'save', 'loadState', 'readSessionHr', 'addHr', 'flushHr',
      'calories', 'buildSessionSummary', 'closeSession', 'endSession', 'applySync'])
    loadWatchModule('sensors', ctx, ['startSessionHr', 'stopSessionHr'])
    return ctx
  }
  const a = page(), b = page()
  const plan = { sid: 's', name: 'Bench', exercises: [{ sets: 1, weight: 20, reps: 10 }] }
  a.startSession(plan)
  const writes = () => h.storage.set.mock.calls.map(([item]) => item).filter(item => item.key === 'session_state')
  const sample = (bpm, index = samples.length - 1) => samples[index].callback({ value: bpm })
  return { ...h, a, b, health, samples, sample, plan, writes, page, original }
}
afterEach(() => vi.useRealTimers())

it('shares one subscription and every buffered sample across separate page bundles without writing every sample', () => {
  const h = harness(), { a, b } = h
  a.startSessionHr(); b.startSessionHr()
  expect(h.health.subscribeSample).toHaveBeenCalledTimes(1)
  h.sample(120)
  const written = h.writes().length
  vi.advanceTimersByTime(1000); h.sample(121)
  vi.advanceTimersByTime(1000); h.sample(119)
  expect(h.writes()).toHaveLength(written)
  expect(h.disk.get('session_state').hr.count).toBe(1)
  expect(b.readSessionHr('s')).toMatchObject({ count: 3, sum: 360, max: 121, last: 119, sampledDurationMs: 2000 })
  expect(b.loadState().hr.count).toBe(3)
  const detached = b.readSessionHr('s'); detached.count = 999
  expect(a.readSessionHr('s').count).toBe(3)
  expect(b.readSessionHr('other')).toBeNull()
})

it('persists at exactly ten seconds OR a ten bpm change from the last persisted sample', () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120)
  const written = h.writes().length
  vi.advanceTimersByTime(9999); h.sample(129)
  expect(h.writes()).toHaveLength(written)
  vi.advanceTimersByTime(1)
  expect(h.writes()).toHaveLength(written + 1)
  expect(h.disk.get('session_state').hr.count).toBe(2)
  h.sample(139)
  expect(h.writes()).toHaveLength(written + 2)
  h.sample(129)
  expect(h.writes()).toHaveLength(written + 3)
})

it('retains same-millisecond samples and merges buffered HR when an old page saves a row edit', () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120)
  const stale = h.a.loadState()
  h.sample(125); h.sample(121)
  stale.workout.rows[0][0].w = 35; h.b.save(stale)
  expect(h.disk.get('session_state').hr).toMatchObject({ count: 3, sum: 366, max: 125, last: 121 })
  expect(h.b.loadState().workout.rows[0][0].w).toBe(35)
})

it('ignores invalid readings without polluting runtime statistics or storage', () => {
  const h = harness(); h.a.startSessionHr()
  const written = h.writes().length
  for (const bpm of [NaN, Infinity, -Infinity, '120', 0, 29, 221]) h.sample(bpm)
  expect(h.a.readSessionHr('s').count).toBe(0)
  expect(h.writes()).toHaveLength(written)
  h.sample(30); h.sample(220)
  expect(h.a.readSessionHr('s')).toMatchObject({ count: 2, sum: 250, max: 220 })
})

it('flushes pause and stop without recursive saves, ignores late callbacks and resumes the same aggregate', () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120); h.sample(121)
  const paused = h.b.loadState(); paused.pausedAt = Date.now(); h.b.save(paused)
  expect(h.health.unsubscribeSample).toHaveBeenCalledTimes(1)
  expect(h.disk.get('session_state')).toMatchObject({ pausedAt: Date.now(), hr: { count: 2 } })
  h.sample(140, 0); h.b.stopSessionHr()
  expect(h.a.readSessionHr('s').count).toBe(2)
  paused.pausedAt = 0; h.b.save(paused); h.b.startSessionHr(); h.sample(122)
  h.a.stopSessionHr()
  expect(h.health.unsubscribeSample).toHaveBeenCalledTimes(2)
  expect(h.disk.get('session_state').hr.count).toBe(3)
})

it('reads buffered HR in summaries and calories without needing a preceding save', () => {
  const h = harness(), stale = h.a.loadState()
  h.a.startSessionHr(); h.sample(120); h.sample(129)
  vi.setSystemTime(1060000) // Keep the latest readings buffered while calculating one minute.
  const summary = h.b.buildSessionSummary(stale)
  expect(summary).toMatchObject({ avgHr: 125, maxHr: 129, sampleCount: 2 })
  expect(summary.calories).toBe(h.b.calories(h.a.loadState(), null, 1))
  expect(stale.hr.count).toBe(0)
  const ended = h.a.endSession(stale)
  expect(ended.sampleCount).toBe(2)
  expect(h.disk.get('summary_last').sampleCount).toBe(2)
  expect(h.a.loadState().active).toBe(false)
  h.sample(150)
  expect(h.a.loadState().hr.count).toBe(0)
})

it('merges runtime HR into atomic actions even when the action never calls save', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120); h.sample(121)
  const result = await h.b.commitSessionAction('s', s => {
    expect(s.hr.count).toBe(2)
    s.workout.rows[0][0].done = true
    h.b.stageSessionEvent(s, { t: 'set', sid: 's', ex: 0, set: 1, eventId: 'set-1', at: Date.now() })
  })
  expect(result.ok).toBe(true)
  expect(h.disk.get('session_state')).toMatchObject({ hr: { count: 2 }, pendingEdits: [{ eventId: 'set-1' }] })
})

it.each([true, false])('rebases a delayed HR flush on atomic training edits (action succeeds: %s)', async success => {
  const h = harness(); h.a.startSessionHr(); h.sample(120)
  const delayed = []
  h.storage.set.mockImplementation(item => item.key === 'session_state' ? delayed.push(item) : h.original(item))
  const action = h.a.commitSessionAction('s', s => {
    s.workout.rows[0][0].w = 75; s.workout.rows[0][0].done = true
    h.a.stageSessionEvent(s, { t: 'set', sid: 's', ex: 0, set: 1, eventId: 'new-set', at: Date.now() })
  })
  h.sample(130) // Threshold flush must wait behind the invisible training candidate.
  h.sample(131) // Buffered while that flush is queued.
  expect(delayed).toHaveLength(1)
  if (success) h.original(delayed[0]); else delayed[0].fail()
  expect((await action).ok).toBe(success)
  expect(delayed).toHaveLength(2)
  h.original(delayed[1])
  expect(h.disk.get('session_state').workout.rows[0][0]).toMatchObject({ w: success ? 75 : 20, done: success })
  expect(h.disk.get('session_state').pendingEdits || []).toHaveLength(success ? 1 : 0)
  expect(h.disk.get('session_state').hr).toMatchObject({ count: 3, sum: 381, max: 131 })
})

it('flushes samples arriving during a pending pause only after the pause commits', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120)
  const delayed = []
  h.storage.set.mockImplementation(item => item.key === 'session_state' ? delayed.push(item) : h.original(item))
  const action = h.b.commitSessionAction('s', s => { s.pausedAt = Date.now(); h.b.save(s) })
  expect(h.health.unsubscribeSample).not.toHaveBeenCalled()
  h.sample(121)
  h.original(delayed[0]); expect((await action).ok).toBe(true)
  expect(h.health.unsubscribeSample).toHaveBeenCalledTimes(1)
  expect(delayed).toHaveLength(2)
  h.original(delayed[1]); h.sample(140)
  expect(h.disk.get('session_state')).toMatchObject({ pausedAt: Date.now(), hr: { count: 2 } })
})

it('retains buffered readings after an atomic HR write failure and retries on the next sample', async () => {
  const h = harness(); h.a.startSessionHr()
  h.storage.set.mockImplementationOnce(item => item.fail())
  h.sample(120)
  await Promise.resolve(); await Promise.resolve()
  expect(h.a.readSessionHr('s').count).toBe(1)
  h.sample(121)
  expect(h.disk.get('session_state').hr).toMatchObject({ count: 2, sum: 241 })
})

it('freezes buffered HR in the durable local-close journal and stops sampling before closing', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120); h.sample(129)
  const result = await h.b.commitLocalClose('s', 'saved')
  expect(result.ok).toBe(true)
  expect(result.session).toMatchObject({ avgHr: 125, maxHr: 129, sampleCount: 2 })
  expect(h.b.journalEntry('s').summaryEvent).toMatchObject({ avgHr: 125, maxHr: 129, sampleCount: 2 })
  expect(h.disk.get('summary_last').sampleCount).toBe(2)
  expect(h.health.unsubscribeSample).toHaveBeenCalledTimes(1)
  h.sample(150)
  expect(h.a.loadState().active).toBe(false)
})

it('does not leak an old capture or queued flush into a replacement session', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120); h.sample(121)
  h.b.startSession({ ...h.plan, sid: 'next' })
  h.sample(150, 0)
  h.b.startSessionHr(); h.sample(80)
  await h.a.flushHr({ sid: 's', startedAt: 1000000, hr: { sum: 999, count: 99, max: 220 } })
  expect(h.a.loadState()).toMatchObject({ sid: 'next', hr: { count: 1, sum: 80, max: 80 } })
  expect(h.health.unsubscribeSample).toHaveBeenCalledTimes(1)
})

it('merges buffered HR into a sync snapshot and flushes a remote pause after durable publication', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120); h.sample(121)
  const s = h.a.loadState()
  const value = { t: 'sync', protocolVersion: 3, sid: 's', commitRev: 1, startedAt: s.startedAt,
    exercises: s.workout.exercises, rows: [[{ w: 55, r: 10, done: true }]], pausedAt: Date.now() }
  const result = await h.b.commitWireSnapshot({ ...value, wireHash: wireHash(value) }, { sid: 's', revision: 1, transferId: 'pause', hash: 'outer' })
  expect(result.ok).toBe(true)
  expect(h.health.unsubscribeSample).toHaveBeenCalledTimes(1)
  expect(h.disk.get('session_state')).toMatchObject({ hr: { count: 2 }, workout: { rows: [[{ w: 55, done: true }]] } })
})

it('flushes a quiet sensor at the ten-second deadline and cancels that timer on stop', () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120)
  vi.advanceTimersByTime(1000); h.sample(121)
  const written = h.writes().length
  vi.advanceTimersByTime(9000)
  expect(h.writes()).toHaveLength(written + 1)
  expect(h.disk.get('session_state').hr.count).toBe(2)
  vi.advanceTimersByTime(1000); h.sample(122); h.b.stopSessionHr()
  const stoppedWrites = h.writes().length
  vi.advanceTimersByTime(20000)
  expect(h.writes()).toHaveLength(stoppedWrites)
  expect(h.disk.get('session_state').hr.count).toBe(3)
})

it('keeps capturing if freezing a local close fails before publication', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120); h.sample(121)
  h.storage.set.mockImplementation(item => item.key === 'session_state' ? item.fail() : h.original(item))
  expect((await h.a.commitLocalClose('s', 'saved')).ok).toBe(false)
  h.sample(122)
  expect(h.a.readSessionHr('s').count).toBe(3)
  expect(h.health.unsubscribeSample).not.toHaveBeenCalled()
})

it('separates HR when a new segment of the same sid arrives and ignores its old callback', () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120); h.sample(121)
  const s = h.b.loadState()
  h.b.applySync(s, { sid: 's', segmentStartedAt: Date.now() + 1000, exercises: s.workout.exercises })
  h.b.startSessionHr(); h.sample(150, 0); h.sample(80)
  expect(h.a.readSessionHr('s')).toMatchObject({ count: 1, sum: 80, max: 80 })
  expect(h.health.subscribeSample).toHaveBeenCalledTimes(2)
})

it.each([true, false])('keeps a same-sid segment reset when the first HR flush completes late (success: %s)', async success => {
  const h = harness(); h.a.startSessionHr()
  const delayed = []
  h.storage.set.mockImplementation(item => item.key === 'session_state' ? delayed.push(item) : h.original(item))
  h.sample(180) // Atomic candidate has HR, but the published cache still contains zeros.
  expect(delayed).toHaveLength(1)
  const s = h.b.loadState(), segmentStartedAt = Date.now() + 1000
  h.b.applySync(s, { sid: 's', segmentStartedAt, exercises: s.workout.exercises,
    rows: [[{ w: 55, r: 8, done: true }]] })
  expect(h.b.readSessionHr('s')).toEqual({ sum: 0, count: 0, max: 0 })
  if (success) h.original(delayed[0]); else delayed[0].fail()
  expect(h.a.readSessionHr('s')).toEqual({ sum: 0, count: 0, max: 0 })
  let index = 1
  while (index < delayed.length) h.original(delayed[index++])
  expect(h.disk.get('session_state')).toMatchObject({ segmentStartedAt,
    hr: { sum: 0, count: 0, max: 0 }, workout: { rows: [[{ w: 55, r: 8, done: true }]] } })
  expect(h.disk.get('session_state').hr).not.toHaveProperty('last')
  h.b.startSessionHr(); h.sample(180, 0); h.sample(80)
  while (index < delayed.length) h.original(delayed[index++])
  await Promise.resolve()
  expect(h.a.readSessionHr('s')).toMatchObject({ count: 1, sum: 80, max: 80, last: 80 })
  expect(h.disk.get('session_state').hr).toMatchObject({ count: 1, sum: 80, max: 80 })
})

it.each(['replace', 'close'])('does not carry an in-flight first HR aggregate into %s', kind => {
  const h = harness(); h.a.startSessionHr()
  const delayed = []
  h.storage.set.mockImplementation(item => item.key === 'session_state' ? delayed.push(item) : h.original(item))
  h.sample(180)
  if (kind === 'replace') h.b.startSession({ ...h.plan, sid: 'next' })
  else h.b.closeSession('s')
  for (let i = 0; i < delayed.length; i++) h.original(delayed[i])
  expect(h.disk.get('session_state')).toMatchObject({ sid: kind === 'replace' ? 'next' : '',
    hr: { count: 0, sum: 0, max: 0 } })
  expect(h.disk.get('session_state').hr).not.toHaveProperty('sampleAt')
})

it('resets segment HR while preserving a successful in-flight row action and its pending event', async () => {
  const h = harness(), s = h.a.loadState()
  h.a.addHr(s, 180) // Runtime sample buffered independently of a sensor flush.
  const delayed = []
  h.storage.set.mockImplementation(item => item.key === 'session_state' ? delayed.push(item) : h.original(item))
  const action = h.a.commitSessionAction('s', candidate => {
    candidate.workout.rows[0][0].w = 75; candidate.workout.rows[0][0].done = true
    h.a.stageSessionEvent(candidate, { t: 'set', sid: 's', ex: 0, set: 1, eventId: 'set-e1', at: Date.now() })
  })
  const next = h.b.loadState(), segmentStartedAt = Date.now() + 1000
  h.b.applySync(next, { sid: 's', segmentStartedAt, exercises: next.workout.exercises,
    rows: [[{ w: 55, r: 8, done: false }]] })
  for (let i = 0; i < delayed.length; i++) h.original(delayed[i])
  expect((await action).ok).toBe(true)
  expect(h.disk.get('session_state')).toMatchObject({ segmentStartedAt,
    hr: { count: 0, sum: 0, max: 0 }, workout: { rows: [[{ w: 55, r: 8, done: true }]] }, pendingEdits: [{ eventId: 'set-e1' }] })
})

it('filters an old-page HR overlay against the final identity of an atomic new-segment snapshot', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(180); h.sample(181)
  const s = h.a.loadState(), delayed = [], segmentStartedAt = Date.now() + 1000
  h.storage.set.mockImplementation(item => item.key === 'session_state' ? delayed.push(item) : h.original(item))
  const value = { t: 'sync', protocolVersion: 3, sid: 's', commitRev: 1, startedAt: s.startedAt, segmentStartedAt,
    exercises: s.workout.exercises, rows: [[{ w: 55, r: 8, done: true }]] }
  const snapshot = h.b.commitWireSnapshot({ ...value, wireHash: wireHash(value) },
    { sid: 's', revision: 1, transferId: 'segment', hash: 'outer' })
  const stale = h.a.loadState(); stale.workout.rows[0][0].r = 12; h.a.save(stale)
  for (let i = 0; i < delayed.length; i++) h.original(delayed[i])
  expect((await snapshot).ok).toBe(true)
  expect(h.disk.get('session_state')).toMatchObject({ segmentStartedAt,
    hr: { count: 0, sum: 0, max: 0 }, workout: { rows: [[{ w: 55, r: 12, done: true }]] } })
  expect(h.b.readSessionHr('s')).toEqual({ count: 0, sum: 0, max: 0 })
})

it('guards a flush already queued behind an atomic action when a newer session replaces it', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120)
  const delayed = []
  h.storage.set.mockImplementation(item => item.key === 'session_state' ? delayed.push(item) : h.original(item))
  const action = h.a.commitSessionAction('s', s => { s.workout.rows[0][0].w = 75 })
  h.sample(130)
  h.b.startSession({ ...h.plan, sid: 'replacement', exercises: [{ sets: 1, weight: 45, reps: 10 }] })
  for (let i = 0; i < delayed.length; i++) h.original(delayed[i])
  expect((await action).ok).toBe(true)
  expect(h.disk.get('session_state')).toMatchObject({ sid: 'replacement', hr: { count: 0, sum: 0 }, workout: { rows: [[{ w: 45 }]] } })
})

it('restores the persisted aggregate after a runtime restart and continues counting', () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120); h.sample(121); h.a.stopSessionHr()
  const reboot = watchPersistence(h.disk)
  Object.assign(reboot.ctx, { console })
  loadWatchModule('session', reboot.ctx, ['loadState', 'addHr', 'flushHr'])
  const restored = reboot.ctx.loadState()
  expect(restored.hr).toMatchObject({ count: 2, sum: 241 })
  reboot.ctx.addHr(restored, 122); reboot.ctx.flushHr(restored)
  expect(h.disk.get('session_state').hr).toMatchObject({ count: 3, sum: 363 })
})

it('orders pause save(stop) behind a pending atomic action without reverting its row or intention', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120); h.sample(121)
  const delayed = []
  h.storage.set.mockImplementation(item => item.key === 'session_state' ? delayed.push(item) : h.original(item))
  const action = h.a.commitSessionAction('s', s => {
    s.workout.rows[0][0].w = 75; s.workout.rows[0][0].done = true
    h.a.stageSessionEvent(s, { t: 'set', sid: 's', ex: 0, set: 1, eventId: 'before-pause', at: Date.now() })
  })
  const paused = h.b.loadState(); paused.pausedAt = Date.now(); h.b.save(paused)
  expect(delayed).toHaveLength(1)
  expect(h.health.unsubscribeSample).toHaveBeenCalledTimes(1)
  for (let i = 0; i < delayed.length; i++) h.original(delayed[i])
  expect((await action).ok).toBe(true)
  expect(h.disk.get('session_state')).toMatchObject({ pausedAt: Date.now(), hr: { count: 2 },
    workout: { rows: [[{ w: 75, done: true }]] }, pendingEdits: [{ eventId: 'before-pause' }] })
})

it('freezes the complete HR aggregate after a queued row action and keeps it in both close records', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120)
  const delayed = []
  h.storage.set.mockImplementation(item => item.key === 'session_state' ? delayed.push(item) : h.original(item))
  const action = h.a.commitSessionAction('s', s => { s.workout.rows[0][0].w = 75; s.workout.rows[0][0].done = true })
  h.sample(129)
  const closing = h.b.commitLocalClose('s', 'saved')
  h.sample(150) // The close boundary has been requested; do not extend its frozen summary.
  for (let round = 0, index = 0; round < 30; round++) {
    while (index < delayed.length) h.original(delayed[index++])
    await Promise.resolve()
  }
  expect((await action).ok).toBe(true)
  const result = await closing
  expect(result.ok).toBe(true)
  expect(result.session).toMatchObject({ sampleCount: 2, avgHr: 125, maxHr: 129, sets: [{ weight: '75' }] })
  expect(h.b.journalEntry('s').summaryEvent.sampleCount).toBe(2)
  expect(h.disk.get('summary_last').sampleCount).toBe(2)
  expect(h.a.loadState().active).toBe(false)
})

it('keeps the HR deadline alive after the subscribing Page is destroyed', () => {
  const h = harness(), pageTimers = watchTimerOwner()
  startWatchApp(h.shared)
  Object.assign(h.a, pageTimers)
  h.a.startSessionHr(); h.sample(120)
  vi.advanceTimersByTime(1000); h.sample(121)
  pageTimers.destroy()
  vi.advanceTimersByTime(9000)
  expect(h.disk.get('session_state').hr.count).toBe(2)
  expect(h.b.readSessionHr('s').count).toBe(2)
})

it('retains a failed stop flush in runtime and allows an explicit retry', async () => {
  const h = harness(); h.a.startSessionHr(); h.sample(120); h.sample(121)
  h.storage.set.mockImplementationOnce(item => item.fail())
  expect((await h.a.stopSessionHr()).ok).toBe(false)
  expect(h.disk.get('session_state').hr.count).toBe(1)
  expect(h.b.readSessionHr('s').count).toBe(2)
  expect((await h.b.flushHr()).ok).toBe(true)
  expect(h.disk.get('session_state').hr.count).toBe(2)
})
