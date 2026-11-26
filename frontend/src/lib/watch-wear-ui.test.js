// @vitest-environment node
// v1.4.4 Wear OS 界面迁移：新增的页面状态字段必须有真实回归，而不是只看代码。
// 这些用例把真实的 .ux <script> 块放进 VM 里跑（与 watch-effort.test.js 同一手法），所以它们
// 同时证明改版没有切断 session/protocol/rpc 的调用链，也没有破坏 RPE/RIR 的入口。
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { applyEdit, applyRest, restOf, applyFocus } from '../../../watch-app/src/lib/protocol.js'
import { loadWatchModule, watchPersistence, watchInteractionDeps } from './watch-test-harness.js'
import { effortScaleOf, effortValueOf, effortKindOf, stepEffortValue, effortMeaning, effortSummaryText, formatEffort } from '../../../watch-app/src/lib/effort-scale.js'

const source = path => readFileSync(new URL('../../../watch-app/src/' + path, import.meta.url), 'utf8')
const imports = /^import[\s\S]*?from ['"][^'"]+['"]\r?$/gm

function page(path, deps) {
  const script = source(path).match(/<script>([\s\S]*?)<\/script>/)[1]
  const context = { ...watchInteractionDeps, phoneConflict: () => null, setInterval: () => 1, clearInterval() {}, console, WATCH_VERSION: 'test-watch', applyEdit, applyRest, restOf, applyFocus,
    persistenceStatus: () => ({}), storageStatus: () => ({}), synchronizationStatus: () => ({}),
    storage: { getSync: () => null, set() {} },
    effortScaleOf, effortValueOf, effortKindOf, stepEffortValue, effortMeaning, effortSummaryText, formatEffort,
    replacePlan() {}, ...deps }
  runInNewContext(script.replace(imports, '').replace('export default', 'this.page ='), context)
  return { ...context.page, ...context.page.data }
}

// ---- Index: idle phone prompt and continuation of already-stored workouts ----
describe('Index 启动页（官方 IdleScreen 映射）', () => {
  const indexPage = (active = { active: false }) => {
    const callbacks = {}, storage = { getSync: vi.fn(() => null) }
    const router = { replace: vi.fn(), push: vi.fn() }
    const page_ = page('Index/index.ux', {
      loadState: () => active, storage, isPhoneConnected: () => false,
      startServer: cbs => Object.assign(callbacks, cbs), router,
    })
    page_.onInit()
    return { page: page_, router, storage, callbacks }
  }

  it('待机显示手机提示、无计划列表，连接状态变化不会进入训练', () => {
    const { page: p, router, storage, callbacks } = indexPage()
    expect(source('Index/index.ux')).toContain('请打开手机端的 OpenGym')
    expect(storage.getSync).not.toHaveBeenCalledWith({ key: 'plan_catalog' })
    expect(callbacks).not.toHaveProperty('onCatalog')
    expect(p.canResume).toBe(false)
    p.onReady(); callbacks.onState(true)
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('本地有活动训练时离线也能恢复', () => {
    const active = { active: true, pendingStart: true, workout: { name: '推日', exercises: [{ name: '卧推' }], rows: [[{}, {}]] } }
    const { page: p, router } = indexPage(active)
    expect(p.canResume).toBe(true)
    expect(p.workoutName).toBe('推日')
    expect(p.exerciseCount).toBe(1)
    expect(p.setCount).toBe(2)
    expect(p.status).toBe('离线训练 · 待同步')
    p.onReady()
    expect(router.replace).toHaveBeenCalledExactlyOnceWith({ uri: '/Workout' })
  })
})

// ---- ExerciseList: 动作进度 / 当前动作高亮 / 放弃二次确认 -------------------
describe('ExerciseList 动作总览（官方 OverviewScreen 映射）', () => {
  const sessionState = () => ({
    active: true, sid: 's1', exIdx: 1, weightUnit: 'kg',
    workout: {
      name: '推日',
      exercises: [
        { name: '卧推', entryInstanceId: 'e1', sets: 2, reps: '8' },
        { name: '划船', entryInstanceId: 'e2', sets: 1, reps: '10' },
      ],
      rows: [
        [{ w: 60, r: 8, done: true, setId: 'a1' }, { w: 60, r: 8, done: false, setId: 'a2' }],
        [{ w: 50, r: 10, done: false, setId: 'b1' }],
      ],
    },
  })

  const listPage = () => {
    const state = sessionState(), shared = {}
    const sendEvent = vi.fn()
    const router = { back: vi.fn(), replace: vi.fn(), push: vi.fn() }
    const p = page('ExerciseList/index.ux', {
      loadState: () => state, save: vi.fn(), commitLocalClose: async (sid, disposition) => ({ok:true, entry:{closeEvent:{t:'session_close',sid,disposition}}}), endSession: vi.fn(), closeSession: vi.fn(), sendEvent,
      router, runtime: () => shared,
    })
    p.onInit()
    return { p, sendEvent, state, router, shared }
  }

  it('每个动作显示已完成/总数，并高亮当前动作', async () => {
    const { p } = listPage()
    expect(p.trainName).toBe('推日')
    expect(p.list.map(x => [x.name, x.doneCount, x.totalCount, x.current])).toEqual([
      ['卧推', 1, 2, false],
      ['划船', 0, 1, true],
    ])
  })

  it('放弃训练第一次只进入二次确认，第二次才真的放弃', async () => {
    const { p, sendEvent } = listPage()
    await p.abandonWorkout()
    expect(p.abandonArmed).toBe(true)
    expect(p.hint).toContain('再次点击')
    expect(sendEvent).not.toHaveBeenCalled()
    await p.abandonWorkout()
    expect(p.abandonArmed).toBe(false)
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({ t: 'session_close', disposition: 'abandoned' }))
  })

  it('保存入口回到统一结束确认，不在列表直接关闭会话', async () => {
    const { p, sendEvent, router, shared, state } = listPage()
    p.saveWorkout()
    expect(sendEvent).not.toHaveBeenCalled()
    expect(router.back).toHaveBeenCalledOnce()
    expect(shared.finishRequest).toEqual({ sid: state.sid })
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('从结束区返回会清掉二次确认状态', async () => {
    const { p } = listPage()
    p.endOn = true
    await p.abandonWorkout()
    expect(p.abandonArmed).toBe(true)
    p.backToExercises()
    expect(p.endOn).toBe(false)
    expect(p.abandonArmed).toBe(false)
  })
})

// ---- Workout: 只刷新实际展示的倒计时 -------------------------------------
describe('Workout 休息页（官方 RestScreen 映射）', () => {
  const session = () => {
    const { disk, ctx } = watchPersistence()
    Object.assign(ctx, { console, Date, applyEdit, applyRest })
    loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
    loadWatchModule('close-journal', ctx, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
    loadWatchModule('session', ctx, ['loadState', 'startSession', 'save', 'replacePlan', 'applySync', 'nextUndone', 'nextUndoneFrom',
      'setRowValue', 'toggleSet', 'setEffort', 'addSet', 'removeSet', 'addRestTime', 'calories', 'endSession', 'closeSession'])
    return { ...ctx, disk }
  }

  const setup = () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-24T09:00:00Z'))
    const sessions = session()
    const sendEvent = vi.fn()
    sessions.startSession({ sid: 's1', name: 'Bench', effortScale: 'rpe', weightUnit: 'kg', profile: { bodyWeightKg: 80 },
      exercises: [{ name: 'Bench', entryInstanceId: 'e1', setIds: ['a1', 'a2'], sets: 2, reps: '8', weight: '60', restSec: 90 }] })
    const workout = page('Workout/index.ux', { ...sessions, startServer() {}, sendControl: vi.fn(), sendEvent,
      router: { push: vi.fn(), replace: vi.fn() }, startSessionHr() {}, stopSessionHr() {}, restOver: vi.fn(), tick() {},
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, pendingCount: () => 0, isConnected: () => true,
      brightness: { setKeepScreenOn: vi.fn() } })
    workout.onInit(); workout.onReady()
    return { sessions, workout, sendEvent }
  }

  it('休息中按实际截止时间显示倒计时，不计算未展示的百分比', async () => {
    const { workout } = setup()
    await workout.onCurrentSetAction()
    vi.advanceTimersByTime(1000)
    workout.tickClock()
    expect(workout.restLabel).toBe('1:29')
    expect(workout.restPctLabel).toBeUndefined()
  })

  it('页面隐藏时跳过响应式刷新，重新显示后恢复刷新', async () => {
    const { workout } = setup()
    workout.visible = false
    workout.weightNum = '保留值'
    workout.stateOf().workout.rows[0][0].w = '72.5'
    workout.refresh()
    expect(workout.weightNum).toBe('保留值')
    expect(workout.needsRefresh).toBe(true)

    workout.visible = true
    workout.refresh()
    expect(workout.weightNum).toBe('72.5')
    expect(workout.needsRefresh).toBe(false)
  })
  it('休息结束后倒计时归零', async () => {
    const { workout } = setup()
    await workout.onCurrentSetAction()
    workout.state.restUntil = 0
    workout.tickClock()
    expect(workout.restLabel).toBe('0:00')
  })

  it('休息页的评分入口仍然指向刚完成的那一组（不是下一组）', async () => {
    const { workout } = setup()
    await workout.onCurrentSetAction()
    expect(workout.effortEntryOn).toBe(true)
    // 目标 = 刚完成组 a1，而不是焦点所在的下一组 a2。
    expect(workout.effortTarget.setId).toBe('a1')
  })
})
