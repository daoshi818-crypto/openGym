import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { rotationStep, valueStep } from '../../../watch-app/src/lib/value-step.js'
import { captureRow, rowTarget, setDotWindow } from '../../../watch-app/src/lib/workout-interaction.js'
import { stripImports, watchSource } from './watch-test-harness.js'
const makeState = (count = 4) => ({ active: true, sid: 's', exIdx: 0, setIdx: 0, weightUnit: 'kg', workout: {
  exercises: [{ entryInstanceId: 'e', name: 'Row' }], rows: [Array.from({ length: count }, (_, i) => ({ setId: 'r' + i, w: '', r: 8, done: false }))] } })
function workout(s = makeState()) {
  const ctx = { Date, rotationStep, valueStep, captureRow, rowTarget, setDotWindow,
    storage: { getSync: () => 0.5 }, loadState: () => s, save: vi.fn(),
    persistenceStatus: () => ({ failed: false }), storageStatus: () => ({ failed: false }), pendingCount: () => 0,
    setRowValue: vi.fn((state, ex, set, field, value) => { state.workout.rows[ex][set][field] = value; state.pendingEdits = [{ eventId: 'original', t: 'weight' }] }),
    router: { push: vi.fn() } }
  runInNewContext(stripImports(watchSource('Workout/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'this.page ='), ctx)
  const page = { ...ctx.page, ...ctx.page.data, state: s }; page.refresh = vi.fn(); page.emitEvent = vi.fn()
  return { page, ctx, s }
}
describe('watch stable targets and step rules', () => {
  it('rejects deleted stable IDs, stale sid and out of range legacy indexes', () => {
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
  it('quantizes decimals, supports zero and caps legal values', () => {
    expect(valueStep('0.1', 'w', 1, 0.2)).toBe('0.3')
    expect(valueStep(0, 'r', -1)).toBe('0')
    expect(valueStep(99999, 'r', 1)).toBe('99999')
    expect(rotationStep({ delta: 50 })).toBe(1)
    expect(rotationStep({ delta: 1, state: 3 })).toBe(0)
  })
})
describe('actual watch workout page wiring', () => {
  it('renders real set targets and pages without moving the cursor', () => {
    const { page, s } = workout(makeState(12))
    page.refreshSetDots()
    expect(page.setDots.map(d => d.number)).toEqual([1, 2, 3, 4, 5])
    expect(page.dotHasNext).toBe(true)
    page.nextDotSegment()
    expect(page.setDots.map(d => d.number)).toEqual([6, 7, 8, 9, 10])
    expect(s.setIdx).toBe(0)
    page.pickSetDot(page.setDots[1])
    expect(s.setIdx).toBe(6)
  })
  it('does not switch sets when no field is selected', () => {
    const { page } = workout(); page.stepSet = vi.fn(); page.onRotation({ delta: 1 })
    expect(page.stepSet).not.toHaveBeenCalled()
  })
  it('selects first, opens editor on second tap, edits through original pending event on crown', () => {
    const { page, ctx } = workout()
    page.editWeight(); expect(ctx.router.push).not.toHaveBeenCalled(); expect(page.selectedField).toBe('w')
    page.onRotation({ delta: 1 })
    expect(ctx.setRowValue).toHaveBeenCalledWith(page.state, 0, 0, 'w', '0.5', true)
    expect(page.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'original' }))
    page.editWeight(); expect(ctx.router.push).toHaveBeenCalledWith(expect.objectContaining({ uri: '/Keypad' }))
  })
  it('stops on stale units, deleted targets, completed rows and pause', () => {
    for (const change of [s => { s.weightUnit = 'lb' }, s => { s.workout.rows[0][0].setId = 'new' }, s => { s.workout.rows[0][0].done = true }, s => { s.pausedAt = 1 }]) {
      const { page, ctx, s } = workout(); page.editWeight(); change(s); page.onRotation({ delta: 1 })
      expect(ctx.setRowValue).not.toHaveBeenCalled()
    }
  })
  it.each(['persistence', 'storage', 'outbox', 'pending edits'])('backpressures %s without deleting accepted edits', reason => {
    const { page, ctx, s } = workout(); page.editWeight()
    s.pendingEdits = Array.from({ length: 256 }, (_, i) => ({ eventId: 'saved-' + i }))
    if (reason !== 'pending edits') s.pendingEdits.length = 3
    ctx.persistenceStatus = () => ({ failed: reason === 'persistence' })
    ctx.storageStatus = () => ({ failed: reason === 'storage' })
    ctx.pendingCount = () => reason === 'outbox' ? 256 : 0
    const before = structuredClone(s.pendingEdits)
    page.onRotation({ delta: 1 })
    expect(ctx.setRowValue).not.toHaveBeenCalled(); expect(s.pendingEdits).toEqual(before)
    expect(page.inputNotice).toContain('同步')
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
    expect(page.pageIndex).toBe(index ? 0 : 1)
  })
  it('picks only unfinished dots, retaining stable IDs', () => {
    const { page, s } = workout(), dots = setDotWindow(s).dots
    page.pickSetDot(dots[2]); expect(s.setIdx).toBe(2)
    s.workout.rows[0][1].done = true; page.pickSetDot(dots[1]); expect(s.setIdx).toBe(2)
    s.workout.rows[0].splice(0, 1); page.pickSetDot(dots[0]); expect(s.setIdx).toBe(2)
  })
})

function keypad(s = makeState(), params = {}) {
  const ctx = { rotationStep, valueStep, rowTarget, loadState: () => s,
    storage: { getSync: () => 0.5 }, setRowValue: vi.fn(), router: { back: vi.fn() } }
  runInNewContext(stripImports(watchSource('Keypad/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'this.page ='), ctx)
  const page = { ...ctx.page, ...ctx.page.data }
  page.onInit({ ...captureRow(s), field: 'w', ...params })
  return { page, ctx, s }
}
describe('actual watch focused editor', () => {
  it('backspaces one repetition digit instead of silently clearing the whole field', () => {
    const s = makeState(); s.workout.rows[0][0].r = '125'
    const { page, ctx } = keypad(s, { field: 'r' })
    page.decimalOrClear(); expect(page.show).toBe('12')
    page.decimalOrClear(); expect(page.show).toBe('1')
    page.decimalOrClear(); expect(page.show).toBe('—')
    expect(ctx.setRowValue).not.toHaveBeenCalled()
  })
  it('keeps the weight decimal key distinct from explicit clear', () => {
    const { page, ctx } = keypad()
    page.onKey1(); page.decimalOrClear(); page.onKey2()
    expect(page.show).toBe('1.2'); expect(ctx.setRowValue).not.toHaveBeenCalled()
  })
  it('does not write an empty field on unchanged Save or cancel', () => {
    const a = keypad(); a.page.commit(); expect(a.ctx.setRowValue).not.toHaveBeenCalled()
    const b = keypad(); b.page.plus(); b.page.onCancel(); expect(b.ctx.setRowValue).not.toHaveBeenCalled()
  })
  it('shares draft across quick and keyboard, writes only on explicit Save', () => {
    const { page, ctx, s } = keypad(); page.plus(); page.useKeyboard(); page.useQuick()
    expect(page.show).toBe('0.5'); expect(ctx.setRowValue).not.toHaveBeenCalled()
    page.commit(); expect(ctx.setRowValue).toHaveBeenCalledWith(s, 0, 0, 'w', '0.5', true)
  })
  it('rejects deleted stable identity instead of applying to the new neighbour', () => {
    const { page, ctx, s } = keypad(); page.plus(); s.workout.rows[0].shift(); page.commit()
    expect(ctx.setRowValue).not.toHaveBeenCalled(); expect(page.notice).toBeTruthy()
  })
  it('uses captured sid, even when shared runtime state mutates', () => {
    const { page, ctx, s } = keypad(); page.plus(); s.sid = 'new'; page.commit()
    expect(ctx.setRowValue).not.toHaveBeenCalled()
  })
  it('uses captured units when converting the draft after an incoming unit change', () => {
    const s = makeState(); s.workout.rows[0][0].w = 10
    const { page, ctx } = keypad(s); page.plus(); s.weightUnit = 'lb'; page.commit()
    expect(Number(ctx.setRowValue.mock.calls[0][4])).toBeCloseTo(23.149, 3)
  })
  it.each(['done', 'paused', 'rest'])('rejects a target that became %s while editing', reason => {
    const { page, ctx, s } = keypad(); page.plus()
    if (reason === 'done') s.workout.rows[0][0].done = true
    if (reason === 'paused') s.pausedAt = 1
    if (reason === 'rest') s.restUntil = Date.now() + 30000
    page.commit(); expect(ctx.setRowValue).not.toHaveBeenCalled()
  })
})
