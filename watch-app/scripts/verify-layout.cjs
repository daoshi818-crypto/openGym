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
  for (const node of tree.filter(n => n.type === 'image')) {
    const sources = node.attr?.src ? [node.attr.src] : [...(node.attr?.$src || '').matchAll(/['"](\/common\/icons\/[^'"]+\.svg)['"]/g)].map(m => m[1])
    assert.ok(sources.length, page + ': image needs local vector source')
    assert.ok(!node.events, page + ': click belongs to parent target, not unsupported image event')
    for (const src of sources) {
      assert.ok(src.startsWith('/common/icons/'), 'No remote media in watch UI')
      const packed = path.join(build, src.slice(1))
      assert.ok(fs.existsSync(packed), 'Vector missing from build: ' + src)
      assert.equal(fs.readFileSync(packed, 'utf8'), fs.readFileSync(path.join(__dirname, '../src', src.slice(1)), 'utf8'), 'Vector changed in build: ' + src)
    }
  }

  assert.ok(tree.some(n => n.type === 'list'), page + ' must retain native scrolling')
  assert.ok(!JSON.stringify(template).match(/mediaOn|demoOn|openDemo|media-image/), 'Removed watch demo returned')
  assert.ok(sheet['@MEDIA']?.some(m => m.condition === 'screen and (min-width: 450px)'), page + ' round fallback missing')
  assert.ok(!/[\p{Extended_Pictographic}\uFE0F✓▶♥↶]/u.test(JSON.stringify(template)), page + ' emoji/icon font dependency')
  const headerSelector = { Index: '.topbar', Workout: '.topbar', Keypad: '.label', ExerciseList: '.title', Summary: '.top' }[page]
  assert.ok(px(sheet,headerSelector,'marginTop')>=18, page + ' top corner inset')
  assert.ok(px(sheet,headerSelector,'width')<=314, page + ' header corner width')
  if (page === 'Workout') {
    flexViewport(sheet, '.finish-scroll')
    assert.equal(tree.filter(n => n.events?.click === 'askAbandon').length, 2, 'Visible abandon entry in operations and finish')
    assert.ok(tree.some(n => n.type === 'list' && n.class === 'finish-scroll'), 'Finish must scroll natively')
    const roundWorkout = sheet['@MEDIA'].find(m => m.condition === 'screen and (min-width: 450px)')
    const roundStyles = { ...sheet }
    for (const [selector, style] of Object.entries(roundWorkout)) if (selector.startsWith('.')) roundStyles[selector] = { ...sheet[selector], ...style }
    for (const [name, styles] of [['square', sheet], ['round', roundStyles]]) {
      assert.equal(styles['.op-prescription'].flexDirection, 'column', name + ': long operation values need separate rows')
      assert.ok(px(styles,'.op-metric','width') <= px(styles,'.op-prescription','width'), name + ': operation metrics overlap')
      assert.equal(styles['.status'].flex, 1, name + ': status must share header width')
      assert.ok(px(styles,'.clock','width') < px(styles,'.topbar','width'), name + ': clock leaves status room')
      assert.ok(px(styles,'.abandon-button','height') >= 44, name + ': abandon touch target')
    }
    flexViewport(sheet, '.training-panel'); flexViewport(sheet, '.operation-scroll'); flexViewport(sheet, '.last-list')
    flexViewport(sheet, '.effort-scroll')
    const main = tree.find(n => n.class === 'screen')
    assert.ok(main && !nodes(main).some(n => n.type === 'list'), 'Training and rest screens must never scroll')
    assert.ok(nodes(main).some(n => n.events?.click === 'openLast'), 'Inline history detail entry must remain')
    assert.equal(px(sheet,'.training-panel','minHeight'),0)
    const header=px(sheet,'.topbar','height')+px(sheet,'.topbar','marginTop')
    const footer=px(sheet,'.primary-footer','height')+px(sheet,'.primary-footer','marginBottom')
    const current=['.ex','.group','.inputs','.last-row','.navrow'].reduce((n,s)=>n+px(sheet,s,'height'),0)+px(sheet,'.set-dots','minHeight')
    assert.ok(header+current+footer<=450, 'Standard current set must show all dots and footer at 390x450')
    assert.ok(!tree.some(n=>n.class==='undo-label'), 'Completed-set hint must not add a scrolling row')
    const rest=['.rest-ex','.rest','.next','.effort-row','.rrow'].reduce((n,s)=>n+px(sheet,s,'height'),0)
    assert.ok(header+rest+px(sheet,'.rrow','marginBottom')<=450, 'Rest controls must fit without scrolling in standard state')
    assert.ok(px(sheet,'.rest','fontSize')>=88 && px(sheet,'.rest','height')>=px(sheet,'.rest','lineHeight'), 'Readable uncut countdown')
    assert.ok(px(sheet,'.rest','lineHeight')>=1.2*px(sheet,'.rest','fontSize'), 'Countdown font line box')
    assert.ok(px(sheet,'.ex','height')>=2*px(sheet,'.ex','lineHeight'), 'Two-line exercise title')
    assert.equal(sheet['.inputs'].flexDirection,'row', 'V4 horizontal prescription')
    assert.ok(px(sheet,'.weight-field','width')+px(sheet,'.times','width')+px(sheet,'.reps-field','width')<=338)
    assert.ok(px(sheet,'.fval','fontSize')>=56, 'Current numbers too small')
    assert.ok(tree.some(n => n.type==='div' && n.events?.click==='onCurrentSetAction' && n.children?.some(c => c.type==='image' && c.attr?.$src?.includes('/common/icons/check.svg'))), 'Complete/undo/pause vector missing')
    assert.ok(px(sheet,'.complete','height')>=64 && px(sheet,'.complete','width')>=300, 'Large labelled primary action')
    assert.ok(tree.some(n => n.class === 'complete-label'), 'Complete/undo action needs a readable text label')
    assert.ok(px(sheet,'.set-hit','width')>=48 && px(sheet,'.set-hit','height')>=48, 'Dot touch target')
    assert.equal(px(sheet,'.set-dot','width'),24, 'Readable normal dot')
    assert.equal(px(sheet,'.set-dot','height'),24, 'Round normal dot')
    assert.equal(px(sheet,'.set-current','width'),28, 'Readable current dot')
    assert.equal(px(sheet,'.set-current','height'),28, 'Round current dot')
    assert.ok(px(sheet,'.set-current','width')<px(sheet,'.set-hit','width'), 'Dot stays inside its 48px hit region')
    assert.equal(sheet['.set-dots'].flexWrap,'nowrap', 'Large dots use bounded pages without growing training height')
    const dot=tree.find(n=>n.repeat?.$exp==='setDots')
    assert.ok(dot && dot.children.length===1 && dot.children[0].type==='div', 'Set dot must not contain number/checkmark labels')
    assert.equal(dot.attr?.tid, 'key', 'Set dot repeat must preserve stable native row identity')
    for (const selector of ['.completion-panel','.effort-layer']) viewport(sheet[selector],selector)
    assert.ok(tree.some(n=>n.events?.click==='openExercises' && n.class==='ex'), 'Tap title must open exercise picker')
    assert.ok(tree.some(n=>n.events?.click==='askEnd' && n.class==='flag'), 'Flag must only request confirmation')
  } else if (page==='ExerciseList') {
    flexViewport(sheet,'.body'); assert.equal(sheet['.scroll'].height,'100%')
    assert.equal(px(sheet,'.body','minHeight'),0)
    assert.ok(px(sheet,'.title','height')+px(sheet,'.title','marginTop')+px(sheet,'.foot','height')+px(sheet,'.foot','marginBottom')<450)
    assert.ok(px(sheet,'.exname','width')+px(sheet,'.cnt','width')+px(sheet,'.expand-hit','width')<=px(sheet,'.exhead','width'))
    assert.ok(tree.some(n=>n.events?.$click?.includes('pickExercise(this.item')), 'Tap action name handler missing')
    assert.equal(sheet['.back'].flexDirection, 'row', 'Return icon and label must share a row')
    const round = sheet['@MEDIA'].find(m => m.condition === 'screen and (min-width: 450px)')
    const roundSheet = { ...sheet }
    for (const [selector, style] of Object.entries(round)) if (selector.startsWith('.')) roundSheet[selector] = { ...sheet[selector], ...style }
    for (const [name, styles] of [['GT1', sheet], ['round', roundSheet]]) {
      assert.ok(2 * px(styles,'.compact-action','width') <= px(styles,'.exit-row','width'), name + ': footer buttons overlap')
      assert.ok(px(styles,'.back-icon','width') + px(styles,'.back-icon','marginRight') + 4 * px(styles,'.back-label','fontSize') <= px(styles,'.compact-action','width'), name + ': return label clips')
      assert.ok(2 * px(styles,'.endbtn','height') <= px(styles,'.foot','height'), name + ': footer rows overlap')
    }
    for (const handler of ['onExit', 'abandonWorkout']) assert.ok(tree.some(n => n.events?.click === handler && (n.class || n.$class || '').includes('compact-action')), handler + ': compact footer class missing')

  } else if (page==='Index') {
    flexViewport(sheet,'.home-scroll')
    assert.ok(px(sheet,'.start-circle','height')>=88)
    assert.ok(tree.some(n => n.type==='div' && n.class==='start-circle' && n.events?.click==='onStart' && n.children?.some(c => c.type==='image' && c.attr?.src==='/common/icons/play.svg')), 'Start must retain drawn icon and original click target')
    assert.ok(tree.some(n => n.type === 'list' && n.class === 'home-scroll'), 'Large home cards must scroll as one surface')
  } else if (page==='Keypad') {
    flexViewport(sheet,'.editor-scroll')
    assert.ok(px(sheet,'.step','width')>=44 && px(sheet,'.step','height')>=44)
    assert.ok(2*px(sheet,'.step','width')+px(sheet,'.show','width')<=px(sheet,'.step-row','width'))
    assert.ok(px(sheet,'.show','fontSize')>=64)
    assert.ok(px(sheet,'.k','height')>=60 && px(sheet,'.cancel','height')>=64 && px(sheet,'.ok','height')>=64, 'Large keys and fixed Save/Cancel targets')
    assert.ok(template.children.some(n => n.class === 'actions'), 'Save/Cancel must remain outside the editor scroll')
    assert.ok(tree.some(n=>n.events?.click==='onKeyOk'), 'Explicit Save missing')
  } else if (page==='Summary') {
    flexViewport(sheet,'.scroll')
    assert.ok(px(sheet,'.metric-value','fontSize')>=48)
    assert.equal(sheet['.hr-value'].color,'#FF453A')
    assert.ok(tree.some(n=>n.events?.click==='onBack'), 'Done must return only')
  }
  console.log(page + ': full viewport, native scroll, GT1 interaction/layout contract verified')
}
