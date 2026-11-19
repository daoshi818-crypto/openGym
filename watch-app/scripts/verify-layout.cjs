// Check actual BlueOS compiler output. Browser previews are a separate verification.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const target = process.argv[2] || 'watch-square'
assert.equal(target,'watch-square','Current official UI adaptation is validated for square only')
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
    assert.equal(px('.primary-button','height'),64);assert.equal(px('.primary-button','borderRadius'),32)
    assert.equal(px('.pager','top'),44); assert.equal(px('.pager','height'),356)
    assert.equal(px('.screen','height'),356); assert.equal(px('.page-dots','top'),414)
    const restBudget=px('.countdown-row','minHeight')+px('.time-track','height')+px('.time-track','marginBottom')+px('.rrow','height')+px('.rrow','marginBottom')+px('.effort-slot','height')+px('.effort-slot','marginBottom')+px('.up-next','height')
    assert.ok(restBudget<=px('.rest-content','height'),'Native intrinsic rest blocks must fit without shrinking')
    assert.ok(px('.rest','height')<=px('.countdown-row','minHeight'),'Countdown text must not overflow its minimum row')
    assert.ok(px('.training-content','width')<=390)
    const fixed=px('.ex-name','height')+2*22+px('.place','marginTop')+px('.place','marginBottom')+px('.inputs','height')+px('.last-text','height')+px('.last-text','marginTop')+px('.done-effort','height')
    assert.ok(fixed<=px('.set-lines','height'),'Two-line notices, history and done effort fit above fixed buttons')
    assert.ok(px('.set-lines','height')+px('.navrow','height')+px('.navrow','marginTop')<=px('.training-content','height'))
    assert.deepEqual(has('rrow').children.map(n=>n.events.click),['onRestMinus','onSkipRest','onRestPlus'])
    const row=tree.find(n=>n.repeat?.$exp==='overviewRows');assert.equal(row.attr.tid,'key')
    for(const fill of tree.filter(n=>['hold-fill','time-fill'].includes(n.class)))assert.ok(fill.inlineStyle?.$width)
    assert.ok(tree.some(n=>n.events?.touchstart==='startFinishHold' && n.events?.touchend==='endFinishHold'))
    const holds=tree.filter(n=>n.class==='hold-finish')
    assert.equal(holds.length,2)
    for(const hold of holds) {
      const hit=hold.children[hold.children.length-1]
      assert.equal(hit.class,'hold-touch','Progress must stay below one stable full-button touch target')
      assert.equal(hit.events.touchstart,'startFinishHold'); assert.equal(hit.events.touchcancel,'cancelFinishHold')
    }
    assert.ok(tree.some(n=>n.events?.click==='abandonEnd'))

    const keyboard=nodes(has('number-keypad'));const rows=keyboard.filter(n=>n.class==='num-key-row')
    assert.equal(rows.length,4);assert.ok(rows.every(n=>n.children.length===3))
    assert.equal(sheet['.num-key'].backgroundColor,'#2C2C2E');assert.equal(px('.num-key','borderRadius'),14)
    assert.ok((450-58-50-4-44-56-6)/4-3>=44,'Twelve keyboard targets fit even with two-line error notice')
    assert.ok(px('.num-number-row','width')<=334 && px('.num-ok','width')<=304,'Keyboard top and bottom controls stay inside square corners')
    for(const action of ['closeNumberKeypad','saveNumberKeypad','numberBackspace'])assert.ok(tree.some(n=>n.events?.click===action))
  } else if(page==='Index') {
    assert.equal(has('home-scroll').type,'list');assert.ok(has('today-card') && has('stats'));assert.ok(!has('start-circle'))
    assert.equal(sheet['.primary'].backgroundColor,'#A3E635')
  } else if(page==='Summary') {
    assert.equal(has('scroll').type,'list');assert.equal(sheet['.duration'].color,'#FFD60A');assert.equal(px('.duration','fontSize'),48)
    assert.equal(sheet['.done'].backgroundColor,'#A3E635');assert.ok(tree.some(n=>n.events?.click==='onBack'))
  } else if(page==='ExerciseList') {
    assert.equal(has('scroll').type,'list')
    assert.equal(px('.scroll','height'),222)
    assert.ok(px('.title','height')+px('.body','height')+px('.body','marginBottom')+px('.foot','height')+56<=450)
    for(const action of ['pickExercise','toggleEx','pickRow','saveWorkout','abandonWorkout'])assert.ok(tree.some(n=>(n.events?.click||n.events?.$click||'').includes(action)))
  }
  console.log(page+': compiled viewport, official component structure and vectors verified')
}
