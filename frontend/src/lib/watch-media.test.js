import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { mediaSha256, mediaDecode64, mediaManifestValid, mediaPngValid, MEDIA_ROOT } from '../../../watch-app/src/lib/media-format.js'
import { createMediaClient } from '../../../watch-app/src/lib/media-client.js'
import { createWatchMediaResponder, watchMediaRef } from './watch-media.js'
import { CATALOGUE } from './exercises.js'
import { stripImports, watchInteractionDeps } from './watch-test-harness.js'
const png = new Uint8Array(2200)
png.set([137,80,78,71,13,10,26,10]); png.set([73,72,68,82],12); png[19]=png[23]=180
const frame = { bytes:png.length, sha256:mediaSha256(png), duration:100 }
const m = { assetKey:'a'.repeat(64), sourceId:'0001', width:180, height:180, count:2, durationMs:200, totalBytes:4400, frames:[frame,frame] }
const ref = { sid:'sid1', sourceId:'0001', entryInstanceId:'entry1' }
const plan = { sid:'sid1', workout:{ exercises:[{ entryInstanceId:'entry1', mediaRef:{sourceId:'0001'} }] } }
const drain = async () => { for(let i=0;i<700;i++) await Promise.resolve() }
function rig() {
 const files = new Map(), sends=[], changes=[]
 const disk={ mkdir:vi.fn(async()=>{}), remove:vi.fn(async p=>files.delete(p)),
   readText:vi.fn(async p=>{if(!files.has(p))throw Error('missing');return files.get(p)}),
   writeText:vi.fn(async(p,t)=>files.set(p,t)),read:vi.fn(async p=>{if(!files.has(p))throw Error('missing');return files.get(p)}),write:vi.fn(async(p,b)=>files.set(p,b.slice())) }
 const client=createMediaClient({disk,send:e=>sends.push(e),changed:e=>changes.push(e)})
 return { files,sends,changes,disk,client }
}
const msg = (r, fields) => ({ ...r.sends.at(-1), ...fields })
async function header(r) {
 await r.client.open(ref)
 await r.client.receive(msg(r,{t:'media_info',manifest:{...m,frames:undefined}}))
 await r.client.receive(msg(r,{t:'media_index',assetKey:m.assetKey,index:0,frames:m.frames}))
}
describe('PNG frame wire format',()=>{
 it('SHA256 matches crypto at padding/block/full frame boundaries',()=>{
  for(const n of [0,1,3,55,56,63,64,65,180,2048,65536]) {
   const a=Uint8Array.from({length:n},(_,i)=>i*31%256)
   expect(mediaSha256(a)).toBe(createHash('sha256').update(a).digest('hex'))
  }
 })
 it('decodes bounded base64 exactly and rejects malformed/padded/oversized chunks',()=>{
  for(const n of [1,2,3,2048]) {const a=png.slice(0,n);expect([...mediaDecode64(Buffer.from(a).toString('base64'))]).toEqual([...a])}
  for(const s of ['', 'x', 'AB==','AAB=','====','abcd\n','a'.repeat(2736)]) expect(()=>mediaDecode64(s)).toThrow()
 })
 it('accepts only bounded manifests, correct dimensions and byte totals',()=>{
  expect(mediaManifestValid(m)).toBe(true); expect(mediaPngValid(png)).toBe(true)
  for(const changed of [{assetKey:'../x'},{sourceId:'../x'},{count:97},{frames:[]},{width:400},{totalBytes:1},{durationMs:201},{durationMs:35001},{frames:[{...frame,bytes:65537},frame]}])expect(mediaManifestValid({...m,...changed})).toBe(false)
  const bad=png.slice();bad[19]=179;expect(mediaPngValid(bad)).toBe(false)
 })
 it('resolves the same figure alias as mobile and excludes custom media',()=>{
  const ex=CATALOGUE.find(x=>x.fv && x.gif?.endsWith('.mp4'));expect(ex).toBeTruthy()
  expect(watchMediaRef({exFigure:'female'},ex)?.sourceId).toBe(ex.fv)
  expect(watchMediaRef({customEx:[ex]},ex)).toBeNull()
 })
})
describe('independent phone media responder',()=>{
 it('validates sid, entry and source before native work; rejects path traversal',async()=>{
  const prepare=vi.fn(async()=>m),send=vi.fn(async()=>{}),readChunk=vi.fn()
  const handle=createWatchMediaResponder({getPlan:()=>plan,prepare,send,readChunk})
  for(const bad of [{sid:'old'},{entryInstanceId:'other'},{sourceId:'../secret'}])await handle({...ref,requestId:'r',t:'media_request',...bad})
  expect(prepare).not.toHaveBeenCalled()
  await handle({...ref,requestId:'r',t:'media_request'});expect(prepare).toHaveBeenCalledTimes(1)
  expect(send.mock.calls[0][0].manifest.frames).toBeUndefined()
  await handle({...ref,requestId:'r',t:'media_get',assetKey:m.assetKey,frame:-1,offset:0})
  await handle({...ref,requestId:'r',t:'media_get',assetKey:m.assetKey,frame:0,offset:1});expect(readChunk).not.toHaveBeenCalled()
 })
 it('accepts next pull before the SDK acknowledges the previous response',async()=>{
  const replies=[];let handle
  const send=async e=>{replies.push(e);if(e.t==='media_info')await handle({...ref,requestId:'r',t:'media_get_index',assetKey:m.assetKey,index:0})}
  handle=createWatchMediaResponder({getPlan:()=>plan,prepare:async()=>m,send,readChunk:vi.fn()})
  await handle({...ref,requestId:'r',t:'media_request'});expect(replies.map(e=>e.t)).toEqual(['media_info','media_index'])
 })
 it('does not send stale frames when session changes during decode',async()=>{
  let p=plan,finish;const send=vi.fn(async()=>{})
  const handle=createWatchMediaResponder({getPlan:()=>p,prepare:()=>new Promise(r=>{finish=r}),send,readChunk:vi.fn()})
  const task=handle({...ref,requestId:'r',t:'media_request'});p=null;finish(m);await task
  expect(send.mock.calls.every(([e])=>e.t==='media_error')).toBe(true)
 })
 it('bounds native concurrency and pages metadata below the normal wire budget',async()=>{
  let finish;const many={...m,count:96,durationMs:9600,totalBytes:96*2200,frames:Array(96).fill(frame)};const prepare=vi.fn(()=>new Promise(r=>{finish=r})),send=vi.fn(async()=>{})
  const handle=createWatchMediaResponder({getPlan:()=>plan,prepare,send,readChunk:vi.fn()})
  const e={...ref,requestId:'r',t:'media_request'},task=handle(e)
  await handle({...e,requestId:'spam'});expect(prepare).toHaveBeenCalledTimes(1);finish(many);await task
  await handle({...e,t:'media_get_index',assetKey:m.assetKey,index:0});expect(send.mock.calls.at(-1)[0].frames).toHaveLength(16);expect(JSON.stringify(send.mock.calls.at(-1)[0]).length).toBeLessThan(6000)
 })
})
describe('watch pull/cache lifecycle',()=>{
 it('downloads sequential chunks, ignores duplicates/stale replies, commits ready last and reopens offline',async()=>{
  const r=rig(); await header(r)
  const first=msg(r,{t:'media_chunk',data:Buffer.from(png.slice(0,2048)).toString('base64'),length:2048})
  await r.client.receive({...first,sid:'old'});expect(r.sends.at(-1).offset).toBe(0)
  await r.client.receive(first);expect(r.sends.at(-1).offset).toBe(2048)
  const n=r.sends.length;await r.client.receive(first);expect(r.sends).toHaveLength(n)
  await r.client.receive(msg(r,{t:'media_chunk',data:Buffer.from(png.slice(2048)).toString('base64'),length:152}))
  expect(r.files.has(MEDIA_ROOT+'/ready.json')).toBe(false)
  await r.client.receive(msg(r,{t:'media_chunk',data:Buffer.from(png.slice(0,2048)).toString('base64'),length:2048}))
  await r.client.receive(msg(r,{t:'media_chunk',data:Buffer.from(png.slice(2048)).toString('base64'),length:152}))
  await drain();expect(r.changes.at(-1).status).toBe('ready');expect(r.changes.at(-1).frames).toHaveLength(2);r.client.close()
  const changes=[],send=vi.fn(),c=createMediaClient({disk:r.disk,send,changed:e=>changes.push(e)})
  await c.open(ref);expect(changes.at(-1).status).toBe('ready');expect(send).not.toHaveBeenCalled();c.close()
 })
 it('a corrupt cache is never shown; invalid chunks never write a frame',async()=>{
  const r=rig();r.files.set(MEDIA_ROOT+'/ready.json',JSON.stringify(m));r.files.set(MEDIA_ROOT+'/0.png',new Uint8Array(33))
  await header(r);await r.client.receive(msg(r,{t:'media_chunk',data:'AB==',length:1}))
  expect(r.changes.at(-1).status).toBe('error');expect(r.disk.write).not.toHaveBeenCalled();r.client.close()
 })
 it('partial writes and close cannot create a complete cache',async()=>{
  const r=rig();await header(r);r.disk.write.mockRejectedValue(Error('full'))
  await r.client.receive(msg(r,{t:'media_chunk',data:Buffer.from(png.slice(0,2048)).toString('base64'),length:2048}))
  await r.client.receive(msg(r,{t:'media_chunk',data:Buffer.from(png.slice(2048)).toString('base64'),length:152}))
  expect(r.changes.at(-1).status).toBe('error');expect(r.files.has(MEDIA_ROOT+'/ready.json')).toBe(false)
  r.client.close();const n=r.sends.length;await r.client.receive(msg(r,{t:'media_info',manifest:m}));expect(r.sends.length).toBe(n)
 })
 it('times out with only three retries and close cancels timer',async()=>{
  vi.useFakeTimers();try {
   const r=rig();await r.client.open(ref);await vi.advanceTimersByTimeAsync(120001)
   expect(r.sends).toHaveLength(4);expect(r.changes.at(-1).status).toBe('error');r.client.close();expect(vi.getTimerCount()).toBe(0)
  } finally {vi.useRealTimers()}
 })
 it('rejects excessive manifest frames before allocating files',async()=>{
  const r=rig();await r.client.open(ref);await r.client.receive(msg(r,{t:'media_info',manifest:{...m,count:10000}}))
  expect(r.changes.at(-1).status).toBe('error');expect(r.disk.mkdir).not.toHaveBeenCalled();r.client.close()
 })
})
describe('training overlay is read-only',()=>{
 const source=readFileSync(new URL('../../../watch-app/src/Workout/index.ux',import.meta.url),'utf8')
 it('blocks crown and navigation without changing training data',()=>{
  const context={...watchInteractionDeps,page:null,setTimeout,clearTimeout};runInNewContext(stripImports(source.match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default','page ='),context)
  const p={...context.page,...context.page.data,mediaOn:true,queueRestNudge:vi.fn(),adjustSelectedField:vi.fn(),state:{sid:'s'},touchCancel:vi.fn()}
  p.onRotation({delta:1});p.touchEnd({});expect(p.queueRestNudge).not.toHaveBeenCalled();expect(p.adjustSelectedField).not.toHaveBeenCalled();expect(p.interactionBlocked()).toBe(true)
  const before=JSON.stringify(p.state);p.closeMedia();expect(JSON.stringify(p.state)).toBe(before);expect(p.mediaOn).toBe(false)
 })
 it('uses native PNG animator, low predecode and does not route away',()=>{
  expect(source).toContain('predecode="1"');expect(source).toContain('onclick="openMedia"')
  const body=source.split('  openMedia() {')[1].split('  loadMedia() {')[0];expect(body).not.toMatch(/router\.|sendEvent|save\(/)
 })
})
