import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const root = path.resolve('source/watch-app/src')
const port = Number(process.env.WATCH_PREVIEW_PORT || 4180)
const require = createRequire(path.resolve('source/frontend/package.json'))
const { parseHTML } = require('linkedom')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const evaluate = (s, ctx) => Function(...Object.keys(ctx), 'return (' + s + ')')(...Object.values(ctx))
const fill = (s, ctx) => s.replace(/{{([\s\S]*?)}}/g, (_, expr) => String(evaluate(expr, ctx)))
function render(name, ctx) {
  const ux = read(name + '/index.ux')
  const { document } = parseHTML('<html><body>' + ux.match(/<template>([\s\S]*?)<\/template>/)[1] + '</body></html>')
  function walk(parent, scope) {
    for (const el of Array.from(parent.childNodes)) {
      if (el.nodeType === 3) { el.textContent = fill(el.textContent, scope); continue }
      if (el.nodeType !== 1) continue
      if (el.hasAttribute('for')) {
        const match = el.getAttribute('for').match(/{{\s*(\w+) in (.*?)\s*}}/)
        for (const item of evaluate(match[2], scope)) {
          const copy = el.cloneNode(true); copy.removeAttribute('for')
          const holder = document.createElement('div'); holder.appendChild(copy)
          walk(holder, { ...scope, [match[1]]: item })
          el.before(...Array.from(holder.childNodes))
        }
        el.remove(); continue
      }
      if (el.hasAttribute('if')) {
        if (!evaluate(el.getAttribute('if').replace(/^{{|}}$/g, ''), scope)) { el.remove(); continue }
        el.removeAttribute('if')
      }
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('on')) el.removeAttribute(attr.name)
        else el.setAttribute(attr.name, fill(attr.value, scope))
      }
      walk(el, scope)
    }
  }
  walk(document.body, ctx)
  return '<style>*{box-sizing:border-box;flex-shrink:0}html,body{width:100%;height:100%}body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;background:#000}div,stack,list,list-item{display:flex;position:relative}block{display:contents}text{display:flex;align-items:center;justify-content:center;overflow:hidden;line-height:1.05}input{border:0;appearance:none;padding:0}image{display:block}list{display:block;overflow:auto}list-item{display:flex}'+ux.match(/<style>([\s\S]*?)<\/style>/)[1]+'</style>'+document.body.innerHTML.replace(/<image /g,'<img ').replace(/<\/image>/g,'')
}
const ctx = { exName:'坐姿器械推胸', restCurrentLabel:'坐姿器械推胸 · 第 1 组', nextLabel:'下一组 · 坐姿器械推胸 · 第 2 / 4 · 72.5kg × 12次', groupLabel:'第 1 / 4 组', setProgressLabel:'完成 6 / 剩余 10 组', elapsedLabel:'32:18', weightVal:'72.5 kg', repsVal:'12 次',
  rowDone:false, allFinished:false,isRest:false,menuOn:false,leaveChoice:false,pageIndex:0,closeMode:'',paused:false,pauseLabel:'暂停训练', restLabel:'1:15', restTotalLabel:'1:45', restProgLabel:'6 / 16 组',
  hrLabel:'118 bpm',syncLabel:'已连接',clockLabel:'11:09',elapsedLabel:'32:18',kcalLabel:'186',volumeLabel:'4,800',minutes:'0:42',sets:'16',kcal:'236',hr:'118',volume:'4800',nextDetails:'第 2 / 4 组 · 72.5kg × 12次',
  show:'72.5',label:'',unit:'kg',field:'w',version:'0.6.3',status:'选择训练计划',exerciseCount:4,linkLabel:'已连接手机',canStart:true,canResume:false,
  plans:[{id:'a',name:'胸肩力量训练',today:true,exercises:[1,2,3,4]},{id:'b',name:'背部与核心',exercises:[1,2,3]}],selected:{id:'a'},conflict:null,hasSummary:true,settingsOn:false,restSetting:90,weightStep:0.5,
  expanded:0,list:[{name:'坐姿器械推胸',idx:0,rows:[{no:'1',txt:'72.5kg × 12',done:true,exIdx:0,setIdx:0},{no:'2',txt:'72.5kg × 12',done:false,exIdx:0,setIdx:1}]},{name:'高位下拉',idx:1,rows:[]}] }
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost')
  if (url.pathname.startsWith('/assets/')) { res.end(fs.readFileSync(path.join(root,url.pathname))); return }
  const name=url.searchParams.get('page') || 'Workout'
  const state={...ctx, isRest:url.searchParams.has('rest'),menuOn:url.searchParams.has('menu'),settingsOn:url.searchParams.has('settings'),conflict:url.searchParams.has('conflict')?{}:null,pageIndex:url.searchParams.has('actions')?1:0,closeMode:url.searchParams.get('close')||'',endOn:url.searchParams.has('end'),paused:url.searchParams.has('paused'),pauseLabel:url.searchParams.has('paused')?'继续训练':'暂停训练',exName:url.searchParams.has('long')?'单臂绳索站姿交替上斜胸部推举训练':'坐姿器械推胸'}
  if (url.searchParams.has('expanded')) state.list[0].rows[0].done = true
  state.restExerciseName = state.exName
  state.nextLabel = url.searchParams.has('change') ? '下一动作 · 高位下拉' : '下一组'
  if (url.searchParams.has('empty')) { state.plans = []; state.selected = null; state.hasSummary = false }
  if (url.searchParams.has('maxrest')) { state.restLabel = '15:00'; state.restTotalLabel = '15:00' }
  if (url.searchParams.has('complete')) { state.closeMode = 'complete'; state.allFinished = true; state.setProgressLabel = '完成 16 / 剩余 0 组' }
  const output = render(name, state)
  // Native font metrics vary; stress the countdown with a taller CJK line box as well.
  const stressStyle = url.searchParams.has('fontstress') ? '<style>body{font-family:"Microsoft YaHei",sans-serif}.rest{line-height:80px}</style>' : ''
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(output + stressStyle)
}).listen(port,'127.0.0.1',()=>console.log('UX source layout preview: http://127.0.0.1:' + port))
