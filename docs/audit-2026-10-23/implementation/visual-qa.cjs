const { createRequire } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const bundled = createRequire('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json')
const { chromium } = bundled('playwright')
;(async () => {
  const browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}})
    const errors=[]; page.on('pageerror', e=>{ errors.push(e.message); console.log('PAGE ERROR',e.message) })
    await page.goto('http://127.0.0.1:5173')
    await page.waitForFunction(async()=> (await import('/src/store/useStore.js')).useStore.getState().ready)
    await page.evaluate(async()=> {
      const {useStore}=await import('/src/store/useStore.js')
      const {setLang}=await import('/src/lib/i18n.js'); await setLang('zh')
      const base=structuredClone(useStore.getState().S)
      const workout=(id,name,hour,rid,calories)=>({id,name,d:'2026-10-23',start:new Date('2026-10-23T'+hour+':00:00').getTime(),end:new Date('2026-10-23T'+hour+':45:00').getTime(),routineIds:[rid],entries:[{id:'0001',rid,sets:[{w:20,r:10,done:true}]}],vol:200,prs:[],calories,calorieSource:'watch_estimate'})
      base.lang='zh'
      base.workouts=[workout('chest','胸部训练','10','chest',286.4),workout('abs','腹部训练','11','abs',64)]
      base.routines=[{id:'chest',name:'胸部计划',ex:[{id:'0001',sets:3,reps:10},{id:'0002',sets:3,reps:10}]},{id:'abs',name:'腹部计划',ex:[]}]
      base.coach={...(base.coach||{}),profile:{goal:'muscle',daysPerWeek:3,sessionMin:60,equipment:[]},consent:{version:2,agreedAt:new Date().toISOString()},chat:[],log:[],snapshots:[]}
      useStore.setState({S:base,user:null,ready:true})
      window.qa={useStore}
      const {workoutDetailSheet}=await import('/src/sheets.jsx'); workoutDetailSheet(base.workouts[0])
    })
    await page.locator('.workout-calories-value').waitFor()
    const shots=[], metrics=[]
    for (const width of [320,360,390,430]) for (const theme of ['dark','light']) for (const scale of [1,2]) {
      await page.setViewportSize({width,height:950})
      await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.style.fontSize=16*scale+'px'}, {theme,scale})
      const m=await page.locator('.workout-calories-card').evaluate(el=> {
        const v=el.querySelector('.workout-calories-value'), source=el.querySelector('.workout-calories-source'), r=el.getBoundingClientRect()
        return {fontSize:parseFloat(getComputedStyle(v).fontSize),overflow:el.scrollWidth>el.clientWidth+1,right:r.right,left:r.left,valueColor:getComputedStyle(v).color,sourceColor:getComputedStyle(source).color,background:getComputedStyle(el).backgroundColor}
      })
      assert(m.fontSize>=24);assert(!m.overflow);assert(m.right<=width+1);assert(m.left>=0)
      metrics.push({width,theme,scale,...m})
      if(width===390&&scale===1||width===320&&scale===2) {const name=`calories-${width}-${theme}-${scale}x.png`;await page.screenshot({path:path.join(__dirname,name)});shots.push(name)}
    }
    await page.evaluate(async()=> {
      const {useStore}=window.qa
      const s=useStore.getState().S;useStore.setState({S:{...s,workouts:s.workouts.map(w=>w.id==='chest'?{...w,calories:12345}:w)}})
      document.documentElement.style.fontSize='32px'
    })
    await page.setViewportSize({width:320,height:950})
    assert(!(await page.locator('.workout-calories-card').evaluate(el=>el.scrollWidth>el.clientWidth+1)))
    await page.evaluate(async()=> {
      document.documentElement.style.fontSize='16px'
      const {useUI}=await import('/src/store/useUI.js');useUI.getState().closeAll()
      const React=(await import('/node_modules/.vite/deps/react.js')).default
      const {default:Picker}=await import('/src/components/CoachDebriefPicker.jsx')
      window.qa.confirmed=[]
      useUI.getState().openSheet(close=>React.createElement(Picker,{S:window.qa.useStore.getState().S,close,onConfirm:x=>window.qa.confirmed.push(x)}))
    })
    await page.locator('.coach-debrief-picker').waitFor({timeout:10000})
    await page.locator('.coach-debrief-picker button.lrow').filter({hasText:'胸部训练'}).click()
    assert.equal(await page.evaluate(()=>window.qa.confirmed.length),0)
    await page.screenshot({path:path.join(__dirname,'debrief-chest-preview.png')})
    await page.getByRole('button',{name:/^(开始复盘|Start debrief)$/}).click()
    assert.equal(await page.evaluate(()=>window.qa.confirmed[0]?.refs[0]?.value),'chest')
    await page.evaluate(async()=> {
      const {setLang}=await import('/src/lib/i18n.js');await setLang('en')
      const React=(await import('/node_modules/.vite/deps/react.js')).default
      const {default:Calories}=await import('/src/components/WorkoutCalories.jsx')
      const {useUI}=await import('/src/store/useUI.js')
      useUI.getState().openSheet(()=>React.createElement(Calories,{workout:{calories:99999,calorieSource:'watch_estimate'}}))
      document.documentElement.style.fontSize='32px'
    })
    assert(!(await page.locator('.workout-calories-card').evaluate(el=>el.scrollWidth>el.clientWidth+1)))
    await page.evaluate(async()=> {
      document.documentElement.style.fontSize='16px'
      const {useUI}=await import('/src/store/useUI.js');useUI.getState().closeAll()
      setTimeout(()=>{location.hash='/coach'},200)
    })
    const composer=page.locator('.composer textarea');await composer.waitFor({timeout:10000}).catch(async e=>{console.log(await page.evaluate(()=>({url:location.href,text:document.body.innerText.slice(-1500)})));throw e})
    await composer.fill('训练感觉很好')
    const before=await page.evaluate(()=>window.qa.useStore.getState().S.coach.chat.length)
    await composer.dispatchEvent('compositionstart')
    await composer.dispatchEvent('keydown',{key:'Enter',keyCode:13,bubbles:true})
    assert.equal(await page.evaluate(()=>window.qa.useStore.getState().S.coach.chat.length),before)
    await composer.dispatchEvent('compositionend')
    await composer.dispatchEvent('keydown',{key:'Enter',keyCode:13,bubbles:true})
    await page.waitForTimeout(100)
    await composer.dispatchEvent('keydown',{key:'Enter',keyCode:229,bubbles:true})
    await composer.dispatchEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})
    assert.equal(await page.evaluate(()=>window.qa.useStore.getState().S.coach.chat.length),before)
    await composer.press('Enter')
    await page.waitForFunction(n=>window.qa.useStore.getState().S.coach.chat.length>n,before,{timeout:5000}).catch(async e=>{console.log(await page.evaluate(()=>({text:document.body.innerText.slice(-1800),chats:window.qa.useStore.getState().S.coach.chat})));throw e})
    fs.writeFileSync(path.join(__dirname,'visual-qa.json'),JSON.stringify({metrics,shots,errors,chestSelection:true,longNumber:true,englishLongNumber:true,ime:true},null,2))
    assert.equal(errors.length,0,errors.join('\n'))
    console.log('Visual QA passed: 16 viewport/theme/font cases, long number, explicit chest selection.')
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
