// @vitest-environment node
import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { watchSource, stripImports, watchInteractionDeps, watchPersistence, loadWatchModule } from './watch-test-harness.js'
import * as effort from '../../../watch-app/src/lib/effort-scale.js'
import * as protocol from '../../../watch-app/src/lib/protocol.js'
import { lastTimeView } from '../../../watch-app/src/lib/watch-last-time.js'
import { sourceTemplate } from '../../../watch-app/scripts/source-template.mjs'
import { setDotWindow } from '../../../watch-app/src/lib/workout-interaction.js'

function training(scale) {
  const { ctx } = watchPersistence()
  Object.assign(ctx, { ...protocol, console, Date })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('session', ctx, ['loadState', 'save', 'startSession', 'nextUndone', 'calories'])
  const s = ctx.startSession({ sid: 'gt1', name: '推日', exercises: [{ entryInstanceId: 'e', name: '卧推', sets: 4, reps: '8', weight: '62.5' }] })
  s.effortScale = scale; ctx.save(s)
  Object.assign(ctx, watchInteractionDeps, effort, { lastTimeView,
    startServer() {}, sendEvent() {}, pendingCount: () => 0, isConnected: () => true,
    persistenceStatus: () => ({}), synchronizationStatus: () => ({}),
    startSessionHr() {}, stopSessionHr() {}, tick() {}, restOver() {},
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    router: { push() {}, replace() {} }, brightness: {} })
  runInNewContext(stripImports(watchSource('Workout/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default', 'this.page ='), ctx)
  const p = Object.assign(ctx.page, ctx.page.data)
  p.onInit({})
  return { p, s, ctx }
}

const nodes = n => [n, ...(n.children || []).flatMap(nodes)]
const tree = page => sourceTemplate(watchSource(page + '/index.ux'))
const css = page => watchSource(page + '/index.ux').match(/<style>([\s\S]*?)<\/style>/)[1]
afterEach(() => vi.useRealTimers())
describe('v1.4.5 official square Wear UI contracts', () => {
  it.each(['Index','Workout','ExerciseList','Summary'])('%s keeps a full viewport', name => {
    expect(css(name)).toMatch(/\.page\s*\{[^}]*width: 100%;[^}]*height: 100%;/)
    expect(css(name)).toContain('background-color: #000000')
    expect(watchSource(name + '/index.ux')).not.toContain('#30D158')
  })
  it('uses the source accent, surfaces and transparent-tint composite', () => {
    const c = css('Workout')
    for (const token of ['#A3E635','#0C0E12','#1C1C1E','#2C2C2E','#1A2508','#FFD60A','#FF453A']) expect(c).toContain(token)
    expect(c).toContain('.primary-button { width: 220px; height: 64px') // Fit 390×450; retain official capsule.
  })
  it('replaces the circular primary with arrow / capsule / arrow', () => {
    const nav = nodes(tree('Workout')).find(n => n.class === 'navrow')
    expect(nav.children.map(n => n.class)).toEqual(['arrow-button','primary-button','arrow-button'])
    expect(nav.children[1].children.map(n => n.type)).toEqual(['image','text'])
    expect(nav.children[1].action).toBe('onCurrentSetAction')
    expect(watchSource('Workout/index.ux')).not.toContain('class="set-dots"')
  })
  it('keeps training and rest on one fixed page and lets Overview scroll natively', () => {
    const all = nodes(tree('Workout'))
    const live = all.find(n => n.class === 'screen live-screen')
    expect(nodes(live).some(n => n.type === 'list')).toBe(false)
    expect(all.some(n => n.class === 'overview-scroll' && n.type === 'list')).toBe(true)
  })
  it('has the official twelve-key layout, backspace, cancel arrow and save glyph', () => {
    const all = nodes(nodes(tree('Workout')).find(n => n.class === 'number-keypad'))
    expect(all.some(n => n.type === 'list')).toBe(false)
    const rows = all.filter(n => n.class === 'num-key-row')
    expect(rows).toHaveLength(4); expect(rows.every(n => n.children.length === 3)).toBe(true)
    expect(all.some(n => n.action === 'numberBackspace')).toBe(true)
    expect(all.some(n => n.action === 'closeNumberKeypad')).toBe(true)
    expect(all.some(n => n.action === 'saveNumberKeypad')).toBe(true)
    expect(css('Workout')).toContain('border-radius: 14px') // 9dp
  })
  it('uses TodayCard and the official barbell mark without an invented start circle', () => {
    const src = watchSource('Index/index.ux')
    expect(src).toContain('class="stats"'); expect(src).toContain('class="primary"')
    expect(src).not.toContain('start-circle')
    expect(src).toContain('/common/icons/wear-logo.svg')
    expect(watchSource('common/icons/wear-logo.svg')).toContain('viewBox="0 0 352 174"')
  })
  it('matches the official rest action order and rates the exact source shortcuts', () => {
    const row = nodes(tree('Workout')).find(n => n.class === 'rrow')
    expect(row.children.map(n => n.action)).toEqual(['onRestMinus','onSkipRest','onRestPlus'])
    const { p } = training('rpe')
    expect(p.effortChips.map(c => c.label)).toEqual(['10','9','8','≤7'])
    const { p:rir } = training('rir')
    expect(rir.effortChips.map(c => c.label)).toEqual(['0','1','2','3+'])
  })
  it.each(['rpe','rir','none'])('preserves real %s selection and never opens the picker on entry', scale => {
    const { p } = training(scale)
    expect(p.effortScaleLabel).toBe(scale === 'none' ? '' : scale.toUpperCase())
    expect(p.effortEntryOn).toBe(scale !== 'none'); expect(p.effortOn).toBe(false)
  })
  it('preserves RIR zero and the completed-row identity during rest', () => {
    const { p,s,ctx } = training('rir')
    Object.assign(s.workout.rows[0][0], {done:true,at:Date.now(),effortKind:'rir',rir:0})
    s.setIdx=1; s.restUntil=Date.now()+90000; ctx.save(s); p.state=s; p.refresh()
    expect(p.effortNumber).toBe('0'); expect(p.effortTarget.setId).toBe(s.workout.rows[0][0].setId)
  })
  it('navigates Overview / Set / Metrics with music removed without mutating the workout', () => {
    const {p,s}=training('none'), before=JSON.stringify(s.workout)
    const swipe = dx => { p.touchStart({touches:[{clientX:180,clientY:180}]}); p.touchEnd({changedTouches:[{clientX:180+dx,clientY:180}]}) }
    expect(p.pageIndex).toBe(1); swipe(100); expect(p.pageIndex).toBe(0)
    swipe(-100); swipe(-100); expect(p.pageIndex).toBe(2); swipe(-100); expect(p.pageIndex).toBe(2)
    swipe(-100); expect(p.pageIndex).toBe(2); expect(JSON.stringify(s.workout)).toBe(before)
    p.showCurrent(); expect(p.pageIndex).toBe(1)
  })
  it('conditionally exposes Pulse/Zones and returns to numbers when HR becomes available', () => {
    const {p}=training('none')
    expect(p.metricPages.map(x=>x.key)).toEqual(['numbers','effort','muscles'])
    p.stepMetrics(1); expect(p.metricKind).toBe('effort')
    p.updateMetricPages(true)
    expect(p.metricPages.map(x=>x.key)).toEqual(['numbers','pulse','effort','zones','muscles'])
    expect(p.metricKind).toBe('numbers')
  })
  it('defers persisted downlinks behind another page instead of rebuilding hidden UI', () => {
    const {p}=training('none'); p.visible=false; p.refresh=vi.fn(); p.adoptSession=vi.fn()
    expect(p.onSyncUpdate({sid:p.state.sid,exercises:[]},{persisted:true}).deferred).toBe(true)
    expect(p.refresh).not.toHaveBeenCalled(); expect(p.adoptSession).not.toHaveBeenCalled()
  })
  it('ignores hidden and finished crown events before Metrics navigation', () => {
    const {p}=training('none'); p.pageIndex=2; p.visible=false
    p.onRotation({delta:1}); expect(p.metricIndex).toBe(0)
    p.visible=true; p.onRotation({delta:1,state:3}); expect(p.metricIndex).toBe(0)
    p.onRotation({delta:1}); expect(p.metricKind).toBe('effort')
  })
  it('resumes from the paused primary without completing or undoing a row', () => {
    const {p}=training('none'); p.paused=true; p.onPause=vi.fn(); p.onComplete=vi.fn(); p.onUndo=vi.fn()
    p.onCurrentSetAction(); expect(p.onPause).toHaveBeenCalledOnce()
    expect(p.onComplete).not.toHaveBeenCalled(); expect(p.onUndo).not.toHaveBeenCalled()
  })
  it('shows the true next set number across exercise boundaries without extra Overview actions', () => {
    const {p,s}=training('rpe'); s.workout.rows[0].forEach(r=>{r.done=true;r.at=Date.now()})
    s.setIdx=3; s.workout.exercises.push({entryInstanceId:'b',name:'划船'})
    s.workout.rows.push([{setId:'b1',done:false}]); p.state=s; p.updateOfficialViews()
    expect(p.nextOfficial).toBe('划船，第 1 组')
    expect(nodes(tree('Workout')).some(n=>n.action==='openLastEffort')).toBe(false)
  })
  it('holds Finish for one second, cancels early release, and clears the timer on hide', () => {
    vi.useFakeTimers(); const {p,ctx}=training('none')
    Object.assign(ctx,{setInterval,clearInterval,setTimeout,clearTimeout}); p.saveEnd=vi.fn()
    p.startFinishHold(); vi.advanceTimersByTime(950); p.cancelFinishHold(); vi.advanceTimersByTime(1000)
    expect(p.saveEnd).not.toHaveBeenCalled()
    p.startFinishHold(); vi.advanceTimersByTime(1000); expect(p.saveEnd).toHaveBeenCalledTimes(1)
    p.startFinishHold(); p.onHide(); expect(p.finishHoldTimer).toBeNull()
  })
  it('resolves Overview jumps inside an atomic transaction using entry identity', async () => {
    const {p,ctx}=training('none'); ctx.replayPendingEvents=()=>{}
    const s=ctx.loadState(); s.workout.exercises.push({entryInstanceId:'row',name:'划船',sets:1,reps:'10'})
    s.workout.rows.push([{setId:'row-1',w:'30',r:'10',done:false}]);ctx.save(s);p.state=ctx.loadState();p.refresh()
    await p.jumpOverview(p.overviewRows[1])
    expect(ctx.loadState().exIdx).toBe(1);expect(p.pageIndex).toBe(1)
    expect(ctx.loadState().pendingEdits.at(-1)).toMatchObject({t:'focus',entryInstanceId:'row',setId:'row-1'})
  })
  it('bundles source-derived vectors without image scripts, fonts or external links', () => {
    const names=readdirSync(new URL('../../../watch-app/src/common/icons/',import.meta.url)).filter(n=>n.startsWith('wear-'))
    expect(names.length).toBeGreaterThan(10)
    for(const name of names) expect(watchSource('common/icons/'+name)).not.toMatch(/<(script|text|image|foreignObject)\b|href=|url\(/i)
    for(const page of ['Index','Workout','ExerciseList','Summary']) expect(watchSource(page+'/index.ux')).not.toMatch(/[\p{Extended_Pictographic}\uFE0F✓▶♥↶]/u)
  })
  it('retains discard confirmation and effort while removing non-upstream Overview actions', () => {
    const src=watchSource('Workout/index.ux')
    for(const action of ['askAbandon','abandonEnd','openExercises','openEffort','confirmEffort','clearEffort']) expect(src).toContain('onclick="'+action+'"')
    expect(src).toContain("closeMode === 'abandon'")
    for (const action of ['openLastEffort','onMenuAddSet','onMenuRemoveSet','onPause','openLast']) expect(src).not.toContain('onclick="'+action+'"')
    expect(src).not.toContain('class="flag"')
  })
})
