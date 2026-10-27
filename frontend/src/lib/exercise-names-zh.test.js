import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import names from '../exercise-names/zh.js'
import { EXDB, EXALIAS } from './exercises-data.js'

const source = JSON.parse(readFileSync(new URL('../../../catalogue/i18n/zh.json', import.meta.url), 'utf8'))
const catalogueDir = new URL('../../../catalogue/exercises/', import.meta.url)
const catalogue = readdirSync(catalogueDir).filter(file => file.endsWith('.json'))
  .map(file => JSON.parse(readFileSync(new URL(file, catalogueDir), 'utf8')))
const exercises = catalogue.filter(exercise => exercise.name && !exercise.variantOf)

describe('Simplified Chinese exercise names', () => {
  test('covers every canonical exercise and exactly matches the generated name pack', () => {
    const ids = exercises.map(exercise => exercise.id).sort()
    expect(Object.keys(source).sort()).toEqual(ids)
    expect(Object.keys(names).sort()).toEqual(ids)
    expect(names).toEqual(Object.fromEntries(Object.entries(source).map(([id, row]) => [id, row.name])))
    expect(EXDB.map(exercise => exercise.id).sort()).toEqual(ids)
    for (const [id, name] of Object.entries(names)) {
      expect(name, id).toBe(name.trim())
      expect(name, id).toMatch(/[\p{Script=Han}]/u)
      expect(name, id).not.toMatch(/v\.\s*\d|版本\d|后三角肌|稳定球|地雷杆|EZ杠|髋推|悬挂训练带|悬挂带/i)
    }
  })

  test.each([
    ['0003', '空中自行车卷腹'],
    ['0058', '杠铃凳上臀推'],
    ['0248', '弓形杠胸托俯卧划船'],
    ['0341', '哑铃俯卧单臂三角肌后束上举'],
    ['0394', '哑铃坐姿臂后屈伸'],
    ['0450', 'EZ曲杆JM推举'],
    ['0617', '侧卧抬腿（地面）'],
    ['0982', '弹力带侧卧髋外旋'],
    ['1042', '负重俯卧颈后伸'],
    ['1489', '西西深蹲'],
    ['2395', '自行车卷腹（变式2）'],
    ['2683', '杠铃反握腕弯举（变式2）'],
    ['3286', '负重双力臂'],
    ['3296', '前水平支撑'],
    ['4151', '哑铃地面仰卧臂屈伸（额前式）'],
    ['4429', '负重侧卧颈部侧屈'],
    ['6161', '哑铃俯卧腿弯举'],
    ['6270', '杠铃拉森卧推'],
    ['10664', '水平支撑推起'],
    ['11077', '哑铃胸前持重侧卧髋外展'],
    ['11090', '前水平离心下放'],
    ['11801', '卧姿单腿股四头肌活动'],
    ['11954', '侧卧扭转拉伸（髋部与大腿）'],
  ])('keeps the reviewed meaning for %s', (id, expected) => {
    expect(names[id]).toBe(expected)
  })

  test('distinguishes resistance exercise, stretching, machine loading and lever length', () => {
    for (const exercise of exercises) {
      const name = names[exercise.id]
      if (exercise.equipment === 'leverage machine' && /^lever(?:age)?\b/i.test(exercise.name)) {
        expect(name, exercise.id).not.toMatch(/^杠杆/)
      }
      if (/plate loaded/i.test(exercise.name)) expect(name, exercise.id).not.toContain('插片式')
      if (/long lever/i.test(exercise.name)) {
        expect(name, exercise.id).toContain('长力臂')
        expect(name, exercise.id).not.toContain('器械')
      }
      if (/triceps/i.test(exercise.name) && /extension/i.test(exercise.name) && !/stretch/i.test(exercise.name)) {
        expect(name, exercise.id).not.toContain('三头肌伸展')
      }
    }
    expect(names['1445']).toBe('哑铃罗马尼亚硬拉拉伸')
    expect(names['1820']).toBe('EZ曲杆牧师凳手臂拉伸')
    expect(names['0643']).toBe('过头三头肌拉伸')
    expect(names['9874']).toBe('绳索卧姿单臂交叉侧平举')
  })

  test('preserves variant numbers and drawing aliases rather than renumbering or merging IDs', () => {
    for (const exercise of exercises) {
      const variant = exercise.name.match(/v\.\s*(\d+)/i)
      if (variant) expect(names[exercise.id], exercise.id).toContain(`（变式${variant[1]}）`)
    }
    for (const [alias, canonical] of Object.entries(EXALIAS)) {
      expect(names[canonical], alias).toBeTruthy()
      expect(names[alias], alias).toBeUndefined()
    }
  })

  test('permits only the documented synonymous names, without losing their separate IDs', () => {
    const grouped = new Map()
    for (const [id, name] of Object.entries(names)) {
      if (!grouped.has(name)) grouped.set(name, [])
      grouped.get(name).push(id)
    }
    const duplicates = Object.fromEntries([...grouped].filter(([, ids]) => ids.length > 1)
      .map(([name, ids]) => [name, ids.sort()]))
    expect(duplicates).toEqual({
      '器械俯卧腿弯举': ['0586', '9676'],
      '弹力带侧卧髋外展': ['10899', '11644'],
      // Both English sources say v.2 (one misspells reverse as revers). Do not invent v.3.
      '杠铃反握腕弯举（变式2）': ['0079', '2683'],
    })
  })
})
