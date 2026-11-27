import { commitPageAction } from '../../../watch-app/src/lib/local-action.js'
import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { rotationStep, valueStep } from '../../../watch-app/src/lib/value-step.js'
import { captureRow, rowTarget, setDotWindow, createSetDotPicker } from '../../../watch-app/src/lib/workout-interaction.js'
import { stripImports, watchSource, watchInteractionDeps } from './watch-test-harness.js'
const makeState = (count = 4) => ({ active: true, sid: 's', exIdx: 0, setIdx: 0, weightUnit: 'kg', workout: {
  exercises: [{ entryInstanceId: 'e', name: 'Row' }], rows: [Array.from({ length: count }, (_, i) => ({ setId: 'r' + i, w: '', r: 8, done: false }))] } })
function workout(s = makeState()) {
  const ctx = { ...watchInteractionDeps, Date, setTimeout, clearTimeout, commitPageAction, commitSessionAction: async (sid, action) => ({ ok: true, output: action(s) }), replayPendingEvents: vi.fn(), rotationStep, valueStep, captureRow, rowTarget, setDotWindow, createSetDotPicker,
    storage: { getSync: () => 0.5 }, loadState: () => s, save: vi.fn(),
    persistenceStatus: () => ({ failed: false }), storageStatus: () => ({ failed: false }), pendingCount: () => 0,
    setRowValue: vi.fn((state, ex, set, field, value) => { state.workout.rows[ex][set][field] = value; state.pendingEdits = [{ eventId: 'original', t: 'weight' }] }),
    router: { push: vi.fn() } }
  runInNewContext(stripImports(watchSource('Workout/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'this.page ='), ctx)
  const page = { ...ctx.page, ...ctx.page.data, state: s }; page.refresh = vi.fn(); page.emitEvent = vi.fn()
  return { page, ctx, s }
}
describe('watch stable targets and step rules', () => {
  it('drawn completion target preserves complete, undo and paused no-op behavior', async () => {
    const { page } = workout()
    page.onComplete = vi.fn(); page.onUndo = vi.fn()
    page.onCurrentSetAction()
    expect(page.onComplete).toHaveBeenCalledTimes(1)
    page.rowDone = true; page.onCurrentSetAction()
    expect(page.onUndo).toHaveBeenCalledTimes(1)
    page.paused = true; page.onCurrentSetAction()
    expect(page.onComplete).toHaveBeenCalledTimes(1)
    expect(page.onUndo).toHaveBeenCalledTimes(1)
  })

  it('rejects deleted stable IDs, stale sid and out of range legacy indexes', async () => {
    const s = makeState(), target = captureRow(s)
    expect(rowTarget(s, target).setIdx).toBe(0)
    s.workout.rows[0].shift(); expect(rowTarget(s, target)).toBeNull()
    expect(rowTarget(s, { ...target, sid: 'other' })).toBeNull()
    expect(rowTarget(s, { exIdx: 0, setIdx: 99 })).toBeNull()
  })
  it.each([1, 7, 8, 12, 100])('bounds %s dot targets and never pages the cursor', count => {
    const s = makeState(count), cur = s.setIdx, a = setDotWindow(s), b = setDotWindow(s, 1)
    expect(a.dots.length).toBeLessThanOrEqual(count > 7 ? 5 : 7)
    expect(b.dots.length).toBeLessThanOrEqual(count > 7 ? 5 : 7)
    expect(s.setIdx).toBe(cur)
  })
  it.each([undefined, null, 0, -1, NaN, Infinity, 'bad', 0.00001])('uses a safe default for step %s', step => {
    expect(valueStep('', 'w', 1, step)).toBe('0.5')
  })
  it('quantizes decimals, supports zero and caps legal values', async () => {
    expect(valueStep('0.1', 'w', 1, 0.2)).toBe('0.3')
    expect(valueStep(0, 'r', -1)).toBe('0')
    expect(valueStep(99999, 'r', 1)).toBe('99999')
    expect(rotationStep({ delta: 50 })).toBe(1)
    expect(rotationStep({ delta: -3 })).toBe(-1)
    expect(rotationStep({ delta: 1, state: 3 })).toBe(0)
    expect(valueStep('10', 'r', 3)).toBe('13')
  })
})
describe('actual watch workout page wiring', () => {
  it('renders real set targets and pages without moving the cursor', async () => {
    const { page, s } = workout(makeState(12))
    page.refreshSetDots()
    expect(page.setDots.map(d => d.number)).toEqual([1, 2, 3])
    expect(page.dotHasNext).toBe(true)
    page.nextDotSegment()
    expect(page.setDots.map(d => d.number)).toEqual([4, 5, 6])
    expect(s.setIdx).toBe(0)
    await page.pickSetDot(page.setDots[1])
    expect(s.setIdx).toBe(4)
  })
  it('hands 40 pending edits to the app-owned replay once, without per-event session reloads', async () => {
    const { page, ctx, s } = workout()
    s.pendingEdits = Array.from({ length: 40 }, (_, i) => ({ eventId: 'queued-' + i }))
    ctx.loadState = vi.fn(() => s)
    page.flushPendingRowEdits()
    expect(ctx.replayPendingEvents).toHaveBeenCalledOnce()
    expect(ctx.loadState).toHaveBeenCalledOnce()
    expect(page.emitEvent).not.toHaveBeenCalled()
    expect(s.pendingEdits).toHaveLength(40)
  })
  it('does not switch sets when no field is selected', async () => {
    const { page } = workout(); page.stepSet = vi.fn(); await page.onRotation({ delta: 1 })
    expect(page.stepSet).not.toHaveBeenCalled()
  })
  it('limits large crown deltas to one low-sensitivity detent per callback', () => {
    const { page } = workout()
    page.editWeight(); page.onRotation({ delta: 3 })
    expect(page.weightNum).toBe('0.5')
    page.editReps(); page.onRotation({ delta: -2 })
    expect(page.repsNum).toBe('7')
  })
  it('cycles pages once per horizontal swipe', () => {
    const { page } = workout()
    page.pageIndex = 2
    page.touchStart({ touches: [{ clientX: 200, clientY: 200 }] })
    page.touchMove({ touches: [{ clientX: 150, clientY: 200 }] })
    page.touchEnd({ changedTouches: [{ clientX: 100, clientY: 200 }] })
    expect(page.pageIndex).toBe(0)
  })
  it('keeps 400 crown steps local and opens the official keyboard on the same page', () => {
    const { page, ctx, s } = workout()
    page.editWeight(); expect(page.selectedField).toBe('w')
    for (let i = 0; i < 400; i++) page.onRotation({ delta: 1 })
    expect(page.weightNum).toBe('0.5')
    expect(s.workout.rows[0][0].w).toBe('')
    expect(ctx.setRowValue).not.toHaveBeenCalled()
    expect(ctx.replayPendingEvents).not.toHaveBeenCalled()
    expect(ctx.save).not.toHaveBeenCalled()
    page.editWeight(); expect(page.keypadOn).toBe(true)
    expect(page.keypadValue).toBe('200')
    page.closeNumberKeypad()
    expect(ctx.router.push).not.toHaveBeenCalled()
  })
  it('renders every rep from 2 through 10 during a rapid burst and stages one final V4 edit', async () => {
    vi.useFakeTimers()
    try {
      const { page, ctx, s } = workout()
      s.protocolVersion = 4
      s.sessionOrigin = 'phone'
      s.workout.rows[0][0].r = '1'
      const commit = vi.spyOn(ctx, 'commitSessionAction')
      ctx.stageSessionEvent = vi.fn(() => ({ protocolVersion: 4, rev: 1 }))
      page.editReps()
      const rendered = vi.fn()
      let shown = page.repsNum
      Object.defineProperty(page, 'repsNum', {
        get: () => shown,
        set: value => { shown = value; rendered(value) },
      })
      for (let i = 0; i < 9; i++) page.onRotation({ delta: 4, state: 2 })
      expect(rendered).toHaveBeenCalledExactlyOnceWith('2')
      expect(page.numberDraftOf().r).toBe('10')
      await vi.advanceTimersByTimeAsync(69)
      expect(page.repsNum).toBe('2')
      await vi.advanceTimersByTimeAsync(1)
      expect(page.repsNum).toBe('3')
      await vi.advanceTimersByTimeAsync(279)
      expect(rendered.mock.calls.flat()).toEqual(['2', '3', '4', '5', '6', '7', '8', '9', '10'])
      expect(commit).not.toHaveBeenCalled()
      expect(ctx.stageSessionEvent).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(commit).toHaveBeenCalledOnce()
      expect(ctx.stageSessionEvent).toHaveBeenCalledExactlyOnceWith(s, expect.objectContaining({
        t: 'reps', reps: '10', sid: 's', entryInstanceId: 'e', setId: 'r0',
      }))
      expect(s.workout.rows[0][0].r).toBe('10')
    } finally { vi.useRealTimers() }
  })
  it('saves a sustained burst after idle while the display finishes showing each weight increment', async () => {
    vi.useFakeTimers()
    try {
      const { page, ctx, s } = workout()
      const commit = vi.spyOn(ctx, 'commitSessionAction')
      page.editWeight()
      const rendered = []
      let shown = page.weightNum
      Object.defineProperty(page, 'weightNum', {
        get: () => shown,
        set: value => { shown = value; rendered.push(value) },
      })
      for (let batch = 0; batch < 50; batch++) {
        for (let step = 0; step < 10; step++) page.onRotation({ delta: batch < 40 ? 1 : -1 })
        await vi.advanceTimersByTimeAsync(70)
      }
      expect(page.numberDraftOf().w).toBe('150')
      expect(s.workout.rows[0][0].w).toBe('')
      await vi.advanceTimersByTimeAsync(279)
      expect(commit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(commit).toHaveBeenCalledOnce()
      expect(s.workout.rows[0][0].w).toBe('150')
      expect(Number(page.weightNum)).toBeLessThan(150)
      await vi.advanceTimersByTimeAsync(2000)
      expect(page.weightNum).toBe('150')
      expect(rendered).toEqual(Array.from({ length: 300 }, (_, step) => String((step + 1) / 2)))
      expect(commit).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('coalesces a reversal and ignores detents beyond either bound', async () => {
    vi.useFakeTimers()
    try {
      const { page, ctx, s } = workout()
      const commit = vi.spyOn(ctx, 'commitSessionAction')
      const row = s.workout.rows[0][0]
      row.r = '99998'
      page.editReps()
      for (const delta of [1, 1, -1, -1, 1]) page.onRotation({ delta })
      expect(page.repsNum).toBe('99999')
      await vi.advanceTimersByTimeAsync(70)
      expect(page.repsNum).toBe('99998')
      await vi.advanceTimersByTimeAsync(280)
      expect(commit).toHaveBeenCalledOnce()
      row.r = '0'
      page.updateNumbers()
      page.onRotation({ delta: -1 })
      await vi.advanceTimersByTimeAsync(400)
      expect(page.repsNum).toBe('0')
      expect(commit).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('cancels queued rendering and saves when the captured row is replaced remotely', async () => {
    vi.useFakeTimers()
    try {
      const { page, ctx, s } = workout()
      const commit = vi.spyOn(ctx, 'commitSessionAction')
      page.editReps()
      page.onRotation({ delta: 1 })
      page.onRotation({ delta: 1 })
      s.workout.rows[0][0] = { setId: 'replacement', w: '', r: '42', done: false }
      page.updateNumbers()
      await vi.advanceTimersByTimeAsync(500)
      expect(page.repsNum).toBe('42')
      expect(commit).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('stops on stale units, deleted targets, completed rows and pause', async () => {
    for (const change of [s => { s.weightUnit = 'lb' }, s => { s.workout.rows[0][0].setId = 'new' }, s => { s.workout.rows[0][0].done = true }, s => { s.pausedAt = 1 }]) {
      const { page, ctx, s } = workout(); page.editWeight(); change(s); await page.onRotation({ delta: 1 })
      expect(ctx.setRowValue).not.toHaveBeenCalled()
    }
  })
  it.each(['persistence', 'storage', 'outbox', 'pending edits'])('backpressures %s without deleting accepted edits', async reason => {
    const { page, ctx, s } = workout(); page.editWeight()
    s.pendingEdits = Array.from({ length: 256 }, (_, i) => ({ eventId: 'saved-' + i }))
    if (reason !== 'pending edits') s.pendingEdits.length = 3
    ctx.persistenceStatus = () => ({ failed: reason === 'persistence' })
    ctx.storageStatus = () => ({ failed: reason === 'storage' })
    ctx.pendingCount = () => reason === 'outbox' ? 256 : 0
    const before = structuredClone(s.pendingEdits)
    await page.onRotation({ delta: 1 })
    expect(ctx.setRowValue).not.toHaveBeenCalled(); expect(s.pendingEdits).toEqual(before)
    expect(page.weightNum).toBe('0.5') // a local draft needs no storage/transport capacity
  })
  it.each([0, 1])('leaves vertical scrolling on page %s; preserves horizontal navigation', index => {
    const { page } = workout(); page.pageIndex = index
    page.touchStart({ touches: [{ clientX: 100, clientY: 200 }] })
    page.touchMove({ touches: [{ clientX: 100, clientY: 100 }] })
    page.touchEnd({ changedTouches: [{ clientX: 100, clientY: 100 }] })
    expect(page.pageIndex).toBe(index)
    expect(page.interactionBlocked()).toBe(true)
    page.touchStart({ touches: [{ clientX: 200, clientY: 200 }] })
    page.touchEnd({ changedTouches: [{ clientX: 100, clientY: 200 }] })
    expect(page.pageIndex).toBe(index + 1)
  })
  it.each([
    ['visible', false, 'hidden'], ['touchAxis', 'y', 'touch_axis'],
    ['trailingTapBlockedUntil', Number.MAX_SAFE_INTEGER, 'trailing_tap'],
    ['autoFocusIgnoreUntil', Number.MAX_SAFE_INTEGER, 'auto_focus'],
    ['isRest', true, 'rest'], ['paused', true, 'paused'], ['closeMode', 'end', 'close'],
    ['effortOn', true, 'effort'], ['lastOpen', true, 'last'], ['finishOn', true, 'finish'],
  ])('records why %s blocks a dot without changing the cursor', async (field, value, detail) => {
    const { page, s } = workout()
    page[field] = value; page.logInteraction = vi.fn()
    expect(await page.pickSetDot(setDotWindow(s).dots[1])).toBe(false)
    expect(page.logInteraction).toHaveBeenCalledWith('dot_blocked', expect.objectContaining({ detail, status: 'tap', setId: 'r1' }))
    expect(s.setIdx).toBe(0); expect(page.emitEvent).not.toHaveBeenCalled()
  })
  it.each(['persistence_failed', 'storage_failed', 'outbox_full', 'edit_backlog_full'])('records %s without accepting a focus event', async detail => {
    const { page, ctx, s } = workout()
    page.logInteraction = vi.fn()
    ctx.persistenceStatus = () => ({ failed: detail === 'persistence_failed' })
    ctx.storageStatus = () => ({ failed: detail === 'storage_failed' })
    ctx.pendingCount = () => detail === 'outbox_full' ? 256 : 0
    if (detail === 'edit_backlog_full') s.pendingEdits = Array.from({ length: 256 }, () => ({}))
    expect(await page.commitSetDot(setDotWindow(s).dots[1])).toBe(false)
    expect(page.logInteraction).toHaveBeenCalledWith('dot_blocked', expect.objectContaining({ detail, status: 'commit' }))
    expect(s.setIdx).toBe(0); expect(page.emitEvent).not.toHaveBeenCalled()
  })
  it('records local commit contention instead of silently losing the dot action', async () => {
    const { page, s } = workout()
    page.localCommitPending = true; page.logInteraction = vi.fn()
    expect(await page.commitSetDot(setDotWindow(s).dots[1])).toBe(false)
    expect(page.logInteraction).toHaveBeenCalledWith('local_commit_busy', {})
    expect(s.setIdx).toBe(0); expect(page.emitEvent).not.toHaveBeenCalled()
  })
  it('records one queue marker for a rapid batch so following taps can coalesce', async () => {
    vi.useFakeTimers()
    try {
      const { page, s } = workout(), target = setDotWindow(s).dots[1]
      page.logInteraction = vi.fn()
      let result
      for (let i = 0; i < 200; i++) result = page.pickSetDot(target)
      expect(page.logInteraction.mock.calls.filter(([stage]) => stage === 'dot_queued')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(120)
      await result
      expect(s.setIdx).toBe(1)
    } finally { vi.useRealTimers() }
  })
  it('records a target invalidated between the tap and durable commit', async () => {
    const { page, s } = workout(), target = setDotWindow(s).dots[1]
    page.logInteraction = vi.fn(); s.workout.rows[0].splice(1, 1)
    expect(await page.commitSetDot(target)).toBe(false)
    expect(page.logInteraction).toHaveBeenCalledWith('dot_blocked', expect.objectContaining({ detail: 'stale_target', status: 'commit' }))
    expect(page.emitEvent).not.toHaveBeenCalled()
  })
  it('picks unfinished or completed dots, retaining stable IDs', async () => {
    const { page, s } = workout(), dots = setDotWindow(s).dots
    await page.pickSetDot(dots[2]); expect(s.setIdx).toBe(2)
    s.workout.rows[0][1].done = true; await page.pickSetDot(dots[1]); expect(s.setIdx).toBe(1)
    s.workout.rows[0].splice(0, 1); await page.pickSetDot(dots[0]); expect(s.setIdx).toBe(1)
  })
})

function keypad(s = makeState(), params = {}) {
  const h = workout(s)
  h.page.selectField(params.field || 'w'); h.page.selectField(params.field || 'w')
  return h
}
describe('inline official keyboard', () => {
  it('backspaces repetitions, permits weight decimals, and never persists keystrokes', () => {
    const s = makeState(); s.workout.rows[0][0].r = '125'
    const a = keypad(s, { field: 'r' })
    a.page.numberBackspace(); expect(a.page.keypadValue).toBe('12')
    a.page.numberBackspace(); expect(a.page.keypadValue).toBe('1')
    a.page.numberBackspace(); expect(a.page.keypadValue).toBe('—')
    const b = keypad(); b.page.numberKey1(); b.page.numberKeyDot(); b.page.numberKey2()
    expect(b.page.keypadValue).toBe('1.2')
    expect(b.ctx.setRowValue).not.toHaveBeenCalled()
    b.page.saveNumberKeypad(); expect(b.page.weightNum).toBe('1.2')
    expect(b.s.workout.rows[0][0].w).toBe('')
  })
  it('cancel discards the keyboard buffer but preserves an earlier crown draft', () => {
    const { page, s } = workout()
    page.editWeight(); page.onRotation({ delta: 1 }); page.editWeight()
    page.numberKey9(); page.closeNumberKeypad()
    page.updateNumbers(); expect(page.weightNum).toBe('0.5')
    expect(s.workout.rows[0][0].w).toBe('')
  })
  it('blocks swiping through the keyboard and back closes only the keyboard', () => {
    const { page } = keypad()
    page.touchStart({ touches: [{ clientX: 250, clientY: 200 }] })
    page.touchEnd({ changedTouches: [{ clientX: 50, clientY: 200 }] })
    expect(page.pageIndex).toBe(1)
    expect(page.onBackPress()).toBe(true)
    expect(page.keypadOn).toBe(false); expect(page.pageIndex).toBe(1)
  })
  it.each(['sid','unit','deleted','done','paused','rest'])('invalidates an open keyboard on %s changes', reason => {
    const { page, s, ctx } = keypad()
    page.numberKey9()
    if (reason === 'sid') s.sid = 'new'
    if (reason === 'unit') s.weightUnit = 'lb'
    if (reason === 'deleted') s.workout.rows[0].shift()
    if (reason === 'done') s.workout.rows[0][0].done = true
    if (reason === 'paused') s.pausedAt = 1
    if (reason === 'rest') s.restUntil = Date.now() + 30000
    page.saveNumberKeypad()
    expect(page.keypadOn).toBe(false)
    expect(ctx.setRowValue).not.toHaveBeenCalled()
    expect(s.workout.rows[0].some(r => r.w === '9')).toBe(false)
  })
})
