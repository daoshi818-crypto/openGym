import { describe, expect, test } from 'vitest'
import { drawRecapCard } from './recap-card.js'
import { cardPalette } from './card-draw.js'

// A canvas context that only records what was written.
function fakeCtx() {
  const texts = []
  const noop = () => {}
  return {
    texts,
    fillText: t => texts.push(String(t)), measureText: t => ({ width: String(t).length * 10 }),
    fillRect: noop, beginPath: noop, moveTo: noop, arcTo: noop, closePath: noop, fill: noop, save: noop, restore: noop, translate: noop, scale: noop,
  }
}

describe('the recap picture', () => {
  test.each([[1920, false], [1080, false], [1920, true], [1080, true]])('keeps long totals and translated labels within the card at height %s, rtl %s', (height, rtl) => {
    const ctx = fakeCtx()
    const painted = []
    ctx.measureText = value => ({ width: String(value).length * Number(ctx.font.match(/([\d.]+)px/)[1]) * 0.6 })
    ctx.fillText = (value, x, y, maxWidth) => {
      if (maxWidth == null) return // Brand has its own layout.
      const w = ctx.measureText(value).width
      painted.push(String(value))
      expect(w).toBeLessThanOrEqual(maxWidth + 0.001)
      expect(rtl ? x - w : x).toBeGreaterThanOrEqual(79.999)
      expect(rtl ? x : x + w).toBeLessThanOrEqual(1000.001)
    }
    drawRecapCard(ctx, {
      title: 'Your exceptionally productive training month', dates: 'October 1 to October 31, 2026',
      tiles: [{ label: 'Training volume in kilograms', value: '1,234,567.8 kg' }, { label: 'Consecutive weeks of training', value: '1234' }],
      top: 'Most work: Quadriceps, 123.4 working sets this month',
    }, { width: 1080, height, colors: cardPalette('dark'), rtl })
    expect(painted).toContain('1,234,567.8 kg')
  })

  test('carries the title, the dates, the four tiles, the top muscle and the brand', () => {
    const ctx = fakeCtx()
    drawRecapCard(ctx, { title: 'Your week', dates: '19–25 Oct', tiles: [{ label: 'workouts', value: '4' }, { label: 'Volume', value: '12,300 kg' }, { label: 'new bests', value: '2' }, { label: 'weeks in a row', value: '6' }], top: 'Most work: Chest, 14 sets' },
      { width: 1080, height: 1920, colors: cardPalette('dark') })
    expect(ctx.texts).toEqual(expect.arrayContaining(['Your week', '19–25 Oct', '4', 'workouts', '12,300 kg', 'Volume', '2', '6', 'Most work: Chest, 14 sets', 'open', 'Gym']))
  })
})
