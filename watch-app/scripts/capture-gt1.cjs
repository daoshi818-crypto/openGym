// Browser semantic preview checks; not an emulator or real-device certification.
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
;(async () => {
  const dir = path.resolve(process.argv[2] || 'preview-gt1')
  const scenes = JSON.parse(fs.readFileSync(path.join(dir, 'scenes.json'), 'utf8'))
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 450 }, deviceScaleFactor: 1 })
  const errors = [], report = []
  page.on('pageerror', e => errors.push(String(e)))
  for (const scene of scenes) {
    await page.goto(pathToFileURL(path.join(dir, scene.id + '.html')).href)
    await page.screenshot({ path: path.join(dir, scene.id + '.png') })
    const result = await page.evaluate(() => {
      const root = document.querySelector('.page').getBoundingClientRect()
      const lists = [...document.querySelectorAll('[data-type="list"]')].map(e => ({ cls: e.className, height: e.clientHeight, scrollHeight: e.scrollHeight, top: e.scrollTop }))
      const outside = [...document.querySelectorAll('button,native-text')].filter(el => {
        if (el.closest('[data-type="list"]')) return false
        const r = el.getBoundingClientRect()
        return r.width && r.height && (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1)
      }).map(el => ({ cls: el.className, text: el.textContent }))
      const sideways = [...document.querySelectorAll('[data-type="list"]')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className)
      const clippedNumbers = [...document.querySelectorAll('.fval>span,.funit>span,.show>span,.rest>span')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => ({text:e.textContent,width:e.clientWidth,needed:e.scrollWidth}))
      // Being inside a scroll container must not exempt a single-screen form from checks.
      const mustFit = ['03-current','16-editor','17-keyboard','20-done-row','28-paused'].includes(SCENE.id) || SCENE.name === 'Keypad'
      const scrollRequired = mustFit ? lists.filter(e => e.scrollHeight > e.height + 1) : []
      const firstPlan = document.querySelector('.plans .plan')
      let clippedPlan = false
      if (firstPlan) {
        const card = firstPlan.getBoundingClientRect(), list = firstPlan.parentElement.getBoundingClientRect()
        clippedPlan = card.top < list.top - 1 || card.bottom > list.bottom + 1
      }
      // 80 design-pixel mask is deliberately conservative, not a measured GT1 radius.
      // Measure visible text runs (not transparent layout boxes); obey ancestor/list clips.
      const radius = 80
      const inside = (x, y) => {
        if (x < 0 || x > innerWidth || y < 0 || y > innerHeight) return false
        const cx = Math.max(radius, Math.min(innerWidth-radius, x))
        const cy = Math.max(radius, Math.min(innerHeight-radius, y))
        return (x-cx)**2 + (y-cy)**2 <= (radius+0.5)**2
      }
      const corners = () => [...document.querySelectorAll('button>span,native-text>span')].flatMap(span => {
        const range = document.createRange(); range.selectNodeContents(span)
        return [...range.getClientRects()].flatMap(rect => {
          let l=Math.max(0,rect.left), r=Math.min(innerWidth,rect.right), t=Math.max(0,rect.top), b=Math.min(innerHeight,rect.bottom)
          for (let e=span; e && e.id!=='viewport'; e=e.parentElement) {
            const css=getComputedStyle(e), box=e.getBoundingClientRect()
            if (css.overflowX!=='visible') { l=Math.max(l,box.left); r=Math.min(r,box.right) }
            if (css.overflowY!=='visible') { t=Math.max(t,box.top); b=Math.min(b,box.bottom) }
          }
          if (r<=l || b<=t || [[l,t],[r,t],[l,b],[r,b]].every(([x,y])=>inside(x,y))) return []
          return [{ cls:span.parentElement.className, text:span.textContent, rect:{left:l,right:r,top:t,bottom:b} }]
        })
      })
      const vectorImages = [...document.querySelectorAll('img')].map(e => ({ cls:e.className, loaded:e.complete && e.naturalWidth>0, width:e.getBoundingClientRect().width, height:e.getBoundingClientRect().height }))
      const brokenVectors = vectorImages.filter(e => !e.loaded || e.width<=0 || e.height<=0)
      const cornerClipped = corners()
      for (const list of document.querySelectorAll('[data-type="list"]')) list.scrollTop=list.scrollHeight
      const cornerClippedAtEnd = corners()
      return { root: { width: root.width, height: root.height }, lists, vectorImages, brokenVectors, outside, sideways, clippedNumbers, scrollRequired, clippedPlan, cornerClipped, cornerClippedAtEnd }

    })
    assert.deepEqual(result.root, { width: 390, height: 450 }, scene.id + ' root viewport')
    report.push({ ...scene, ...result })
    if (result.brokenVectors.length || result.outside.length || result.sideways.length || result.clippedNumbers.length || result.scrollRequired.length || result.clippedPlan || result.cornerClipped.length || result.cornerClippedAtEnd.length) console.error(scene.id, JSON.stringify(result))
  }
  fs.writeFileSync(path.join(dir, 'layout-report.json'), JSON.stringify({ previewOnly: true, conservativeCornerRadius: 80, errors, scenes: report }, null, 2))
  await browser.close()
  assert.deepEqual(errors, [], 'Browser rendering errors')
  assert.deepEqual(report.filter(s => s.brokenVectors.length || s.outside.length || s.sideways.length || s.clippedNumbers.length || s.scrollRequired.length || s.clippedPlan || s.cornerClipped.length || s.cornerClippedAtEnd.length), [], 'Controls exceed viewport/corner mask, numbers clip, single-screen forms scroll, or first plan is cut off')
  console.log('Captured ' + scenes.length + ' scenes; see layout-report.json for bounds checks')
})().catch(e => { console.error(e); process.exitCode = 1 })
