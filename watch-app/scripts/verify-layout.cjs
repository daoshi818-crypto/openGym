const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const build = path.resolve(__dirname, '../build/watch-square')
const read = name => JSON.parse(fs.readFileSync(path.join(build, name), 'utf8'))
const manifest = read('manifest.json')
assert.ok(manifest.deviceTypeList.includes('watch-square'), 'Rectangular watch target is missing')
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
  console.log(page + ': full viewport, content bounds verified')
}
