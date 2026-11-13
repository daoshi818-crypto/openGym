// @vitest-environment node
import { describe, expect, it } from 'vitest'
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

describe('GT1 complete-screen rebuild contracts', () => {
  function cssSize(page, selector, field) {
    const css = watchSource(page + '/index.ux').match(/<style>([\s\S]*?)<\/style>/)[1]
    const rule = css.match(new RegExp('\\.' + selector + '\\s*\\{([^}]+)\\}'))?.[1] || ''
    return Number(rule.match(new RegExp('(?:^|[;\\s])' + field + ':\\s*([\\d.]+)px'))?.[1] || 0)
  }
  it('keeps completed-set guidance inline instead of pushing dots below the viewport', () => {
    const src = watchSource('Workout/index.ux')
    expect(src).not.toContain('class="undo-label"')
    expect(src).toContain('已完成 · 可撤回')
    const h = (s, p='height') => cssSize('Workout',s,p)
    expect(h('topbar')+h('topbar','margin-top')+h('primary-footer')+h('primary-footer','margin-bottom')+
      ['ex','group','inputs','last-row','navrow'].reduce((n,s)=>n+h(s),0)+h('set-dots','min-height')).toBeLessThanOrEqual(450)
  })
  it('keeps quick adjustment and all twelve keyboard targets on a fixed screen', () => {
    const h = (s,p='height') => cssSize('Keypad',s,p)
    for (const s of ['k','keyboard-switch']) expect(h(s)).toBeGreaterThanOrEqual(44)
    for (const s of ['cancel','ok']) expect(h(s)).toBeGreaterThanOrEqual(56)
    const root = sourceTemplate(watchSource('Keypad/index.ux'))
    const nodes = n => [n, ...(n.children || []).flatMap(nodes)]
    expect(root.children.map(n => n.class)).toEqual(['editor-content', 'actions'])
    expect(nodes(root).some(n => n.type === 'list')).toBe(false)
    expect(nodes(root).filter(n => (n.class || '').split(' ').includes('k'))).toHaveLength(12)
    expect(h('label','margin-top') + h('label') + h('keyboard-target') + h('keyboard-value') +
      h('grid') + h('keyboard-switch') + h('actions','margin-top') + h('actions') + h('actions','margin-bottom')).toBeLessThanOrEqual(450)
    expect(watchSource('Keypad/index.ux')).toContain('notice ||')
  })
  it('reserves number ascender headroom and full unit lines inside bordered fields', () => {
    const css = watchSource('Workout/index.ux').match(/<style>([\s\S]*?)<\/style>/)[1]
    const round = css.split('@media')[1]
    const override = (selector, field, fallback) => {
      const rules = [...round.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter(m => m[1].split(',').map(s=>s.trim()).includes('.'+selector))
      const last = rules.flatMap(m => [...m[2].matchAll(new RegExp('(?:^|[;\\s])'+field+':\\s*([\\d.]+)px','g'))]).at(-1)
      return last ? Number(last[1]) : fallback
    }
    for (const isRound of [false,true]) {
      const h = (s,p='height') => isRound ? override(s,p,cssSize('Workout',s,p)) : cssSize('Workout',s,p)
      expect(h('fval')).toBeGreaterThanOrEqual(h('fval','font-size')+8)
      expect(h('funit')).toBeGreaterThanOrEqual(1.35*h('funit','font-size'))
      expect(h('funit','line-height')).toBe(h('funit'))
      expect(h('fval')+h('funit')+2).toBeLessThanOrEqual(h('field'))
    }
  })
  it('uses only a bundled vector for complete, undo and pause inside the primary button', () => {
    const root = sourceTemplate(watchSource('Workout/index.ux'))
    const nodes = n => [n, ...(n.children || []).flatMap(nodes)]
    const button = nodes(root).find(n => n.action === 'onCurrentSetAction')
    expect(button.children.map(n => n.type)).toEqual(['image'])
    expect(button.children[0].attr.$src).toContain('/common/icons/undo.svg')
    expect(cssSize('Workout','complete','width')).toBeGreaterThanOrEqual(64)
  })
  it('keeps large home cards and recent results in one native scroll viewport', () => {
    const h = (s,p='height') => cssSize('Index',s,p)
    expect(watchSource('Index/index.ux')).toContain('<list class="home-scroll">')
    expect(watchSource('Index/index.ux')).not.toContain('<list class="plans')
    expect(h('plan-name')).toBeGreaterThanOrEqual(48)
    expect(h('plan-preview')).toBeGreaterThanOrEqual(44)
  })
  it('filters home plans through the repeat expression without combining native for and if', () => {
    const root = sourceTemplate(watchSource('Index/index.ux'))
    const nodes = n => [n, ...(n.children || []).flatMap(nodes)]
    const plan = nodes(root).find(n => n.repeat?.value === 'p')
    expect(plan.$shown).toBeUndefined()
    const value = ctx => runInNewContext('('+plan.repeat.$exp+')', {}).call(ctx)
    expect(value({canResume:true,plans:[{id:'a'}]})).toEqual([])
    expect(value({canResume:false,plans:[{id:'a'}]})).toEqual([{id:'a'}])
  })
  it('never mounts a scroll container on current-set or rest training screens', () => {
    const tree = sourceTemplate(watchSource('Workout/index.ux'))
    const nodes = n => [n, ...(n.children || []).flatMap(nodes)]
    const main = tree.children.find(n => n.class === 'screen')
    expect(nodes(main).some(n => n.type === 'list')).toBe(false)
    expect(nodes(main).some(n => n.action === 'openLast')).toBe(true)
    expect(cssSize('Workout','set-hit','width')).toBeGreaterThanOrEqual(48)
    expect(cssSize('Workout','complete','height')).toBeGreaterThanOrEqual(64)
  })
  it('bounds five large dot targets including arrows while keeping row identity', () => {
    const rows = Array.from({length: 20}, (_,i) => ({setId:'r'+i})), s = {active:true,sid:'s',exIdx:0,setIdx:7,workout:{exercises:[{entryInstanceId:'e'}],rows:[rows]}}
    const view = setDotWindow(s, undefined, 5)
    expect(view.segmented).toBe(true); expect(view.dots).toHaveLength(3)
    expect(view.dots[1]).toMatchObject({setId:'r7',current:true,setIdx:7})
    expect((view.dots.length+2)*48).toBeLessThanOrEqual(300)
  })
  it.each(['Index','Workout','Keypad','ExerciseList','Summary'])('%s has a full viewport, not the former fixed safe-area shell', name => {
    const src = watchSource(name + '/index.ux'), css = src.match(/<style>([\s\S]*?)<\/style>/)[1]
    const root = css.match(/\.page\s*\{([^}]+)\}/)[1]
    expect(root).toContain('width: 100%'); expect(root).toContain('height: 100%')
    expect(root).not.toMatch(/padding|margin|top:|left:/)
    if (name === 'Keypad') expect(src).not.toContain('<list ')
    else expect(src).toContain('<list ')
    for (const wrapper of ['screen','content']) {
      const rules = css.match(new RegExp('\\.' + wrapper + '\\s*\\{([^}]+)\\}'))
      if (rules) { expect(rules[1]).toContain('width: 100%'); expect(rules[1]).toContain('height: 100%') }
    }
  })
  it.each(['rpe','rir','none'])('initial render handles %s scale without opening the picker', scale => {
    const { p } = training(scale)
    expect(p.effortScaleLabel).toBe(scale === 'none' ? '' : scale.toUpperCase())
    expect(p.effortEntryOn).toBe(scale !== 'none')
    expect(p.effortOn).toBe(false)
  })
  it('shows RIR zero and preserves its identity during rest', () => {
    const { p, s, ctx } = training('rir')
    Object.assign(s.workout.rows[0][0], { done: true, at: Date.now(), effortKind: 'rir', rir: 0 })
    s.setIdx = 1; s.restUntil = Date.now() + 90000; ctx.save(s); p.state = s; p.refresh()
    expect(p.effortEntryText).toBe('RIR 0'); expect(p.effortNumber).toBe('0')
    expect(p.effortTarget.setId).toBe(s.workout.rows[0][0].setId)
    expect(p.nextSetLabel).toBe('第 2 / 4 组')
  })
  it('return from operations does not switch or complete a set', () => {
    const { p, s } = training('none'), before = JSON.stringify(s.workout.rows)
    p.pageIndex = 1; p.showCurrent()
    expect(p.pageIndex).toBe(0); expect(JSON.stringify(s.workout.rows)).toBe(before)
  })
  it('renders small unlabelled set dots, not numbered completion buttons', () => {
    const src = watchSource('Workout/index.ux')
    expect(src).toContain('onclick="pickSetDot(item)"')
    expect(src).not.toContain('{{ item.number }}')
    expect(src).toMatch(/class="set-dot [\s\S]*?<\/div>/)
    expect(src).toContain('onclick="openExercises">{{ exName }}')
  })
  it.each(['Index','Workout','Keypad','ExerciseList','Summary'])('%s keeps corner-adjacent controls inside conservative GT1 insets', name => {
    const header = { Index: 'topbar', Workout: 'topbar', Keypad: 'label', ExerciseList: 'title', Summary: 'top' }[name]
    expect(cssSize(name, header, 'margin-top')).toBeGreaterThanOrEqual(18)
    expect(cssSize(name, header, 'width')).toBeLessThanOrEqual(314)
  })
  it('draws primary actions with bundled vectors instead of text or font glyphs', () => {
    const home = watchSource('Index/index.ux'), workout = watchSource('Workout/index.ux')
    expect(home).toContain('src="/common/icons/play.svg"')
    expect(home).not.toMatch(/class="start-circle"[^>]*value=/)
    expect(workout).toContain("paused ? '/common/icons/pause.svg' : rowDone ? '/common/icons/undo.svg' : '/common/icons/check.svg'")
    expect(workout).toContain('src="/common/icons/back.svg"')
    expect(workout).not.toMatch(/class="complete[^>]*value=/)
    expect(watchSource('Summary/index.ux')).toContain('src="/common/icons/check.svg"')
    for (const name of ['play','check','undo','pause','back','backspace']) {
      const svg = watchSource('common/icons/' + name + '.svg')
      expect(svg).toContain('viewBox="0 0 48 48"')
      expect(svg).toMatch(/<(path|rect|polyline)\b/)
      expect(svg).not.toMatch(/<(script|text|image|foreignObject)\b|href=|url\(/i)
    }
  })
  it('does not depend on emoji or ambiguous icon glyphs anywhere in watch UI sources', () => {
    const root = new URL('../../../watch-app/src/', import.meta.url)
    const sources = readdirSync(root, { recursive: true }).filter(name => /\.(ux|js|json)$/.test(name))
    for (const name of sources) {
      expect(watchSource(name), name).not.toMatch(/[\p{Extended_Pictographic}\uFE0F✓▶♥↶]/u)
    }
  })
  it('removes all frame transport/player entry points, not just hiding the button', () => {
    const removed = ['watch-app/src/lib/watch-media.js','watch-app/src/lib/media-client.js','watch-app/src/lib/media-format.js',
      'frontend/src/lib/watch-media.js','frontend/android/app/src/main/java/ch/duartesantos/opengym/WatchMediaPlugin.java']
    const repo = new URL('../../../', import.meta.url)
    for (const name of removed) expect(existsSync(new URL(name, repo)), name).toBe(false)
    for (const name of ['frontend/src/lib/watch-link.js','frontend/src/lib/watch-workout.js',
      'watch-app/src/lib/rpc.js','watch-app/src/Workout/index.ux',
      'frontend/android/app/src/main/java/ch/duartesantos/opengym/MainActivity.java']) {
      expect(readFileSync(new URL(name, repo), 'utf8')).not.toMatch(/WatchMedia|watch-media|mediaRef|media_request|media_chunk|openDemo/)
    }
    expect(watchSource('manifest.json')).not.toContain('blueos.storage.file')
  })
})


it('exposes abandon on workout operations and finish with a separate confirmation', () => {
  const src = watchSource('Workout/index.ux')
  expect(src.match(/value="放弃训练" onclick="askAbandon"/g)).toHaveLength(2)
  expect(src).toContain("closeMode === 'abandon'")
  expect(src).toContain('value="确认放弃" onclick="abandonEnd"')
  expect(src).toContain('class="finish-scroll"')
})
