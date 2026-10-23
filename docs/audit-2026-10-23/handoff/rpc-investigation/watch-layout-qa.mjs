import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
const require = createRequire('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json')
const { chromium } = require('playwright')
const out = path.resolve('deliverables/watch-ui-review')
const port = Number(process.env.WATCH_PREVIEW_PORT || 4180)
fs.mkdirSync(out, { recursive: true })
const cases = ['Workout', 'Workout&long', 'Workout&rest', 'Workout&rest&long', 'Workout&rest&change', 'Workout&actions', 'Workout&paused',
  'Index', 'Index&empty', 'Index&conflict', 'ExerciseList', 'ExerciseList&expanded', 'ExerciseList&end', 'Keypad', 'Summary',
  'Workout&complete', 'Workout&rest&maxrest&fontstress&long&change']
const browser = await chromium.launch({ headless: true, channel: 'msedge' })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 450 }, deviceScaleFactor: 1 })
  for (const [i, route] of cases.entries()) {
    await page.goto('http://127.0.0.1:' + port + '/?page=' + route)
    const result = await page.evaluate(() => {
      const root = document.querySelector('.page').getBoundingClientRect()
      const errors = []
      if (root.x !== 0 || root.y !== 0 || root.width !== 390 || root.height !== 450) errors.push('root: ' + JSON.stringify(root.toJSON()))
      const overlays = [...document.querySelectorAll('.menu,.leave-panel,.overlay')]
      const scope = overlays.at(-1) || document.querySelector('.page')
      const rects = [...scope.querySelectorAll('text,input,img')].filter(el => !el.closest('list')).map(el => ({
        label: el.getAttribute('value') || el.textContent.trim(), rect: el.getBoundingClientRect(), tag: el.tagName,
      }))
      // A 36px corner radius only excludes the corners; it does not shrink the entire page.
      const inside = (x, y) => {
        if (x < 0 || y < 0 || x > 390 || y > 450) return false
        const cx = x < 36 ? 36 : x > 354 ? 354 : x
        const cy = y < 36 ? 36 : y > 414 ? 414 : y
        return (x - cx) ** 2 + (y - cy) ** 2 <= 36 ** 2
      }
      for (const { label, rect: r, tag } of rects) {
        if (![[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]].every(([x, y]) => inside(x, y)))
          errors.push(label + ': clipped ' + JSON.stringify(r.toJSON()))
        if (tag === 'INPUT' && r.height < 38) errors.push(label + ': target too short')
      }
      const visibleRects = rects.filter(({ rect: r }) => r.width > 0 && r.height > 0)
      for (let i = 0; i < visibleRects.length; i++) for (let j = i + 1; j < visibleRects.length; j++) {
        const a = visibleRects[i].rect, b = visibleRects[j].rect
        const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
          Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
        const area = Math.min(a.width * a.height, b.width * b.height)
        if (overlap > 4 && overlap / Math.max(1, area) > 0.08)
          errors.push('overlap: ' + visibleRects[i].label + ' / ' + visibleRects[j].label)
      }
      if (location.search.includes('rest')) {
        const skip = scope.querySelector('.skip')?.getBoundingClientRect()
        const progress = scope.querySelector('.primary-footer .progress')?.getBoundingClientRect()
        if (!skip || !progress || progress.top - skip.bottom < 6)
          errors.push('rest skip button needs at least 6px above set progress')
        const digits = scope.querySelector('.rest')
        const digitRect = digits?.getBoundingClientRect()
        const row = scope.querySelector('.rrow')?.getBoundingClientRect()
        if (!digitRect || !row || row.top - digitRect.bottom < 8)
          errors.push('countdown needs at least 8px above rest adjustment row')
        if (digits) {
          const style = getComputedStyle(digits)
          if (parseFloat(style.lineHeight) < parseFloat(style.fontSize) * 1.2 || parseFloat(style.lineHeight) > digitRect.height)
            errors.push('countdown line-height must fit and allow native font metrics')
          const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
          context.font = style.font
          const ink = context.measureText(digits.textContent)
          if (ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent + 12 > digitRect.height || ink.width > digitRect.width)
            errors.push('countdown glyphs need more space')
        }
      }
      const dots = scope.querySelector('.dots')
      if (location.search.includes('rest') && dots) errors.push('Rest must hide page indicators')
      if (dots) {
        const r = dots.getBoundingClientRect()
        if (r.right < 370 || r.top > 100) errors.push('Page indicators must be upper right')
      }
      return { errors, root: root.toJSON(), controls: rects.length }
    })
    await page.screenshot({ path: path.join(out, String(i + 1).padStart(2, '0') + '.png') })
    console.log(route, JSON.stringify(result))
    if (result.errors.length) throw Error('Layout bounds failed: ' + route)
  }
  const tiles = cases.map((route, i) => '<figure><img src="data:image/png;base64,' + fs.readFileSync(path.join(out, String(i + 1).padStart(2, '0') + '.png')).toString('base64') + '"><figcaption>' + String(i + 1).padStart(2, '0') + ' · ' + route.replaceAll('&', ' / ') + '</figcaption></figure>').join('')
  const overview = await browser.newPage({ viewport: { width: 1000, height: 1800 }, deviceScaleFactor: 1 })
  await overview.setContent('<style>body{margin:0;padding:14px;background:#101214;color:#eee;font:16px Arial,"Microsoft YaHei",sans-serif}main{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0}img{display:block;width:100%;height:auto;border:1px solid #34383b}figcaption{padding:6px 0 2px}</style><main>' + tiles + '</main>')
  await overview.screenshot({ path: path.join(out, '00-contact-sheet.png'), fullPage: true })
  await overview.close()
} finally { await browser.close() }
