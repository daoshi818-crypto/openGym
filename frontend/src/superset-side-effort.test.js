// DOM test environments do not lay out flex rows or apply media queries. Guard the shared
// value-only floor here; real viewport checks also need a browser.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]

describe('workout effort buttons use a value-only column', () => {
  it('shares one compact floor between the empty/logged button and header', () => {
    const floors = rules.filter(m => m[1].includes('.setrow .effcell') && /min-width:/.test(m[2]))
    expect(floors).toHaveLength(3)
    expect(floors.every(m => m[1].includes('.sethead .eff-sp'))).toBe(true)
    expect(floors.map(m => Number(m[2].match(/min-width:(\d+)/)?.[1]))).toEqual([0, 34, 29])
  })

  it('has no workout effort-stepper selectors or breakpoint button placeholders', () => {
    expect(rules.some(m => m[1].includes('.setrow') && m[1].includes('.effcell-stp'))).toBe(false)
    expect(rules.some(m => m[1].includes('.effcell') && /aria-label|>button/.test(m[1]) && !m[1].includes('.effpick'))).toBe(false)
  })

  it('keeps the exact-value stepper styles scoped to the existing picker', () => {
    const stepperRules = rules.filter(m => m[1].includes('.effcell-stp'))
    expect(stepperRules.length).toBeGreaterThan(0)
    expect(stepperRules.every(m => m[1].trim().startsWith('.effpick '))).toBe(true)
    expect(css).toContain('.effpick .effpick-free .stp{flex:none;width:148px}')
  })
})
