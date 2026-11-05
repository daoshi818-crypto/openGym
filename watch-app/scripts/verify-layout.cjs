const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const target = process.argv[2] || process.env.WATCH_DEVICE_TYPE || 'watch-square'
const build = process.env.BLUEOS_BUILD_ROOT ? path.resolve(process.env.BLUEOS_BUILD_ROOT, target) : path.resolve(__dirname, '../build', target)
const read = name => JSON.parse(fs.readFileSync(path.join(build, name), 'utf8'))
const manifest = read('manifest.json')
assert.ok(manifest.deviceTypeList.includes(target), target + ' target is missing')
assert.equal(manifest.config.designWidth, 390)

for (const page of Object.keys(manifest.router.pages)) {
  const template = read(page + '/index.template.json')
  const root = template.style
  assert.equal(root.width, '100%', page + ' must fill the viewport width')
  assert.equal(root.height, '100%', page + ' must fill the viewport height')
  for (const key of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'left', 'top', 'marginLeft', 'marginTop']) {
    assert.ok(!root[key] || root[key] === '0px', page + ' root must not shift or enlarge its viewport: ' + key)
  }
  const styles = Object.values(read(page + '/index.css.json'))[0]
  const content = styles['.screen'] || styles['.content']
  if (content) {
    assert.ok(parseFloat(content.width) >= 340 && parseFloat(content.width) <= 354, page + ' content is too narrow or clips the sides')
    assert.ok(parseFloat(content.height) + parseFloat(content.marginTop || 0) <= 434, page + ' content clips the bottom')
  }
  if (page === 'Workout') {
    const digits = styles['.rest']
    assert.ok(parseFloat(digits.lineHeight) >= parseFloat(digits.fontSize) * 1.2, 'Native countdown line-height is too tight')
    assert.ok(parseFloat(digits.height) >= parseFloat(digits.lineHeight), 'Native countdown clips its line box')
    assert.ok(parseFloat(styles['.rrow'].marginTop) >= 8, 'Native countdown needs separation from rest controls')
    assert.ok(styles['.completion-panel'], 'All-complete choice was not compiled')
    const checkScrollableViews = sheet => {
      const px = (selector, field) => parseFloat(sheet[selector]?.[field] || 0)
      const screenHeight = px('.screen', 'height')
      for (const [viewport, panel] of [['.training-scroll', '.compact'], ['.rest-scroll', '.rest-panel']]) {
        assert.ok(px(viewport, 'height') > 0, viewport + ' native list viewport missing')
        assert.ok(px(viewport, 'height') + px(panel, 'paddingTop') <= px(panel, 'height'), viewport + ' exceeds its panel')
        assert.ok(px('.topbar', 'height') + px(panel, 'height') + px('.primary-footer', 'height') <= screenHeight, panel + ' hides the footer')
      }
      assert.ok(px('.operation-scroll', 'height') + px('.topbar', 'height') <= screenHeight, 'Operation list exceeds screen')
      assert.ok(px('.effort-scroll', 'height') + px('.effort-scroll', 'marginTop') <= 434, 'Effort list exceeds viewport')
      // Content may be taller than these lists; do not reintroduce sum-of-children <=
      // viewport assertions which would force shrinking the readable digits again.
      assert.ok(px('.rest-ex', 'height') >= 2 * px('.rest-ex', 'lineHeight'), 'Rest title clips two lines')
      assert.ok(px('.ex', 'height') >= 2 * px('.ex', 'lineHeight'), 'Action title clips two lines')
      assert.ok(px('.rest', 'fontSize') >= 96, 'Countdown was squeezed instead of scrolled')
      assert.ok(px('.rest', 'lineHeight') >= px('.rest', 'fontSize') * 1.2, 'Countdown line-height too tight')
      assert.ok(px('.rest', 'height') >= px('.rest', 'lineHeight'), 'Countdown clips its line box')
      assert.ok(px('.effort-value', 'fontSize') >= 80, 'Effort digits too small')
      assert.ok(px('.elapsed-value', 'fontSize') >= 76, 'Elapsed digits too small')
      assert.ok(px('.set-hit', 'width') >= 44 && px('.set-hit', 'height') >= 44, 'Set hit target too small')
      assert.equal(sheet['.set-dots'].flexWrap, 'wrap', 'Set dots must wrap inside the round safe area')
      assert.ok(px('.set-dots', 'height') >= 2 * px('.set-hit', 'height'), 'Wrapped set targets clip the second row')
      assert.ok(px('.set-dots', 'width') <= px('.screen', 'width'), 'Set dots exceed safe area')
    }
    checkScrollableViews(styles)
    for (const media of styles['@MEDIA'] || []) {
      const merged = { ...styles }
      for (const [selector, rule] of Object.entries(media)) if (selector !== 'condition') merged[selector] = { ...(styles[selector] || {}), ...rule }
      checkScrollableViews(merged)
    }
    if (target === 'watch-round') {
      const media = styles['@MEDIA']?.find(item => item.condition === 'screen and (min-width: 450px)')
      assert.ok(media, 'Round-watch media layout is missing')
      assert.equal(media['.screen']?.width, '280px', 'Round-watch content width is not reduced')
      assert.equal(media['.screen']?.height, '300px', 'Round-watch content height is not reduced')
      assert.equal(media['.screen']?.marginTop, '70px', 'Round-watch content needs circular safe-area clearance')
    }
  }
  console.log(page + ': full viewport, content bounds verified')
}
