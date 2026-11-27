// Code-derived preview, NOT a BlueOS emulator or device screenshot.
// Uses current .ux source by default; WATCH_PREVIEW_SOURCE=0 reads compiled templates.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { stripImports, watchSource, watchPersistence, loadWatchModule, watchInteractionDeps } from '../../frontend/src/lib/watch-test-harness.js'
import * as effort from '../src/lib/effort-scale.js'
import * as protocol from '../src/lib/protocol.js'
import * as summaryView from '../src/lib/summary-view.js'
import { lastTimeView } from '../src/lib/watch-last-time.js'
import { sourceTemplate } from './source-template.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.resolve(process.argv[2] || path.join(root, 'preview-gt1'))
const target = process.argv[3] || 'watch-square'
const fromSource = process.env.WATCH_PREVIEW_SOURCE !== '0'
const squareRadius = Number(process.env.WATCH_PREVIEW_RADIUS || 100)
if (!(squareRadius >= 0 && squareRadius <= 195)) throw new Error('Invalid preview corner radius')
const view = target === 'watch-round' ? { width: 466, height: 466, radius: 233 } : { width: 390, height: 450, radius: squareRadius }
fs.mkdirSync(out, { recursive: true })
const fonts = process.env.WATCH_PREVIEW_FONTS
let fontCss = ''
if (fonts) {
  fs.mkdirSync(path.join(out, 'fonts'), { recursive: true })
  for (const [weight, name] of [[400,'HanyiVar-vivo-60S.ttf'],[700,'HanyiVar-vivo-70S.ttf']]) {
    fs.copyFileSync(path.join(fonts, name), path.join(out, 'fonts', name))
    fontCss += `@font-face{font-family:WatchSDK;src:url('./fonts/${name}');font-weight:${weight};font-style:normal;}`
  }
}
fs.writeFileSync(path.join(out, 'preview-config.json'), JSON.stringify({ target, fromSource, sdkFonts: !!fonts, ...view }))
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
    startServer() {}, replayPendingEvents() {}, sendEvent() {}, sendControl() {}, pendingCount: () => 0, isConnected: () => true,
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
  s.hr={count:3,sum:354,max:120,min:116,last:118,sampleAt:Date.now(),bpmSeconds:{116:10,120:10}}
  s.workout.rows[0][0].done = true; s.workout.rows[0][0].at = Date.now() - 120000
  s.workout.rows[0][1].done = true; s.workout.rows[0][1].at = Date.now() - 110000
  configure(s); env.ctx.save(s)
  const p = page('Workout', env); p.onInit({}); p.hrLabel = '心率 118'; p.clockLabel = '9:23'
  return p
}
const scenes = []
function scene(id, name, p, title, bottom = false) {
  if (name === 'Workout') p.clockLabel = '9:23'
  const state = Object.fromEntries(Object.entries(p).filter(([k,v]) => k !== 'data' && typeof v !== 'function'))
  const template = fromSource ? sourceTemplate(watchSource(name + '/index.ux')) : JSON.parse(fs.readFileSync(path.join(root, 'build/' + target, name, 'index.template.json'), 'utf8'))
  const css = watchSource(name + '/index.ux').match(/<style>([\s\S]*?)<\/style>/)[1]
  scenes.push({ id, name, state, template, css, title, bottom })
}
let env = environment()
let p = page('Index', env); p.onInit({}); scene('01-home','Index',p,'待机 · 请打开手机端的 OpenGym')
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
p=page('Workout',env);p.onInit({});p.selectField('w');scene('16-editor','Workout',p,'训练页 · 选中重量 / 表冠草稿')
p.openNumberKeypad('w');scene('17-keyboard','Workout',p,'精确键盘 · 完整一屏')
env.disk.set('summary_last',{sid:'preview',workout:'推部训练',minutes:64,sets:Array.from({length:13},()=>({done:true})),volume:5230,weightUnit:'kg',avgHr:118,maxHr:142,calories:382})
p=page('Summary',env);p.onInit();p.clockLabel='9:23';scene('18-summary','Summary',p,'总结 · 上半屏');scene('19-summary-bottom','Summary',p,'总结 · 下半屏',true)
scene('20-done-row','Workout',workout(s=>{s.setIdx=1}),'已完成组 · 撤销')
scene('21-many-dots','Workout',workout(s=>{s.workout.rows[0]=Array.from({length:100},(_,i)=>({setId:'many'+i,w:'62.5',r:'8',done:i<2}));s.workout.exercises[0].sets=100}),'100 组 · 分页圆点')
scene('22-timed-wide','Workout',workout(s=>{s.workout.exercises[0].reps='99999秒';s.workout.rows[0][2].r='99999';s.workout.rows[0][2].w='99999.999'}),'极值 · 单位不裁切')
scene('23-rest-no-effort','Workout',workout(s=>{s.restUntil=Date.now()+90000;s.effortScale='none'}),'休息 · 关闭评分')
env=environment();p=page('Summary',env);p.onInit();p.clockLabel='9:23';scene('24-summary-missing','Summary',p,'总结 · 无历史统计')
env=environment();env.disk.set('summary_last',{savedAt:Date.now()});p=page('Index',env);p.onInit({});scene('25-home-summary','Index',p,'首页 · 最近结果入口')
env=environment();env.ctx.startSession(clone(plan));p=page('Index',env);p.onInit({});scene('26-resume','Index',p,'恢复进行中训练')
await env.ctx.recordPhoneConflict({...plan,sid:'phone-session'});p=page('Index',env);p.onInit({});scene('27-conflict','Index',p,'冲突 · 保存或放弃手表训练')
p.conflictWaiting=true;p.conflictHint='正在处理手表训练，等待手机确认…';scene('81-conflict-waiting','Index',p,'冲突 · 等待手机持久确认')
p.conflictWaiting=false;p.conflictHint='存储失败，手表训练仍保留，请重试。';scene('82-conflict-failed','Index',p,'冲突 · 存储失败与重试')
env=environment();p=page('Index',env);p.onInit({});p.phoneLinkLabel='手机已连接';scene('83-home-connected','Index',p,'首页 · 手机已确认连接')
scene('28-paused','Workout',workout(s=>{s.pausedAt=Date.now()}),'暂停 · 禁止误完成')
env=environment();env.ctx.startSession(clone(plan));p=page('ExerciseList',env);p.onInit();p.endOn=true;scene('29-exercise-end','ExerciseList',p,'动作列表 · 结束操作')
env=environment();env.ctx.startSession(clone(plan));p=page('Workout',env);p.onInit({});p.selectField('r');p.selectField('r');scene('30-keyboard-reps','Workout',p,'次数键盘 · 完整一屏')
p.keypadNotice='目标已变化，未保存';scene('31-keyboard-notice','Workout',p,'键盘 · 长动作名与过期提示')
env=environment();env.ctx.startSession({...clone(plan),name:'这是一个用于验证两行训练名称显示的推部训练计划'});env.disk.set('summary_last',{savedAt:Date.now()});p=page('Index',env);p.onInit({});scene('32-home-long','Index',p,'首页 · 长计划名与最近结果')
p=workout();p.openFinish();scene('33-finish-bottom','Workout',p,'结束页 · 放弃入口',true)
p=workout();p.openFinish();p.askAbandon();scene('34-abandon-confirm','Workout',p,'放弃训练 · 独立确认')
p=workout(s=>{s.workout.rows[0][2].w='99999.999';s.workout.rows[0][2].r='99999'});p.pageIndex=2;p.syncLabel='正在同步训练记录，请保持连接';scene('35-operation-long','Workout',p,'操作页 · 长数值与同步状态')
p=workout();p.inputNotice='同步中，请稍候再编辑';scene('36-current-notice','Workout',p,'当前组 · 输入提示')
p=workout();p.diagnosticOn=true;p.diagnosticTitle='同步诊断 1/3';p.diagnosticText='圆点待处理：否\n本地保存：成功\n页面状态：已更新\n'+('同步事件已确认\n'.repeat(12));scene('37-diagnostics','Workout',p,'同步诊断 · 大字')
p=workout();p.openEffort();p.effortDraftLabel='0';p.effortMeaning='还能再做零次';p.effortNotice='手机已更改本组评分，请确认后重新保存';p.effortHasSaved=true;scene('38-effort-notice','Workout',p,'评分 · 过期提示与清除')
p=workout(s=>{s.workout.exercises[0].sets=7;s.workout.rows[0]=Array.from({length:7},(_,i)=>({setId:'seven'+i,w:'62.5',r:'8',done:i<2}))});scene('39-seven-dots','Workout',p,'七组 · 大触控分页')
p=workout(s=>{s.workout.exercises[0].sets=5;s.workout.rows[0]=Array.from({length:5},(_,i)=>({setId:'five'+i,w:'62.5',r:'8',done:i<2}))});scene('40-five-dots','Workout',p,'五组 · 全部切组按钮')
p=workout(s=>{s.workout.exercises[0].name='这是一个很长的训练动作名称用于检查休息页面';s.restUntil=Date.now()+90000});scene('41-rest-long','Workout',p,'休息 · 长动作名')
p=workout(s=>{s.workout.exercises[0].name='这是一个很长的训练动作名称用于检查两行';s.workout.rows[0][2].w='99999.999';s.workout.rows[0][2].r='99999'});scene('42-main-long','Workout',p,'训练 · 长名称与极值')
env=environment();env.ctx.startSession(clone(plan));p=page('Workout',env);p.onInit({});p.selectField('w');p.keypadValue='99999.999';p.keypadNotice='存储失败，未保存，请重试';scene('43-editor-notice','Workout',p,'训练页 · 表冠草稿及错误提示')
p.openNumberKeypad('w');p.keypadValue='99999.999';p.keypadNotice='请输入有效数值';scene('44-keyboard-wide','Workout',p,'重量键盘 · 极值与保存失败提示')
p.keypadNotice='请输入有效数值';scene('45-keyboard-saving','Workout',p,'重量键盘 · 非法数值提示')
p=workout();p.selectedField='w';scene('46-selected-weight','Workout',p,'重量选中边框 · 字形完整')
p=workout(s=>{s.weightUnit='lb';s.workout.rows[0][2].w='80.5';s.workout.rows[0][2].r='18'});p.selectedField='r';scene('47-selected-reps','Workout',p,'次数选中边框 · lb 与大数字')
p=workout(s=>{s.workout.exercises[0].reps='60秒';s.workout.rows[0][2].r='60'});p.selectedField='r';scene('48-selected-timed','Workout',p,'时长选中边框 · 秒单位')
const longNames = [
  '上斜哑铃交替卧推（慢速离心三秒并在最低点停顿，双手保持中立握距）',
  'Single Arm Incline Dumbbell Bench Press with Three Second Eccentric Pause',
  'SingleArmInclineDumbbellBenchPressWithThreeSecondEccentricPause',
]
for (let i=0;i<longNames.length;i++) {
  scene('49-long-name-'+i,'Workout',workout(s=>{s.workout.exercises[0].name=longNames[i]}),'长动作名 · '+i)
  env=environment();env.ctx.startSession({...clone(plan),exercises:[{...clone(plan.exercises[0]),name:longNames[i]}]})
  p=page('ExerciseList',env);p.onInit({detailEx:'0'});scene('50-full-name-'+i,'ExerciseList',p,'完整动作名 · '+i)
}
p=workout(s=>{s.workout.exercises[0].name=longNames[0];s.restUntil=Date.now()+90000});scene('51-long-rest','Workout',p,'长动作名休息 · 组号独立')
p=workout();p.inputNotice='请先同步或恢复存储后再编辑';scene('52-input-warning','Workout',p,'错误提示 · 保留全宽')
p=workout();p.pageIndex=0;scene('53-official-overview','Workout',p,'官方概览 · 当前与已完成动作')
scene('54-official-overview-actions','Workout',p,'官方结束控件 · 保留本地操作入口',true)
p=workout();p.pageIndex=2;scene('55-official-numbers','Workout',p,'官方统计 · 数值')
p=workout(s=>{s.hr={count:3,sum:360,max:150,min:100,last:110,sampleAt:Date.now(),bpmSeconds:{100:12,120:30,150:5}}});p.pageIndex=2;p.metricKind='pulse';scene('56-official-pulse','Workout',p,'心率统计 · 曲线尚未移植')
p.metricKind='zones';scene('57-official-no-age','Workout',p,'官方心率区间 · 真实缺年龄空态')
p=workout(s=>{s.profile={birthYear:1996};s.hr={count:4,sum:552,max:169,min:112,last:150,sampleAt:Date.now(),bpmSeconds:{112:30,113:12,150:3,169:15}}});p.pageIndex=2;p.metricKind='zones';scene('58-official-zones','Workout',p,'官方心率区间 · 真实样本计算')
p=workout(s=>{s.workout.exercises[0].muscles={chest:1,triceps:.5,deltoids:.3}});p.pageIndex=2;p.metricKind='muscles';scene('59-official-muscles','Workout',p,'官方肌群 · 完成组权重计算')
p=workout();p.pageIndex=2;p.metricKind='muscles';scene('60-muscles-no-metadata','Workout',p,'已有训练 · 缺肌肉元数据')
p=workout(s=>{s.workout.exercises[0].name='哑铃推肩';s.startedAt=Date.now()-30000;s.restUntil=Date.now()+63000});scene('66-device-rest-rpe','Workout',p,'实拍反馈复现 · 1:03 / 未评 RPE')
p=workout(s=>{s.restUntil=Date.now()+900000});scene('67-rest-max','Workout',p,'休息上限 · 15:00 / 未评 RPE')
p=workout(s=>{s.restUntil=Date.now()+63000;s.workout.exercises[0].name=longNames[0];s.workout.rows[0][2].w='99999.999';s.workout.rows[0][2].r='99999'});scene('68-rest-wide-next','Workout',p,'休息 · 长动作名 / 极值重量次数 / 组号独立')
p=workout();p.pageIndex=0;scene('69-finish-overview','Workout',p,'总览 · 结束训练与放弃训练',true)
p=workout();p.openFinish();p.askEnd();p.closeSaving=true;scene('84-confirm-saving','Workout',p,'结束确认 · 本地保存中')
p=workout(s=>s.workout.rows.forEach(rows=>rows.forEach(r=>{r.done=true;r.at=Date.now()})));scene('85-complete-options','Workout',p,'全部完成 · 强度、结束或继续训练')
p=workout();p.closeMode='end';p.closeFrozen=true;p.closeError='训练记录已保留，存储收尾未完成，请重试';scene('86-close-retry','Workout',p,'部分完成 · 冻结关闭重试')
p=workout(s=>s.workout.rows.forEach(rows=>rows.forEach(r=>{r.done=true;r.at=Date.now()})));p.closeFrozen=true;p.closeError='训练记录已保留，存储收尾未完成，请重试';scene('87-complete-retry','Workout',p,'全部完成 · 冻结关闭重试')
p=workout();p.askAbandon();p.closeError='存储失败，未结束，请重试';scene('70-abandon-error','Workout',p,'放弃确认 · 存储错误可重试')
env=environment();env.ctx.startSession(clone(plan));p=page('Workout',env);p.onInit({});p.selectField('w');p.openNumberKeypad('w');p.keypadValue='99999.999';p.keypadNotice='存储失败，未保存，请重试';scene('71-quick-wide','Workout',p,'同页键盘 · 长名称 / 极值 / 提示')
env.disk.set('summary_last',{sid:'preview',workout:longNames[0],minutes:599,sets:Array.from({length:300},()=>({done:true})),volume:99999999,weightUnit:'lb',avgHr:118,maxHr:242,calories:9999});p=page('Summary',env);p.onInit();scene('72-summary-wide','Summary',p,'总结 · 长计划名 / 大统计值');scene('73-summary-wide-bottom','Summary',p,'总结 · 大统计值 / 完成按钮',true)
p=workout();p.pageIndex=2;p.metricKind='effort';p.metricEfforts=Array.from({length:4},(_,i)=>({key:String(i),name:longNames[0],value:'10.0'}));scene('74-effort-four-long','Workout',p,'强度统计 · 四条两行名称')
p=workout();p.pageIndex=2;p.elapsedLabel='359:59';p.volumeLabel='999,999,999';p.doneTotal='999/1000';p.kcalLabel='99999';scene('75-metrics-wide','Workout',p,'统计 · 时长 / 容量 / 组数上限')
p=workout();p.pageIndex=0;p.overviewRows=Array.from({length:30},(_,i)=>({key:'e'+i,index:i,name:longNames[i%3],count:'2/100',current:i===0,finished:false}));scene('76-overview-many-top','Workout',p,'概览 · 三十个长名称动作');scene('77-overview-many-bottom','Workout',p,'概览 · 三十个动作后可结束 / 放弃',true)
const runtime = `
function val(exp,ctx){if(typeof exp!=='string')return exp;if(exp.startsWith('function'))return Function('return ('+exp+')')().call(ctx);return exp.split('.').reduce((a,k)=>a?.[k],ctx)}
function render(n,ctx){if(n.repeat){let frag=document.createDocumentFragment();for(const item of val(n.repeat.$exp,ctx)||[]){let sub=Object.create(ctx);sub[n.repeat.value]=item;frag.append(render({...n,repeat:null},sub))}return frag}if(n.$shown&&!val(n.$shown,ctx)||n.attr?.$show&&!val(n.attr.$show,ctx))return document.createDocumentFragment();const el=document.createElement(n.type==='input'?'button':n.type==='text'?'native-text':n.type==='image'?'img':'div');el.className=(n.$class?val(n.$class,ctx).flat(Infinity).filter(Boolean).join(' '):n.class||'');el.dataset.type=n.type;if(n.action||n.events?.click||n.events?.$click)el.dataset.action=n.action||n.events.click||n.events.$click;let a=n.attr||{};if(a.id)el.id=a.id;if(n.type==='image'){let src=a.$src?val(a.$src,ctx):a.src;el.src=ICONS[src]||src;el.alt=''}if(a.$disabled)el.disabled=!!val(a.$disabled,ctx);if(n.style)Object.assign(el.style,n.style);for(const [k,v] of Object.entries(n.inlineStyle||{}))el.style[k.startsWith('$')?k.slice(1):k]=k.startsWith('$')?val(v,ctx):v;if(n.type==='text'||n.type==='input'){let text=a.$value?val(a.$value,ctx):a.value||'';let span=document.createElement('span');span.textContent=text??'';el.append(span)}for(let c of n.children||[])el.append(render(c,ctx));return el}
document.querySelector('#viewport').append(render(SCENE.template,SCENE.state));
for(let el of document.querySelectorAll('[data-type="text"]')){const lines=getComputedStyle(el).getPropertyValue('-webkit-line-clamp').trim();if(lines){el.firstChild.style.webkitLineClamp=lines}}
if(SCENE.bottom)for(let el of document.querySelectorAll('[data-type="list"]'))el.scrollTop=el.scrollHeight;
`
const icons = Object.fromEntries(fs.readdirSync(path.join(root, 'src/common/icons')).filter(n => n.endsWith('.svg')).map(n => ['/common/icons/' + n, 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(root, 'src/common/icons', n)).toString('base64')]))
const base=`html,body{margin:0;width:100%;height:100%;background:#000;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:#fff}*{box-sizing:border-box}#viewport{width:100vw;height:100vh;position:relative;overflow:hidden;border-radius:${view.radius}px}div,button,native-text{display:flex;position:relative;flex-direction:row;flex-shrink:0;min-width:0}button{padding:0;border:0;align-items:center;justify-content:center;font:inherit;cursor:pointer}button:disabled{opacity:.4}native-text{align-items:center;overflow:hidden;white-space:normal}native-text>span{max-width:100%;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;line-height:inherit;flex:1}button>span{line-height:1.15}[data-type="list"]{display:block;overflow-y:auto;overflow-x:hidden;min-height:0;scrollbar-width:none}[data-type="list"]::-webkit-scrollbar{display:none}[data-type="list-item"]{flex-shrink:0}`
// Native-only `lines` is translated to CSS line clamp; remaining CSS is the shipped .ux stylesheet.
for (const s of scenes) {
  const css=s.css.replace(/\blines:\s*(\d+);/g,'-webkit-line-clamp: $1;')
    .replace(/screen and \(device: watch-round\)/g, target === 'watch-round' ? 'screen and (min-width: 0px)' : 'screen and (min-width: 99999px)')
  const fontOverride = fonts ? fontCss+'html,body{font-family:WatchSDK,sans-serif}' : ''
  const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+s.title+' · code preview NOT device</title><style>'+base+fontOverride+'\n'+css+'</style><body><div id="viewport"></div><script>const ICONS='+JSON.stringify(icons)+';const SCENE='+JSON.stringify(s).replaceAll('</','<\\/')+';'+runtime+'</script></body></html>'
  fs.writeFileSync(path.join(out,s.id+'.html'),html)
}
fs.writeFileSync(path.join(out,'scenes.json'),JSON.stringify(scenes.map(({id,name,title,bottom})=>({id,name,title,bottom})),null,2))
const dimensions = view.width + ' × ' + view.height
const sourceLabel = fromSource ? '当前 .ux 源码模板' : '现有编译目录中的模板（不会重新构建）'
const maskLabel = target === 'watch-round' ? '使用圆形安全区测试遮罩。' : '使用保守的'+view.radius+'px圆角测试遮罩，不代表设备实测圆角。'
const cards=scenes.map(s=>'<article><h2>'+s.title+'</h2><iframe src="'+s.id+'.html" width="'+view.width+'" height="'+view.height+'"></iframe><a href="'+s.id+'.html">'+dimensions+' 单屏</a></article>').join('')
fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+dimensions+' 源码实现审阅</title><style>body{background:#121417;color:#fff;font:16px Segoe UI,Microsoft YaHei,sans-serif;margin:36px}h1{color:#30d158}main{display:flex;flex-wrap:wrap;gap:28px}article{background:#202329;padding:18px;border-radius:24px}h2{font-size:18px}iframe{border:1px solid #41434a;border-radius:'+view.radius+'px;background:#000}a{display:block;color:#30d158;margin-top:12px}</style><h1>'+dimensions+' · UI 实现预览</h1><p>从'+sourceLabel+'和实际 .ux CSS 生成，页面数据由真实脚本生成。浏览器语义适配预览，非原生编译结果或真机截图，字体是否来自 SDK 见 preview-config.json；浏览器仍有原生渲染差异。'+maskLabel+'</p><main>'+cards+'</main></html>')
console.log('Generated '+scenes.length+' code-derived scenes in '+out)
