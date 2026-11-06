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
    expect([...host.querySelectorAll('.seg button')].map(b => b.textContent)).toEqual(['波利奎因', '蒂博多（力量举）', 'ATG 训练体系'])
    for (const role of tpl.roles) {
      const row = host.querySelector(`[data-role-id="${role.id}"]`)
      expect(row.querySelector('.nm > span').textContent).toBe(t(role.label))
      expect(row.querySelector('.nm > span').textContent).not.toMatch(/[a-z]/i)
      expect(row.querySelector('[data-exercise-name]').textContent).not.toMatch(/[a-z]/i)
    }
    expect(host.textContent).not.toMatch(/No data|Not scored|Log the anchor|Log your body|Change exercise/)
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
