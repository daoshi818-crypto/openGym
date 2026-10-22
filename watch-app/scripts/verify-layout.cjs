const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const target = process.argv[2] || process.env.WATCH_DEVICE_TYPE || 'watch-square'
const build = path.resolve(__dirname, '../build', target)
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
