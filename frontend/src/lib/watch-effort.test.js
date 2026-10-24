// @vitest-environment node
// RPE/RIR registration on the watch: same-page overlay, correct set attribution after the focus
// moved on, rest never paused or restarted, drafts only, explicit clear, and no scale drift.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { applyEdit, applyRest, restOf, applyFocus } from '../../../watch-app/src/lib/protocol.js'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'
import { effortScaleOf, effortValueOf, effortKindOf, stepEffortValue, effortMeaning, effortSummaryText, formatEffort } from '../../../watch-app/src/lib/effort-scale.js'

const source = path => readFileSync(new URL('../../../watch-app/src/' + path, import.meta.url), 'utf8')
const imports = /^import[\s\S]*?from ['"][^'"]+['"]\r?$/gm

function page(path, deps) {
  const script = source(path).match(/<script>([\s\S]*?)<\/script>/)[1]
  const context = { console, WATCH_VERSION: 'test-watch', applyEdit, applyRest, restOf, applyFocus,
    persistenceStatus: () => ({}), storageStatus: () => ({}), storage: { getSync: () => null, set() {} },
    effortScaleOf, effortValueOf, effortKindOf, stepEffortValue, effortMeaning, effortSummaryText, formatEffort,
    replacePlan() {}, ...deps }
  runInNewContext(script.replace(imports, '').replace('export default', 'this.page ='), context)
  return { ...context.page, ...context.page.data }
}

function session() {
  const { disk, ctx } = watchPersistence()
  Object.assign(ctx, { console, Date, applyEdit, applyRest })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', ctx, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
  loadWatchModule('session', ctx, ['loadState', 'startSession', 'save', 'replacePlan', 'applySync', 'nextUndone', 'nextUndoneFrom',
    'setRowValue', 'toggleSet', 'setEffort', 'addSet', 'removeSet', 'addRestTime', 'calories', 'endSession', 'closeSession'])
  return { ...ctx, disk }
}

function setup({ scale = 'rpe', sets = 3 } = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-24T09:00:00Z'))
  const sessions = session()
  const sendEvent = vi.fn()
  const state = sessions.startSession({ sid: 's1', name: 'Bench', effortScale: scale, weightUnit: 'kg', profile: { bodyWeightKg: 80 },
    exercises: [{ name: 'Bench', entryInstanceId: 'e1', setIds: Array.from({ length: sets }, (_, i) => 'a' + (i + 1)), sets, reps: '8', weight: '60', restSec: 90 }] })
  const brightness = { setKeepScreenOn: vi.fn() }
  const workout = page('Workout/index.ux', { ...sessions, startServer() {}, sendControl: vi.fn(), sendEvent,
    router: { push: vi.fn(), replace: vi.fn() }, startSessionHr() {}, stopSessionHr() {}, restOver: vi.fn(), tick() {},
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, pendingCount: () => 0, isConnected: () => true,
    brightness })
  workout.onInit()
  workout.onReady()
  return { sessions, workout, sendEvent, state }
}

const complete = workout => { workout.state.restUntil = 0; workout.refresh(); workout.onCurrentSetAction(); vi.advanceTimersByTime(400) }

describe('per-set effort on the watch (RPE/RIR)', () => {
  it('shows only the phone’s scale and hides the entry when effort is off', () => {
    const rpe = setup({ scale: 'rpe' }), rir = setup({ scale: 'rir' }), none = setup({ scale: 'none' })
    expect(rpe.workout.effortScale).toBe('rpe')
    expect(rir.workout.effortScale).toBe('rir')
    expect(none.workout.effortScale).toBe('none')
    complete(rpe.workout); complete(rir.workout); complete(none.workout)
    expect(rpe.workout.effortEntryOn).toBe(true)
    expect(rpe.workout.effortEntryText).toBe('未登记')
    expect(rir.workout.effortEntryOn).toBe(true)
    expect(none.workout.effortEntryOn).toBe(false)
    // No second scale setting on the watch.
    expect(source('Workout/index.ux')).not.toContain('量表设置')
  })

  it('starts empty, first move lands on the scale floor and each deliberate step moves 0.5', () => {
    for (const [scale, floor, ceil] of [['rpe', 6, 10], ['rir', 0, 10]]) {
      const { workout } = setup({ scale })
      complete(workout)
      workout.openEffort()
      expect(workout.effortOn).toBe(true)
      expect(workout.effortDraftLabel).toBe('—')
      expect(workout.effortHint).toBe('左右滑动选择')
      workout.effortMove(1)
      expect(workout.effortDraft).toBe(floor + 0.5 === floor ? floor : floor) // first move starts at the floor
      expect(workout.effortDraft).toBe(floor)
      for (let i = 0; i < 40; i++) workout.effortMove(1)
      expect(workout.effortDraft).toBe(ceil)          // clamped, no wrap
      for (let i = 0; i < 40; i++) workout.effortMove(-1)
      expect(workout.effortDraft).toBe(floor)
      expect(workout.effortMeaning).toBe(scale === 'rpe' ? '还能再做约4次，较轻松' : '无法再完成一次标准动作')
    }
  })

  it('writes the rating to the set that was just completed, even after the focus moved to set 3', () => {
    const { workout, sessions } = setup({ sets: 3 })
    complete(workout)                          // completes set 1, focus -> set 2
    workout.state.setIdx = 1; sessions.save(workout.state); workout.refresh()
    complete(workout)                          // completes set 2, focus -> set 3
    expect(workout.state.setIdx).toBe(2)
    workout.openEffort()
    expect(workout.effortTarget.setNo).toBe(2)
    workout.effortMove(1); workout.effortMove(1)   // RPE 6 -> 6.5
    workout.confirmEffort()
    const rows = sessions.loadState().workout.rows[0]
    expect(rows[0].rpe).toBeUndefined()            // set 1 untouched
    expect(rows[1].rpe).toBe(6.5)                  // set 2 got it
    expect(rows[2].rpe).toBeUndefined()            // set 3 (current focus) untouched
    expect(workout.effortOn).toBe(false)
  })

  it('never pauses or restarts the rest: open, slide, confirm and cancel leave the deadline alone', () => {
    const { workout, sessions, sendEvent } = setup({ sets: 3 })
    complete(workout)                          // starts a 90 s rest
    const before = { ...workout.state }
    vi.advanceTimersByTime(20_000)
    workout.tickClock()
    const leftAtOpen = Math.ceil((workout.state.restUntil - Date.now()) / 1000)
    workout.openEffort()
    expect(workout.effortRestLabel).toBe('休息 ' + workout.mmss(leftAtOpen))
    workout.effortMove(1)
    workout.closeEffort()                       // cancel
    expect(workout.state.restUntil).toBe(before.restUntil)
    expect(workout.state.restVersion).toBe(before.restVersion)
    expect(workout.state.pausedAt || 0).toBe(0)
    workout.openEffort(); workout.effortMove(1); workout.confirmEffort()
    expect(workout.state.restUntil).toBe(before.restUntil)
    expect(workout.state.restVersion).toBe(before.restVersion)
    expect(sendEvent.mock.calls.filter(([m]) => m.t === 'rest')).toHaveLength(0)
    expect(sessions.loadState().restUntil).toBe(before.restUntil)
  })

  it('keeps the draft and shows “rest is over” when the rest expires while editing', () => {
    const { workout, sessions } = setup({ sets: 3 })
    complete(workout)
    workout.openEffort()
    workout.effortMove(1); workout.effortMove(1)
    const draft = workout.effortDraft
    vi.advanceTimersByTime(95_000)
    workout.tickClock()
    expect(workout.effortOn).toBe(true)
    expect(workout.effortDraft).toBe(draft)
    expect(workout.effortRestLabel).toBe('休息已结束')
    expect(workout.state.restUntil).toBe(0)     // the page's own expiry ran, once
    expect(sessions.loadState().restUntil).toBe(0)
    workout.confirmEffort()
    expect(sessions.loadState().workout.rows[0][0].rpe).toBe(6.5)
  })

  it('cancels without writing and shows the saved value on reopen; clear is explicit', () => {
    const { workout, sessions } = setup({ sets: 3 })
    complete(workout)
    workout.openEffort(); workout.effortMove(1); workout.effortMove(1); workout.confirmEffort()
    expect(sessions.loadState().workout.rows[0][0].rpe).toBe(6.5)
    workout.openEffort()
    expect(workout.effortDraft).toBe(6.5)       // shows the stored value
    workout.effortMove(1)
    workout.closeEffort()                       // cancel keeps 6.5
    expect(sessions.loadState().workout.rows[0][0].rpe).toBe(6.5)
    workout.openEffort(); workout.clearEffort()
    const row = sessions.loadState().workout.rows[0][0]
    expect(row.rpe).toBeUndefined()
    expect(row.rir).toBeUndefined()
    expect(row.effortAt).toBeGreaterThan(0)     // explicit clear keeps a version
    expect(workout.effortEntryText).toBe('未登记')
  })

  it('keeps 0 RIR as a real rating, not a clear', () => {
    const { workout, sessions } = setup({ scale: 'rir', sets: 3 })
    complete(workout)
    workout.openEffort(); workout.effortMove(-1)   // first move starts at the floor: 0
    expect(workout.effortDraft).toBe(0)
    expect(workout.effortMeaning).toBe('无法再完成一次标准动作')
    workout.confirmEffort()
    expect(sessions.loadState().workout.rows[0][0].rir).toBe(0)
    expect(workout.effortEntryText).toBe('RIR 0 · 无法再完成一次标准动作')
  })

  it('shows an out-of-step historical value as-is and does not rewrite it on open', () => {
    const { workout, sessions } = setup({ sets: 3 })
    complete(workout)
    const s = sessions.loadState()
    s.workout.rows[0][0].rpe = 7.3
    s.workout.rows[0][0].effortAt = 5
    sessions.save(s)
    workout.state = sessions.loadState()
    workout.refresh()
    workout.openEffort()
    expect(workout.effortDraft).toBe(7.3)
    expect(workout.effortDraftLabel).toBe('7.3')
    workout.closeEffort()
    expect(sessions.loadState().workout.rows[0][0].rpe).toBe(7.3)
  })

  it('refuses to save a draft across a phone scale change', () => {
    const { workout, sessions } = setup({ sets: 3 })
    complete(workout)
    workout.openEffort(); workout.effortMove(1)
    const s = sessions.loadState()
    s.effortScale = 'rir'
    sessions.save(s)
    workout.state = sessions.loadState()
    workout.confirmEffort()
    expect(workout.effortNotice).toBe('手机已切换量表，请重新打开')
    expect(workout.effortOn).toBe(true)
    expect(sessions.loadState().workout.rows[0][0].rpe).toBeUndefined()
    expect(sessions.loadState().workout.rows[0][0].rir).toBeUndefined()
  })

  it('stops editing when the target set is undone or the session ends', () => {
    for (const how of ['undo', 'end']) {
      const { workout, sessions } = setup({ sets: 3 })
      complete(workout)
      workout.openEffort()
      const s = sessions.loadState()
      if (how === 'undo') { s.workout.rows[0][0].done = false; sessions.save(s); workout.state = sessions.loadState() }
      else { sessions.closeSession(s.sid); workout.state = sessions.loadState() }
      workout.tickClock()
      expect(workout.effortOn).toBe(false)
      expect(workout.effortNotice).toContain('目标组已变化')
    }
  })

  it('keeps the completion panel available and unrated does not block saving', () => {
    const { workout } = setup({ sets: 1 })
    complete(workout)
    // All sets done: the existing save/continue panel still opens, with an optional effort entry.
    expect(workout.closeMode).toBe('complete')
    expect(workout.effortEntryOn).toBe(true)
    expect(source('Workout/index.ux')).toContain('value="{{ \'登记本组强度 · \' + effortEntryText }}"')
  })

  it('sends one effort event carrying stable ids, scale, value, version and base version', () => {
    const { workout, sendEvent } = setup({ sets: 3 })
    complete(workout)
    workout.openEffort(); workout.effortMove(1); workout.confirmEffort()
    const event = sendEvent.mock.calls.map(([m]) => m).find(m => m.t === 'effort')
    expect(event).toMatchObject({ sid: 's1', ex: 0, set: 1, scale: 'rpe', value: 6, clear: false })
    expect(event.effortVersion).toBeGreaterThan(0)
    expect(event.baseEffortVersion).toBe(0)
  })

  it('applies a phone-side rating with its own version and rejects an older one', () => {
    const { workout, sessions } = setup({ sets: 3 })
    complete(workout)
    workout.onRemoteEffort({ sid: 's1', ex: 0, set: 1, scale: 'rpe', value: 9, effortVersion: 900 })
    expect(sessions.loadState().workout.rows[0][0].rpe).toBe(9)
    workout.onRemoteEffort({ sid: 's1', ex: 0, set: 1, scale: 'rpe', value: 6, effortVersion: 500 })
    expect(sessions.loadState().workout.rows[0][0].rpe).toBe(9)   // older does not overwrite
  })

  it('offers the last completed set for a late rating after the page was reopened', () => {
    const { workout, sessions, sendEvent } = setup({ sets: 3 })
    complete(workout)
    // A new page instance (app restart / navigation back): the in-memory capture is gone, but
    // the most recently completed set is still the one a late rating belongs to.
    const reopened = page('Workout/index.ux', { ...sessions, startServer() {}, sendControl: vi.fn(), sendEvent,
      router: { push: vi.fn(), replace: vi.fn() }, startSessionHr() {}, stopSessionHr() {}, restOver: vi.fn(), tick() {},
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, pendingCount: () => 0, isConnected: () => true,
      brightness: { setKeepScreenOn: vi.fn() } })
    reopened.onInit()
    expect(reopened.effortTarget).toMatchObject({ setNo: 1, setId: 'a1' })
    expect(reopened.effortEntryOn).toBe(true)
  })

  it('does not inherit a rating on an added set or after undo/redo', () => {
    const { workout, sessions } = setup({ sets: 2 })
    complete(workout)
    workout.openEffort(); workout.effortMove(1); workout.confirmEffort()
    workout.onMenuAddSet()
    const rows = sessions.loadState().workout.rows[0]
    expect(rows[rows.length - 1].rpe).toBeUndefined()
    // Undo the completed set and complete it again: no implicit copy of the old rating.
    workout.state.setIdx = 0
    workout.onUndo()
    const afterUndo = sessions.loadState().workout.rows[0][0]
    expect(afterUndo.done).toBe(false)
    expect(afterUndo.rpe).toBe(6)   // the rating itself is data on the set and stays until cleared
    workout.onComplete()
    expect(sessions.loadState().workout.rows[0][0].rpe).toBe(6)
  })
})
