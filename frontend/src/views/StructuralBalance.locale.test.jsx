// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import StructuralBalance from './StructuralBalance.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { setLang, t } from '../lib/i18n.js'
import { registerCustom } from '../lib/exercises.js'
import { TEMPLATE_LIST } from '../lib/structuralBalanceTemplates.js'
let host, root
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear()
  useStore.setState({ S: structuredClone(DEF), user: null }); await setLang('zh', true, false)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => { act(() => root.unmount()); host.remove(); registerCustom([]); await setLang('en') })
const render = () => act(() => root.render(<MemoryRouter><StructuralBalance /></MemoryRouter>))
describe('Structural balance Simplified Chinese', () => {
  it.each(TEMPLATE_LIST)('localizes the complete $id template without English suffixes', tpl => {
    useStore.setState({ S: { ...useStore.getState().S, balanceTemplate: tpl.id } }); render()
    expect([...host.querySelectorAll('.seg button')].map(b => b.textContent)).toEqual(['Poliquin', 'Thibaudeau（力量举）', 'ATG'])
    for (const role of tpl.roles) {
      const row = host.querySelector(`[data-role-id="${role.id}"]`)
      expect(row.querySelector('.nm > span').textContent).toBe(t(role.label))
      // Keep proper names, rather than transliterating them.
      expect(row.querySelector('.nm > span').textContent.replace('Poliquin', '')).not.toMatch(/[a-z]/i)
      expect(row.querySelector('[data-exercise-name]').textContent).not.toMatch(/[a-z]/i)
    }
    expect(host.textContent).not.toMatch(/No data|Not scored|Log the anchor|Log your body|Change exercise|波利奎因|蒂博多|锚点|临界/)
    expect(host.querySelector('h1').textContent).toBe('结构平衡')
  })
  it('uses readable reference and missing-record wording instead of literal jargon', () => {
    const S = useStore.getState().S
    const entry = (id, w) => ({ id, sets: [{ done: true, w, r: 1 }] })
    S.workouts = [{ d: new Date().toISOString(), start: Date.now(), entries: [
      entry('0030', 100), entry('0047', 88), entry('0031', 20),
    ] }]
    render()
    expect(host.querySelector('[data-role-id="narrowBench"]').textContent).toContain('窄距卧推（比较基准）')
    expect(host.querySelector('[data-role-id="narrowBench"]').textContent).toContain('达到参考值')
    expect(host.querySelector('[data-role-id="inclineBench"]').textContent).toContain('接近参考值')
    expect(host.querySelector('[data-role-id="barbellCurl"]').textContent).toContain('低于参考值')
    expect(host.querySelector('[data-role-id="deadlift"]').textContent).toContain('暂无记录')
  })
  it('explains the missing comparison baseline without calling it an anchor', () => {
    useStore.getState().S.workouts = [{ d: new Date().toISOString(), start: Date.now(),
      entries: [{ id: '0047', sets: [{ done: true, w: 70, r: 1 }] }] }]
    render()
    const row = host.querySelector('[data-role-id="inclineBench"]')
    expect(row.textContent).toContain('暂无法比较')
    expect(row.querySelector('[data-needs-anchor]').textContent).toBe('先记录比较基准动作，才能计算这项力量比例。')
  })
  it('keeps names and exercise requirements while using common Chinese terms', () => {
    expect(t('Poliquin')).toBe('Poliquin')
    expect(t('Thibaudeau (Powerlifting)')).toBe('Thibaudeau（力量举）')
    expect(t('Poliquin step-up (15 reps)')).toBe('Poliquin 台阶蹲（15次）')
    expect(t('Military press')).toBe('站姿杠铃推举')
    expect(t('Incline DB press (each hand, 8 reps)')).toBe('哑铃上斜卧推（单手重量，8次）')
    expect(t('DB shoulder press (each hand, 8 reps)')).toBe('哑铃肩推（单手重量，8次）')
  })
  it('respects explicit English-only exercise-name preference', async () => {
    await setLang('zh', true, true); render()
    expect(host.querySelector('[data-role-id="narrowBench"] [data-exercise-name]').textContent).toBe('barbell close-grip bench press')
  })
  it('keeps custom exercise names intact', () => {
    const S = useStore.getState().S
    S.customEx = [{ id: 'own-back', n: 'My custom movement', custom: true }]
    registerCustom(S.customEx)
    S.balanceOverrides = { 'poliquin:narrowBench': 'own-back' }; render()
    expect(host.querySelector('[data-role-id="narrowBench"] [data-exercise-name]').textContent).toBe('My custom movement')
  })
})
