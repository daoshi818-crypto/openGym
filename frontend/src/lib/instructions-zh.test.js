import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import english from '../instr/en.js'
import chinese from '../instr/zh.js'

const source = JSON.parse(readFileSync(new URL('../../../catalogue/i18n/zh.json', import.meta.url), 'utf8'))
const delivery = JSON.parse(readFileSync(new URL('../../../docs/dev/zh-instructions-20261027/translations.json', import.meta.url), 'utf8'))
const issues = JSON.parse(readFileSync(new URL('../../../docs/dev/zh-instructions-20261027/codex-review-issues.json', import.meta.url), 'utf8')).issues
const reviewText = readFileSync(new URL('../../../docs/dev/zh-instructions-20261027/review-required.txt', import.meta.url), 'utf8').trim().split(/\r?\n/)

describe('Simplified Chinese exercise instructions release', () => {
  test('merges every accepted action without leaking quarantined source conflicts', () => {
    const accepted = new Set(delivery.translations.map(row => row.id))
    const quarantined = new Set(delivery.review_required.map(row => row.id))
    expect(accepted.size).toBe(4130)
    expect(quarantined.size).toBe(178)
    expect([...accepted].filter(id => quarantined.has(id))).toEqual([])
    expect(reviewText).toEqual(delivery.review_required.map(row => `${row.id}\t${row.reason}`))
    expect(delivery.translations.reduce((sum, row) => sum + row.instructions.length, 0)).toBe(22032)
    for (const row of delivery.translations) {
      expect(row.instructions.length, row.id).toBe(english[row.id].length)
      expect(source[row.id].instructions, row.id).toEqual(row.instructions)
      expect(chinese[row.id], row.id).toEqual(row.instructions)
      for (const step of row.instructions) expect(step, row.id).toMatch(/[\p{Script=Han}]/u)
    }
    for (const id of quarantined) {
      expect(source[id].instructions, id).toBeUndefined()
      expect(chinese[id], id).toBeUndefined()
    }
    for (const [id, row] of Object.entries(source)) {
      expect(chinese[id], id).toEqual(row.instructions)
      expect(english[id], id).toBeTruthy()
    }
  })

  test('keeps the independently reviewed slow lowering and arch direction corrections', () => {
    expect(chinese['6075'][2]).toBe('缓慢放下这只手臂，同时抬起另一只。')
    expect(chinese['0504'][2]).toBe('伸直双臂，但不要让腰背反弓。')
    for (const issue of issues) {
      const current = chinese[issue.id][issue.step - 1]
      expect(current, `${issue.id}:${issue.step}`).not.toBe(issue.zh)
      if (issue.category === 'direction_clarity') expect(current, `${issue.id}:${issue.step}`).toMatch(/反弓/)
    }
    // Never globally replace a forward-rounded back with a backbend.
    expect(issues).toHaveLength(74)
  })
})
