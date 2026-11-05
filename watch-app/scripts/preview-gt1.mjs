// Code-derived preview, NOT a BlueOS emulator or device screenshot.
// Compile watch-square first. Usage: node scripts/preview-gt1.mjs <output directory>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { stripImports, watchSource, watchPersistence, loadWatchModule, watchInteractionDeps } from '../../frontend/src/lib/watch-test-harness.js'
import * as effort from '../src/lib/effort-scale.js'
import * as protocol from '../src/lib/protocol.js'
import * as summaryView from '../src/lib/summary-view.js'
import { lastTimeView } from '../src/lib/watch-last-time.js'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.resolve(process.argv[2] || path.join(root, 'preview-gt1'))
fs.mkdirSync(out, { recursive: true })
const clone = x => JSON.parse(JSON.stringify(x))
function environment() {
  const { ctx, disk, storage } = watchPersistence()
  Object.assign(ctx, { ...protocol, Date, console, setTimeout: () => 1, clearTimeout() {} })
  loadWatchModule('event-id', ctx, ['allocateEventIdentity', 'rememberEventAt'])
  loadWatchModule('close-journal', ctx, ['prepareClose', 'releaseCandidate', 'pendingSummaries', 'pendingEntry', 'journalEntry', 'markPhase', 'markDelivered'])
  loadWatchModule('session', ctx, ['loadState', 'startSession', 'save', 'replacePlan', 'applySync', 'nextUndone', 'nextUndoneFrom', 'setRowValue', 'toggleSet', 'addSet', 'removeSet', 'addRestTime', 'calories', 'endSession', 'closeSession', 'buildSessionSummary', 'summaryEventOf', 'setEffort'])
  return { ctx, disk, storage }
}
const plan = { id: 'p1', sid: 'preview', name: '推部训练', workout: '推部训练', effortScale: 'rpe', weightUnit: 'kg', exercises: [
  { entryInstanceId: 'bench', name: '杠铃卧推', sets: 4, weight: '62.5', reps: '8', rest: 90, lastTime: { date: '2026-11-02', weightUnit: 'kg', rows: [{label:'60 × 10'},{label:'60 × 8'},{label:'57.5 × 10'}] } },
  { entryInstanceId: 'fly', name: '上斜哑铃飞鸟', sets: 3, weight: '15', reps: '12', rest: 90 },
  { entryInstanceId: 'push', name: '坐姿哑铃肩上推举', sets: 3, weight: '20', reps: '10', rest: 90 },
  { entryInstanceId: 'triceps', name: '绳索三头肌下压', sets: 3, weight: '25', reps: '12', rest: 60 },
] }
function page(name, env = environment()) {
  const ctx = { ...env.ctx, ...watchInteractionDeps, ...effort, ...summaryView, lastTimeView, WATCH_VERSION: 'preview',
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    startServer() {}, sendEvent() {}, sendControl() {}, pendingCount: () => 0, isConnected: () => true,
    persistenceStatus: () => ({}), synchronizationStatus: () => ({}), transportDiagnostics: () => ({events:[], pending:0}),
    startSessionHr() {}, stopSessionHr() {}, tick() {}, restOver() {}, brightness: { setKeepScreenOn() {} },
    router: {push() {}, replace() {}, back() {}} }
  const code = stripImports(watchSource(name + '/index.ux').match(/<script>([\s\S]*?)<\/script>/)[1])
  runInNewContext(code.replace('export default', 'this.page ='), ctx)
  return Object.assign(ctx.page, clone(ctx.page.data))
}
function workout(configure = () => {}) {
  const env = environment(); const s = env.ctx.startSession(clone(plan))
  s.startedAt = Date.now() - 32 * 60000; s.effortScale = 'rpe'; s.setIdx = 2
  s.workout.rows[0][0].done = true; s.workout.rows[0][0].at = Date.now() - 120000
  s.workout.rows[0][1].done = true; s.workout.rows[0][1].at = Date.now() - 110000
  configure(s); env.ctx.save(s)
  const p = page('Workout', env); p.onInit({}); p.hrLabel = '♥ 118'; p.clockLabel = '9:23'
  return p
}
const scenes = []
function scene(id, name, p, title, bottom = false) {
  if (name === 'Workout') p.clockLabel = '9:23'
  const state = Object.fromEntries(Object.entries(p).filter(([k,v]) => k !== 'data' && typeof v !== 'function'))
  const template = JSON.parse(fs.readFileSync(path.join(root, 'build/watch-square', name, 'index.template.json'), 'utf8'))
  const css = watchSource(name + '/index.ux').match(/<style>([\s\S]*?)<\/style>/)[1]
  scenes.push({ id, name, state, template, css, title, bottom })
}
let env = environment(); env.disk.set('plan_catalog', { plans: [plan, {...plan, id: 'pull', name: '拉部训练'}, {...plan, id: 'legs', name: '腿部训练'}] })
let p = page('Index', env); p.onInit({}); scene('01-home','Index',p,'开始训练')
p = page('Index'); p.onInit({}); scene('02-empty','Index',p,'首次同步空态')
scene('03-current','Workout',workout(),'当前组 · RPE')
scene('04-no-history','Workout',workout(s => { delete s.workout.exercises[0].lastTime; s.effortScale = 'none' }),'无历史 · 无评分')
p=workout(s => {s.workout.exercises[0].name='这是一个用于验证两行显示的很长的训练动作名称';s.workout.rows[0][2].w='99999';s.workout.rows[0][2].r='99999'}); scene('05-large','Workout',p,'长名称 · 五位数值')
p=workout(s => {s.restUntil=Date.now()+90000;s.effortScale='rir';s.workout.rows[0][1].effortKind='rir';s.workout.rows[0][1].rir=0});scene('06-rest','Workout',p,'休息 · RIR 0')
p=workout();p.openEffort();p.effortDraft=8.5;p.effortDraftLabel='8.5';p.effortMeaning='还可再做约 1–2 次';scene('07-effort','Workout',p,'评分选择')
p=workout();p.openLast();scene('08-history','Workout',p,'上次训练详情')
p=workout(s=>{s.workout.exercises[0].lastTime.rows=Array.from({length:40},(_,i)=>({label:'60 × '+(10-i%3)}))});p.openLast();scene('09-long-history','Workout',p,'长历史 · 底部',true)
p=workout();p.openFinish();scene('10-finish','Workout',p,'结束入口')
p=workout();p.openFinish();p.askEnd();scene('11-confirm','Workout',p,'结束二次确认')
p=workout(s=>s.workout.rows.forEach(rows=>rows.forEach(r=>{r.done=true;r.at=Date.now()})));scene('12-complete','Workout',p,'全部完成')
p=workout();p.pageIndex=1;scene('13-operations','Workout',p,'训练操作');scene('14-operations-bottom','Workout',p,'训练操作 · 底部',true)
env=environment();env.ctx.startSession(clone(plan));p=page('ExerciseList',env);p.onInit();p.expanded=0;scene('15-exercises','ExerciseList',p,'点击动作名切换')
p=page('Keypad',env);p.onInit({exIdx:0,setIdx:0,field:'w'});scene('16-editor','Keypad',p,'重量编辑 · 表冠')
p.useKeyboard();scene('17-keyboard','Keypad',p,'精确键盘 · 底部',true)
env.disk.set('summary_last',{sid:'preview',workout:'推部训练',minutes:64,sets:Array.from({length:13},()=>({done:true})),volume:5230,weightUnit:'kg',avgHr:118,maxHr:142,calories:382})
p=page('Summary',env);p.onInit();p.clockLabel='9:23';scene('18-summary','Summary',p,'总结 · 上半屏');scene('19-summary-bottom','Summary',p,'总结 · 下半屏',true)
scene('20-done-row','Workout',workout(s=>{s.setIdx=1}),'已完成组 · 撤销')
scene('21-many-dots','Workout',workout(s=>{s.workout.rows[0]=Array.from({length:100},(_,i)=>({setId:'many'+i,w:'62.5',r:'8',done:i<2}));s.workout.exercises[0].sets=100}),'100 组 · 分页圆点')
scene('22-timed-wide','Workout',workout(s=>{s.workout.exercises[0].reps='99999秒';s.workout.rows[0][2].r='99999';s.workout.rows[0][2].w='99999.999'}),'极值 · 单位不裁切')
scene('23-rest-no-effort','Workout',workout(s=>{s.restUntil=Date.now()+90000;s.effortScale='none'}),'休息 · 关闭评分')
env=environment();p=page('Summary',env);p.onInit();p.clockLabel='9:23';scene('24-summary-missing','Summary',p,'总结 · 无历史统计')
env=environment();env.disk.set('plan_catalog',{plans:[plan]});env.disk.set('summary_last',{savedAt:Date.now()});p=page('Index',env);p.onInit({});scene('25-home-summary','Index',p,'首页 · 最近结果入口')
env=environment();env.ctx.startSession(clone(plan));p=page('Index',env);p.onInit({});scene('26-resume','Index',p,'恢复进行中训练')
p=page('Index',env);p.onInit({conflict:JSON.stringify({...plan,sid:'phone-session'})});scene('27-conflict','Index',p,'手机训练冲突确认')
scene('28-paused','Workout',workout(s=>{s.pausedAt=Date.now()}),'暂停 · 禁止误完成')
env=environment();env.ctx.startSession(clone(plan));p=page('ExerciseList',env);p.onInit();p.endOn=true;scene('29-exercise-end','ExerciseList',p,'动作列表 · 结束操作')
const runtime = `
function val(exp,ctx){if(typeof exp!=='string')return exp;if(exp.startsWith('function'))return Function('return ('+exp+')')().call(ctx);return exp.split('.').reduce((a,k)=>a?.[k],ctx)}
function render(n,ctx){if(n.repeat){let frag=document.createDocumentFragment();for(const item of val(n.repeat.$exp,ctx)||[]){let sub=Object.create(ctx);sub[n.repeat.value]=item;frag.append(render({...n,repeat:null},sub))}return frag}if(n.$shown&&!val(n.$shown,ctx))return document.createDocumentFragment();const el=document.createElement(n.type==='input'?'button':n.type==='text'?'native-text':'div');el.className=(n.$class?val(n.$class,ctx).flat(Infinity).filter(Boolean).join(' '):n.class||'');el.dataset.type=n.type;let a=n.attr||{};if(a.id)el.id=a.id;if(a.$disabled)el.disabled=!!val(a.$disabled,ctx);if(n.style)Object.assign(el.style,n.style);if(n.type==='text'||n.type==='input'){let text=a.$value?val(a.$value,ctx):a.value||'';let span=document.createElement('span');span.textContent=text??'';el.append(span)}for(let c of n.children||[])el.append(render(c,ctx));return el}
document.querySelector('#viewport').append(render(SCENE.template,SCENE.state));
for(let el of document.querySelectorAll('[data-type="text"]')){const lines=getComputedStyle(el).getPropertyValue('lines').trim();if(lines){el.firstChild.style.webkitLineClamp=lines}}
if(SCENE.bottom)for(let el of document.querySelectorAll('[data-type="list"]'))el.scrollTop=el.scrollHeight;
`
const base=`html,body{margin:0;width:100%;height:100%;background:#000;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:#fff}*{box-sizing:border-box}#viewport{width:100vw;height:100vh;position:relative;overflow:hidden}div,button,native-text{display:flex;position:relative;flex-direction:row;flex-shrink:0;min-width:0}button{padding:0;border:0;align-items:center;justify-content:center;font:inherit;cursor:pointer}button:disabled{opacity:.4}native-text{align-items:center;overflow:hidden;white-space:normal}native-text>span{max-width:100%;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;line-height:inherit;flex:1}button>span{line-height:1.15}[data-type="list"]{display:block;overflow-y:auto;overflow-x:hidden;min-height:0;scrollbar-width:none}[data-type="list"]::-webkit-scrollbar{display:none}[data-type="list-item"]{flex-shrink:0}`
// Native-only `lines` is translated to CSS line clamp; remaining CSS is the shipped .ux stylesheet.
for (const s of scenes) {
  const css=s.css.replace(/\blines:\s*(\d+);/g,'-webkit-line-clamp: $1;')
  const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+s.title+' · code preview NOT device</title><style>'+base+'\n'+css+'</style><body><div id="viewport"></div><script>const SCENE='+JSON.stringify(s).replaceAll('</','<\\/')+';'+runtime+'</script></body></html>'
  fs.writeFileSync(path.join(out,s.id+'.html'),html)
}
fs.writeFileSync(path.join(out,'scenes.json'),JSON.stringify(scenes.map(({id,title,bottom})=>({id,title,bottom})),null,2))
const cards=scenes.map(s=>'<article><h2>'+s.title+'</h2><iframe src="'+s.id+'.html" width="390" height="450"></iframe><a href="'+s.id+'.html">390 × 450 单屏</a></article>').join('')
fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>GT1 390×450 实现审阅</title><style>body{background:#121417;color:#fff;font:16px Segoe UI,Microsoft YaHei,sans-serif;margin:36px}h1{color:#30d158}main{display:flex;flex-wrap:wrap;gap:28px}article{background:#202329;padding:18px;border-radius:24px}h2{font-size:18px}iframe{border:1px solid #41434a;border-radius:40px;background:#000}a{display:block;color:#30d158;margin-top:12px}</style><h1>GT1 · 390 × 450 重构实现</h1><p>从本轮原生编译模板和实际 .ux CSS 生成，页面数据由真实脚本生成。浏览器语义适配预览，非真机截图，不包含固件字体与原生渲染差异。</p><main>'+cards+'</main></html>')
console.log('Generated '+scenes.length+' code-derived scenes in '+out)
