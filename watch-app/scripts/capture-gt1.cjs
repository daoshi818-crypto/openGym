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
      return { root: { width: root.width, height: root.height }, lists, outside, sideways, clippedNumbers, scrollRequired, clippedPlan }
    })
    assert.deepEqual(result.root, { width: 390, height: 450 }, scene.id + ' root viewport')
    report.push({ ...scene, ...result })
    if (result.outside.length || result.sideways.length || result.clippedNumbers.length || result.scrollRequired.length || result.clippedPlan) console.error(scene.id, JSON.stringify(result))
  }
  fs.writeFileSync(path.join(dir, 'layout-report.json'), JSON.stringify({ errors, scenes: report }, null, 2))
  await browser.close()
  assert.deepEqual(errors, [], 'Browser rendering errors')
  assert.deepEqual(report.filter(s => s.outside.length || s.sideways.length || s.clippedNumbers.length || s.scrollRequired.length || s.clippedPlan), [], 'Controls exceed viewport, numbers clip, single-screen forms scroll, or first plan is cut off')
  console.log('Captured ' + scenes.length + ' scenes; see layout-report.json for bounds checks')
})().catch(e => { console.error(e); process.exitCode = 1 })
