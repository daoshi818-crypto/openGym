// Check actual BlueOS compiler output. Browser previews are a separate verification.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const target = process.argv[2] || 'watch-square'
assert.equal(target,'watch-square','0.6.33 official UI is validated for square only')
const build = process.env.BLUEOS_BUILD_ROOT ? path.resolve(process.env.BLUEOS_BUILD_ROOT,target) : path.resolve(__dirname,'../build',target)
const read = name => JSON.parse(fs.readFileSync(path.join(build,name),'utf8'))
const manifest=read('manifest.json'), nodes=n=>[n,...(n.children||[]).flatMap(nodes)]
assert.deepEqual(manifest.deviceTypeList,[target]); assert.equal(manifest.config.designWidth,390)
assert.ok(!manifest.features.some(f=>f.name==='blueos.storage.file'))
for(const page of Object.keys(manifest.router.pages)) {
  const template=read(page+'/index.template.json'), sheet=Object.values(read(page+'/index.css.json'))[0], tree=nodes(template)
  const has=name=>tree.find(n=>n.class===name), px=(sel,key)=>parseFloat(sheet[sel]?.[key]||0)
  assert.equal(template.style.width,'100%');assert.equal(template.style.height,'100%');assert.equal(template.style.backgroundColor,'#000000')
  assert.ok(!/[\p{Extended_Pictographic}\uFE0F✓▶♥↶]/u.test(JSON.stringify(template)),'Use vector glyphs')
  assert.ok(!sheet['@MEDIA']?.some(m=>m.condition?.includes('device:')),'Compiler resolves shape styles')
  for(const node of tree.filter(n=>n.type==='image')) {
    assert.ok(!node.events,'Put events on parent targets')
    const sources=node.attr?.src?[node.attr.src]:[...(node.attr?.$src||'').matchAll(/['"](\/common\/icons\/[^'"]+\.svg)['"]/g)].map(m=>m[1])
    assert.ok(sources.length,'Verifiable local vector source required')
    for(const src of sources) {
      assert.ok(src.startsWith('/common/icons/'))
      assert.equal(fs.readFileSync(path.join(build,src.slice(1)),'utf8'),fs.readFileSync(path.join(__dirname,'../src',src.slice(1)),'utf8'))
    }
  }
  if(page==='Workout') {
    const live=has('screen live-screen');assert.ok(live && !nodes(live).some(n=>n.type==='list'),'Set/rest never scroll')
    assert.equal(has('overview-scroll').type,'list')
    for(const name of ['screen overview-screen','screen live-screen','screen metrics-screen']) {
      const screen = has(name)
      assert.ok(screen?.attr?.$show, 'Pager must reuse bounded native trees via show')
      assert.ok(!screen.$shown, 'Pager must not destroy a native subtree on every swipe')
    }
    assert.equal(sheet['.last-text'].textOverflow, 'ellipsis', 'BlueOS default clip cuts history text mid-glyph')
    assert.ok(px('.navrow','width') <= 336, 'Inset footer arrows from physical square corners')
    for (const action of ['onMenuAddSet','onMenuRemoveSet','onPause','openLastEffort','showDiagnostics','openLast']) {
      assert.ok(!tree.some(n => n.events?.click === action), 'Remove non-upstream product entry: ' + action)
    }
    assert.ok(!has('screen media-screen'), 'Music page removed at user request')
    assert.equal(has('page-dots').children.length,3);assert.equal(has('navrow').children.length,3)
    for(const [sel,color] of [['.primary-button','#A3E635'],['.field','#1A2508']])assert.equal(sheet[sel].backgroundColor,color)
    assert.equal(sheet['.rest'].color,'#A3E635');assert.equal(sheet['.metric-time'].color,'#FFD60A')
    assert.equal(px('.primary-button','height'),77);assert.equal(px('.primary-button','borderRadius'),39)
    assert.ok(px('.training-content','width')<=390)
    const fixed=px('.training-content','paddingTop')+px('.training-content','paddingBottom')+px('.ex-name','minHeight')+px('.place','minHeight')+px('.place','marginTop')+px('.place','marginBottom')+px('.inputs','height')+px('.last-text','minHeight')+px('.last-text','marginTop')+px('.navrow','height')+px('.navrow','marginTop')+px('.page-dots','height')
    assert.ok(fixed+24<=450,'Done-row effort must fit above page dots')
    assert.deepEqual(has('rrow').children.map(n=>n.events.click),['onRestMinus','onSkipRest','onRestPlus'])
    const row=tree.find(n=>n.repeat?.$exp==='overviewRows');assert.equal(row.attr.tid,'key')
    for(const fill of tree.filter(n=>['hold-fill','time-fill'].includes(n.class)))assert.ok(fill.inlineStyle?.$width)
    assert.ok(tree.some(n=>n.events?.touchstart==='startFinishHold' && n.events?.touchend==='cancelFinishHold'))
    assert.ok(tree.some(n=>n.events?.click==='abandonEnd'))
  } else if(page==='Keypad') {
    assert.ok(!tree.some(n=>n.type==='list'));const rows=tree.filter(n=>n.class==='key-row')
    assert.equal(rows.length,4);assert.ok(rows.every(n=>n.children.length===3))
    assert.equal(sheet['.key'].backgroundColor,'#2C2C2E');assert.equal(px('.key','borderRadius'),14)
    assert.ok((450-14-48-4-54-3)/4-3>=44,'Twelve keyboard touch targets fit one screen')
    for(const action of ['onCancel','onKeyOk','backspace'])assert.ok(tree.some(n=>n.events?.click===action))
  } else if(page==='Index') {
    assert.equal(has('home-scroll').type,'list');assert.ok(has('today-card') && has('stats'));assert.ok(!has('start-circle'))
    assert.equal(sheet['.primary'].backgroundColor,'#A3E635')
  } else if(page==='Summary') {
    assert.equal(has('scroll').type,'list');assert.equal(sheet['.duration'].color,'#FFD60A');assert.equal(px('.duration','fontSize'),48)
    assert.equal(sheet['.done'].backgroundColor,'#A3E635');assert.ok(tree.some(n=>n.events?.click==='onBack'))
  } else if(page==='ExerciseList') {
    assert.equal(has('scroll').type,'list')
    for(const action of ['pickExercise','toggleEx','pickRow','saveWorkout','abandonWorkout'])assert.ok(tree.some(n=>(n.events?.click||n.events?.$click||'').includes(action)))
  }
  console.log(page+': compiled viewport, official component structure and vectors verified')
}
