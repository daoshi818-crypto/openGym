// Validate the compiler output, not just source CSS strings.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const target = process.argv[2] || process.env.WATCH_DEVICE_TYPE || 'watch-square'
const build = process.env.BLUEOS_BUILD_ROOT ? path.resolve(process.env.BLUEOS_BUILD_ROOT, target) : path.resolve(__dirname, '../build', target)
const read = name => JSON.parse(fs.readFileSync(path.join(build, name), 'utf8'))
const manifest = read('manifest.json')
assert.ok(manifest.deviceTypeList.includes(target), target + ' target is missing')
assert.equal(manifest.config.designWidth, 390)
assert.ok(!manifest.features.some(f => f.name === 'blueos.storage.file'), 'Removed demo file capability returned')
function nodes(n) { return [n, ...(n.children || []).flatMap(nodes)] }
function sheetOf(page) { return Object.values(read(page + '/index.css.json'))[0] }
function px(sheet, selector, field) { return parseFloat(sheet[selector]?.[field] || 0) }
function viewport(style, label) {
  assert.equal(style.width, '100%', label + ' width')
  assert.equal(style.height, '100%', label + ' height')
}
function flexViewport(sheet, selector) {
  assert.equal(sheet[selector]?.flex, 1, selector + ' must absorb remaining height instead of a fixed legacy viewport')
}
for (const page of Object.keys(manifest.router.pages)) {
  const template = read(page + '/index.template.json'), sheet = sheetOf(page)
  viewport(template.style, page + ' root')
  for (const key of ['paddingTop','paddingRight','paddingBottom','paddingLeft','left','top','marginLeft','marginTop']) {
    assert.ok(!template.style[key] || template.style[key] === '0px', page + ' root offset: ' + key)
  }
  for (const selector of ['.screen','.content']) if (sheet[selector]) viewport(sheet[selector], page + selector)
  const tree = nodes(template)
  assert.ok(tree.some(n => n.type === 'list'), page + ' must retain native scrolling')
  assert.ok(!JSON.stringify(template).match(/mediaOn|demoOn|openDemo|media-image/), 'Removed watch demo returned')
  assert.ok(sheet['@MEDIA']?.some(m => m.condition === 'screen and (min-width: 450px)'), page + ' round fallback missing')
  if (page === 'Workout') {
    flexViewport(sheet, '.training-panel'); flexViewport(sheet, '.operation-scroll'); flexViewport(sheet, '.last-list')
    for (const selector of ['.training-scroll','.rest-scroll','.effort-scroll']) assert.equal(sheet[selector].height, '100%', selector + ' viewport')
    assert.equal(px(sheet,'.training-panel','minHeight'),0)
    const header=px(sheet,'.topbar','height')+px(sheet,'.topbar','marginTop')
    const footer=px(sheet,'.primary-footer','height')+px(sheet,'.primary-footer','marginBottom')
    const current=['.ex','.group','.inputs','.last-row','.navrow'].reduce((n,s)=>n+px(sheet,s,'height'),0)+px(sheet,'.set-dots','minHeight')
    assert.ok(header+current+footer<=450, 'Standard current set must show all dots and footer at 390x450')
    const rest=['.rest-ex','.rest','.next','.next-details','.effort-row','.rrow'].reduce((n,s)=>n+px(sheet,s,'height'),0)+px(sheet,'.rrow','marginTop')
    assert.ok(header+rest+px(sheet,'.rest-panel','marginBottom')<=450, 'Rest controls must fit without scrolling in standard state')
    assert.ok(px(sheet,'.rest','fontSize')>=100 && px(sheet,'.rest','height')>=px(sheet,'.rest','lineHeight'), 'Do not shrink or clip countdown')
    assert.ok(px(sheet,'.rest','lineHeight')>=1.2*px(sheet,'.rest','fontSize'), 'Countdown font line box')
    assert.ok(px(sheet,'.ex','height')>=2*px(sheet,'.ex','lineHeight'), 'Two-line exercise title')
    assert.equal(sheet['.inputs'].flexDirection,'row', 'V4 horizontal prescription')
    assert.ok(px(sheet,'.weight-field','width')+px(sheet,'.times','width')+px(sheet,'.reps-field','width')<=338)
    assert.ok(px(sheet,'.fval','fontSize')>=60, 'Current numbers too small')
    assert.ok(px(sheet,'.complete','height')>=94 && px(sheet,'.complete','borderRadius')>=47, 'V4 round done button')
    assert.ok(px(sheet,'.set-hit','width')>=44 && px(sheet,'.set-hit','height')>=44, 'Dot touch target')
    assert.ok(px(sheet,'.set-dot','width')<=14 && px(sheet,'.set-current','width')<=18, 'Dots are not numeric chips')
    assert.equal(sheet['.set-dots'].flexWrap,'wrap', 'Long dot pages must wrap safely')
    const dot=tree.find(n=>n.repeat?.$exp==='setDots')
    assert.ok(dot && dot.children.length===1 && dot.children[0].type==='div', 'Set dot must not contain number/checkmark labels')
    for (const selector of ['.completion-panel','.effort-layer']) viewport(sheet[selector],selector)
    assert.ok(tree.some(n=>n.events?.click==='openExercises' && n.class==='ex'), 'Tap title must open exercise picker')
    assert.ok(tree.some(n=>n.events?.click==='askEnd' && n.class==='flag'), 'Flag must only request confirmation')
  } else if (page==='ExerciseList') {
    flexViewport(sheet,'.body'); assert.equal(sheet['.scroll'].height,'100%')
    assert.equal(px(sheet,'.body','minHeight'),0)
    assert.ok(px(sheet,'.title','height')+px(sheet,'.title','marginTop')+px(sheet,'.foot','height')+px(sheet,'.foot','marginBottom')<450)
    assert.ok(px(sheet,'.exname','width')+px(sheet,'.cnt','width')+px(sheet,'.expand-hit','width')<=px(sheet,'.exhead','width'))
    assert.ok(tree.some(n=>n.events?.$click?.includes('pickExercise(this.item')), 'Tap action name handler missing')
  } else if (page==='Index') {
    flexViewport(sheet,'.plans')
    assert.ok(px(sheet,'.start-circle','height')>=100)
    const homeFixed = px(sheet,'.topbar','height')+px(sheet,'.topbar','marginTop')+px(sheet,'.status','height')+px(sheet,'.hero','height')+px(sheet,'.links','height')+px(sheet,'.links','marginBottom')+px(sheet,'.plans','marginBottom')
    assert.ok(homeFixed+44<=450, 'Home plan list must retain a visible touch/scroll region with recent summary present')
  } else if (page==='Keypad') {
    assert.equal(sheet['.editor-scroll'].height,'100%')
    assert.ok(px(sheet,'.step','width')>=44 && px(sheet,'.step','height')>=44)
    assert.ok(2*px(sheet,'.step','width')+px(sheet,'.show','width')<=px(sheet,'.step-row','width'))
    assert.ok(px(sheet,'.show','fontSize')>=76)
    assert.ok(tree.some(n=>n.events?.click==='onKeyOk'), 'Explicit Save missing')
  } else if (page==='Summary') {
    flexViewport(sheet,'.scroll')
    assert.ok(px(sheet,'.metric-value','fontSize')>=48)
    assert.equal(sheet['.hr-value'].color,'#FF453A')
    assert.ok(tree.some(n=>n.events?.click==='onBack'), 'Done must return only')
  }
  console.log(page + ': full viewport, native scroll, GT1 interaction/layout contract verified')
}
