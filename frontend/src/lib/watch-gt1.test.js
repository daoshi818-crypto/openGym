// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { watchSource, stripImports, watchInteractionDeps, watchPersistence, loadWatchModule } from './watch-test-harness.js'
import * as effort from '../../../watch-app/src/lib/effort-scale.js'
import * as protocol from '../../../watch-app/src/lib/protocol.js'
import { lastTimeView } from '../../../watch-app/src/lib/watch-last-time.js'

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
    expect(src).toContain('已完成 · 点撤销恢复')
    const h = (s, p='height') => cssSize('Workout',s,p)
    expect(h('topbar')+h('topbar','margin-top')+h('primary-footer')+h('primary-footer','margin-bottom')+
      ['ex','group','inputs','last-row','navrow'].reduce((n,s)=>n+h(s),0)+h('set-dots','min-height')).toBeLessThanOrEqual(450)
  })
  it('fits the entire precise keyboard and keeps every key at least 44px', () => {
    const h = (s,p='height') => cssSize('Keypad',s,p)
    expect(h('keyboard-label','margin-top')+h('keyboard-label')+h('keyboard-target')+h('keyboard-value')+
      4*(h('k')+h('k','margin-bottom'))+h('keyboard-switch')+h('keyboard-actions')+
      h('keyboard-actions','margin-top')+h('keyboard-content','padding-bottom')).toBeLessThanOrEqual(450)
    for (const s of ['k','keyboard-action','keyboard-switch']) expect(h(s)).toBeGreaterThanOrEqual(44)
    expect(watchSource('Keypad/index.ux')).toContain('notice ||')
  })
  it('reserves a whole two-line plan card above the recent-results footer', () => {
    const h = (s,p='height') => cssSize('Index',s,p)
    const fixed=h('topbar')+h('topbar','margin-top')+h('status')+h('hero')+h('links')+h('links','margin-bottom')+h('plans','margin-bottom')
    const card=h('plan-name')+h('plan-preview')+2*h('plan','padding')+h('plan','margin-bottom')
    expect(fixed+card).toBeLessThanOrEqual(450)
    expect(h('plan-name')).toBeGreaterThanOrEqual(48)
    expect(h('plan-preview')).toBeGreaterThanOrEqual(44)
  })
  it.each(['Index','Workout','Keypad','ExerciseList','Summary'])('%s has a full viewport, not the former fixed safe-area shell', name => {
    const src = watchSource(name + '/index.ux'), css = src.match(/<style>([\s\S]*?)<\/style>/)[1]
    const root = css.match(/\.page\s*\{([^}]+)\}/)[1]
    expect(root).toContain('width: 100%'); expect(root).toContain('height: 100%')
    expect(root).not.toMatch(/padding|margin|top:|left:/)
    expect(src).toContain('<list ')
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
    expect(p.nextTargetLabel).toContain('第 2 组')
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
