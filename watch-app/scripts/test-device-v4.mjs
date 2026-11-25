// Run with Node 22.15+; use shipped modules and replace only the device SDK.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const disk = new Map(), sent = [], conn = { getReadyState({ success }) { success({ status: 0 }) }, send({ data, success }) { sent.push(structuredClone(data)); success() }, close() {} }
globalThis.__testSdk = { storage: { getSync: ({ key }) => structuredClone(disk.get(key)), set: ({ key, value, success }) => { disk.set(key, structuredClone(value)); success?.() } }, rpc: { instance: () => conn } }
registerHooks({ resolve(id, ctx, next) { const sdk = { '@blueos.storage.storage': 'storage', '@blueos.bluexlink.connectionManager': 'rpc' }[id]; return sdk ? { url: 'data:text/javascript,export default globalThis.__testSdk.' + sdk, shortCircuit: true } : next(id, ctx) } })
const rpc = await import('../src/lib/rpc.js'), session = await import('../src/lib/session.js'), rt = (await import('../src/lib/runtime.js')).runtime
const start = { t: 'START_SESSION', protocolVersion: 4, requestId: 'start1', sid: 's1', workout: '力量', exercises: [{ entryInstanceId: 'entry1', exerciseId: 'bench', name: '卧推', sets: [{ setId: 'r1', reps: 8, weight: 40 }, { setId: 'r2', reps: 6, weight: 45 }] }] }
const waitFor = async (f) => { for (let i=0;i<150;i++) { if (f()) return; await delay(20) } assert.fail('timed out: ' + f) }
const query = async id => { conn.onMessage({ t:'STATE_QUERY',requestId:id }); await waitFor(()=>sent.some(m=>m.t==='STATE_SNAPSHOT'&&m.requestId===id)); return sent.find(m=>m.t==='STATE_SNAPSHOT'&&m.requestId===id) }
const accept = async msg => { const n=sent.length; conn.onMessage(msg); await waitFor(()=>sent.slice(n).some(m=>m.t==='SESSION_ACCEPTED')); return sent.slice(n).find(m=>m.t==='SESSION_ACCEPTED') }
let entered=0
try {
 rpc.startServer({ onPhoneStart() { entered++ } }); conn.onOpen(); assert.equal((await query('idle')).active,false)
 assert.equal((await accept(start)).status,'accepted'); assert.equal(disk.get('session_state').sid,'s1'); assert.equal((await accept(start)).status,'accepted'); assert.equal(entered,1)
 assert.equal((await accept({...start,sid:'s2',requestId:'conflict'})).reason,'watch_active_session')
 const complete = (n)=>session.commitSessionAction('s1',s=>{ const row=s.workout.rows[0][n]; row.done=true; s.setIdx=n; session.stageSessionEvent(s,{ t:'set',sid:'s1',ex:0,set:n+1,weight:row.w,reps:row.r }) })
 assert.ok((await complete(0)).ok); await waitFor(()=>sent.some(m=>m.t==='set'&&m.setId==='r1')); assert.equal(rpc.pendingCount(),0)
 conn.onClose(); const boundary=sent.length; assert.ok((await complete(1)).ok); assert.equal(sent.length,boundary); assert.equal(disk.get('session_state').pendingEdits?.length||0,0)
 conn.onOpen(); const restored=await query('reconnect'); assert.equal(restored.setIdx,1); assert.deepEqual(restored.rows.map(rows=>rows.map(r=>r.setId)),[['r2']]); assert.equal(entered,1); assert.ok(!sent.slice(boundary).some(m=>m.t==='set')); conn.onClose()
 const closed = await session.commitLocalClose('s1','saved'); assert.ok(closed.ok, JSON.stringify(closed)); rpc.stopServer(); (await import('../src/lib/runtime.js')).bindRuntime({}); rpc.startServer({}); conn.onOpen(); const terminal=await query('reboot'); assert.equal(terminal.active,false); assert.equal(terminal.terminal.disposition,'saved'); assert.equal(terminal.terminal.sid,'s1'); assert.equal((await accept(start)).reason,'session_closed'); assert.ok(!sent.slice(boundary).some(m=>m.t==='session_close')); assert.equal(disk.get('watch_close_journal_v1')?.entries?.s1,undefined)
 console.log('PASS: durable start, duplicate/conflict, online set, offline progress, compact reconnect, offline terminal and no replay.')
} finally { rpc.stopServer(); rt().destroyed=true }
