// Run with Node 22.15+; use shipped modules and replace only the device SDK.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { createDurableWatchLifecycle } from '../../frontend/src/lib/watch-commit.js'
const disk = new Map(), sent = []; let holdNext=false, releaseSend=null
const phoneSession = sid => ({ start:Date.now(), watchSid:sid, watchPhoneSession:true, watchSessionGeneration:sid, cur:0,
 exercises:undefined, entries:[{ id:'bench', entryInstanceId:'entry1', sets:[{setId:'r1',w:40,r:'8',done:false},{setId:'r2',w:45,r:'6',done:false}] }] })
const phoneState = { unit:'kg', active:phoneSession('s1') }
const phoneReceiver = createDurableWatchLifecycle({ getState:()=>phoneState, update:mutate=>mutate(phoneState), isForeground:()=>true,
 checkpoint:async()=>{}, finish:()=>{}, rest:()=>{}, stop:()=>{}, send:()=>{}, sendSync:()=>{} })
const errors=[]
const conn = { getReadyState({ success }) { success({ status: 0 }) }, send({ data, success, fail }) {
 sent.push(structuredClone(data)); if (data?.protocolVersion===4 && data.phoneLed===true) phoneReceiver(data)
 if (data?.t==='STATE_SNAPSHOT') phoneReceiver(data)
 if (holdNext) { holdNext=false; releaseSend=error => error ? fail(error, 'simulated') : success() } else success()
 }, close() {} }
globalThis.__testSdk = { storage: { getSync: ({ key }) => structuredClone(disk.get(key)), set: ({ key, value, success }) => { disk.set(key, structuredClone(value)); success?.() } }, rpc: { instance: () => conn } }
registerHooks({ resolve(id, ctx, next) { const sdk = { '@blueos.storage.storage': 'storage', '@blueos.bluexlink.connectionManager': 'rpc' }[id]; return sdk ? { url: 'data:text/javascript,export default globalThis.__testSdk.' + sdk, shortCircuit: true } : next(id, ctx) } })
const rpc = await import('../src/lib/rpc.js'), session = await import('../src/lib/session.js'), rt = (await import('../src/lib/runtime.js')).runtime, valueStep = await import('../src/lib/value-step.js')
const start = { t: 'START_SESSION', protocolVersion: 4, requestId: 'start1', sid: 's1', workout: '力量', exercises: [{ entryInstanceId: 'entry1', exerciseId: 'bench', name: '卧推', sets: [{ setId: 'r1', reps: 8, weight: 40 }, { setId: 'r2', reps: 6, weight: 45 }] }] }
const waitFor = async (f) => { for (let i=0;i<150;i++) { if (f()) return; await delay(20) } assert.fail('timed out: ' + f) }
const query = async id => { conn.onMessage({ t:'STATE_QUERY',requestId:id }); await waitFor(()=>sent.some(m=>m.t==='STATE_SNAPSHOT'&&m.requestId===id)); return sent.find(m=>m.t==='STATE_SNAPSHOT'&&m.requestId===id) }
const accept = async msg => { const n=sent.length; conn.onMessage(msg); await waitFor(()=>sent.slice(n).some(m=>m.t==='SESSION_ACCEPTED')); return sent.slice(n).find(m=>m.t==='SESSION_ACCEPTED') }
let entered=0
try {
 rpc.startServer({ onPhoneStart() { entered++ }, onError(error) { errors.push(error) } }); conn.onOpen(); assert.equal((await query('idle')).active,false)
 assert.equal(valueStep.rotationStep({delta:9}),1); assert.equal(valueStep.rotationStep({delta:-7}),-1)
 assert.equal((await accept(start)).status,'accepted'); assert.equal(disk.get('session_state').sid,'s1'); assert.equal((await accept(start)).status,'accepted'); assert.equal(entered,1)
 assert.equal((await accept({...start,sid:'s2',requestId:'conflict'})).reason,'watch_active_session')
 await query('live-baseline'); await phoneReceiver.idle()
 // A v4 live value must be a compact transient control, and old ordinary edits
 // from the previous durable outbox must be retired at the first v4 query.
 const legacy = [
  {t:'weight',sid:'s1',eventId:'old-weight',protocolVersion:3,phoneLed:true},
  {t:'reps',sid:'s1',eventId:'old-reps',protocolVersion:3,phoneLed:true}
 ]
 const terminalEvents = [
  {t:'session_close',sid:'prior',eventId:'keep-close',protocolVersion:3,phoneLed:true},
  {t:'summary',sid:'prior',eventId:'keep-summary',protocolVersion:3,phoneLed:true}
 ]
 const staleEvents = legacy.map(msg=>({msg,sent:true,receivedAt:1})), keepEvents=terminalEvents.map(msg=>({msg,sent:true,receivedAt:1}))
 rt().rpc.outbox = [...staleEvents,...keepEvents]; disk.set('rpc_outbox',structuredClone(rt().rpc.outbox))
 const beforeLive = sent.length
 assert.equal(rpc.sendLiveValue({t:'weight',sid:'s1',ex:0,set:1,entryInstanceId:'entry1',setId:'r1',weight:41,weightUnit:'kg'}),true)
 await waitFor(()=>sent.slice(beforeLive).some(m=>m.t==='weight'&&m.weight===41))
 const liveFrame=sent.slice(beforeLive).find(m=>m.t==='weight')
 assert.equal(liveFrame.protocolVersion,4); assert.ok(liveFrame.eventId); assert.ok(Number.isSafeInteger(liveFrame.rev)); await phoneReceiver.idle()
 assert.equal(phoneState.active.entries[0].sets[0].w,41); assert.equal(rpc.pendingCount(),4)
 // SDK callbacks can still be outstanding when the next live operation is ready.
 const duringControl = sent.length
 holdNext = true
 conn.onMessage({ t: 'link_probe', requestId: 'hold-control' })
 await waitFor(() => !!releaseSend)
 const finishControl = releaseSend
 releaseSend = null
 const firstRow = { sid: 's1', ex: 0, set: 1, entryInstanceId: 'entry1', setId: 'r1' }
 holdNext = true
 assert.equal(rpc.sendLiveValue({ ...firstRow, t: 'weight', weight: 44, weightUnit: 'kg' }), true)
 const finishWeight = releaseSend
 releaseSend = null
 assert.equal(rpc.sendLiveValue({ ...firstRow, t: 'reps', reps: 10 }), true)
 const complete = n => session.commitSessionAction('s1', state => {
  const row = state.workout.rows[0][n]
  row.done = true
  state.setIdx = n
  rpc.sendEvent({ t: 'set', sid: 's1', ex: 0, set: n + 1, at: Date.now() })
 })
 holdNext = true
 assert.ok((await complete(0)).ok)
 const finishCompletion = releaseSend
 releaseSend = null
 assert.ok((await complete(1)).ok)
 await phoneReceiver.idle()
 const live = sent.slice(duringControl).filter(m => m.phoneLed === true)
 assert.deepEqual(live.map(m => m.t), ['weight', 'reps', 'set', 'set'])
 assert.ok(live.every((m, index) => index === 0 || m.rev > live[index - 1].rev))
 assert.deepEqual(live.slice(2).map(m => m.setId), ['r1', 'r2'])
 assert.equal(live[2].weight, undefined)
 assert.equal(live[2].reps, undefined)
 assert.equal(live[2].rest, undefined)
 assert.deepEqual(phoneState.active.entries[0].sets.map(row => [row.w, row.r, row.done]), [[44, '10', true], [45, '6', true]])
 assert.equal(rt().rpc.liveInFlight.size, 2)
 assert.equal(rpc.pendingCount(), 4)
 finishCompletion()
 finishControl()
 finishWeight()
 assert.equal(rt().rpc.liveInFlight.size, 0)

 // A failed live send releases its slot and is never submitted again.
 holdNext = true
 assert.equal(rpc.sendLiveValue({ ...firstRow, t: 'weight', weight: 45, weightUnit: 'kg' }), true)
 const failedId = sent.at(-1).eventId
 releaseSend(new Error('SDK send failed'))
 releaseSend = null
 assert.ok(errors.some(error => error.code === 'live_state_send_failed' && error.eventId === failedId))
 assert.equal(rt().rpc.liveInFlight.size, 0)

 const finishes = []
 for (let i = 0; i < 8; i++) {
  holdNext = true
  assert.equal(rpc.sendLiveValue({ ...firstRow, t: 'reps', reps: 10 + i }), true)
  finishes.push(releaseSend)
  releaseSend = null
 }
 const atCapacity = sent.length
 assert.equal(rpc.sendLiveValue({ ...firstRow, t: 'reps', reps: 18 }), false)
 assert.equal(sent.length, atCapacity)
 assert.equal(rt().rpc.liveInFlight.size, 8)
 assert.equal(errors.at(-1).code, 'live_state_send_failed')
 for (const finish of finishes.reverse()) finish()
 assert.equal(rt().rpc.liveInFlight.size, 0)
 await query('legacy-cleanup')
 await waitFor(()=>rpc.pendingCount()===2)
 const assertLegacyArchiveIsHistorical = () => {
  const status = rpc.synchronizationStatus()
  assert.equal(status.pending, 0)
  assert.equal(status.phonePending, 0)
  assert.equal(status.historicalPending, 2)
 }
 assertLegacyArchiveIsHistorical()
 assert.deepEqual(rt().rpc.outbox.map(e=>e.msg.eventId),['keep-close','keep-summary'])
 assert.deepEqual(sent.filter(m=>['old-weight','old-reps'].includes(m.eventId)),[])
 const transact = (t, fields) => session.commitSessionAction('s1', () => rpc.sendEvent({ t, sid: 's1', at: Date.now(), ...fields }))
 assert.ok((await transact('effort', { ex: 0, set: 1, scale: 'rpe', value: 8, effortVersion: Date.now() })).ok)
 await phoneReceiver.idle()
 assert.equal(phoneState.active.entries[0].sets[0].rpe, 8)
 const endsAt = Date.now() + 60000
 assert.ok((await transact('rest', { restId: 'test-rest', startedAt: endsAt - 60000, endsAt, totalSec: 60, leftSec: 60, paused: false })).ok)
 await phoneReceiver.idle()
 assert.equal(phoneState.watchRest?.endsAt, endsAt)
 const addStart = sent.length
 let addedId
 assert.ok((await session.commitSessionAction('s1', s => {
   session.addSet(s, 0); addedId = s.workout.rows[0].at(-1).setId
   rpc.sendEvent({ t: 'add_set', sid: 's1', ex: 0, set: 3, sets: 3, at: Date.now() })
 })).ok)
 await phoneReceiver.idle()
 assert.deepEqual(sent.slice(addStart).find(m => m.t === 'add_set')?.newSetIds, [addedId])
 assert.equal(phoneState.active.entries[0].sets.at(-1).setId, addedId)
 assert.ok((await session.commitSessionAction('s1', s => {
   session.removeSet(s, 0)
   rpc.sendEvent({ t: 'remove_set', sid: 's1', ex: 0, set: 3, sets: 2, removedSetIds: [addedId], at: Date.now() })
 })).ok)
 await phoneReceiver.idle()
 assert.deepEqual(phoneState.active.entries[0].sets.map(row => row.setId), ['r1', 'r2'])
 const beforeActualSet=sent.length; assert.ok((await complete(0)).ok); await waitFor(()=>sent.slice(beforeActualSet).some(m=>m.t==='set'&&m.setId==='r1')); await phoneReceiver.idle(); assert.equal(phoneState.active.entries[0].sets[0].done,true); assert.equal(rpc.pendingCount(),2)
 const sendEffort = async (value, baseEffortVersion) => {
  const boundary = sent.length, effortVersion = Date.now()
  const result = await session.commitSessionAction('s1', state => {
   session.setEffort(state, 0, 0, 'rpe', value, effortVersion)
   rpc.sendEvent({ t:'effort',sid:'s1',ex:0,set:1,scale:'rpe',value,clear:value==null,effortVersion,baseEffortVersion,at:effortVersion })
  })
  assert.ok(result.ok)
  const frame = sent.slice(boundary).find(m=>m.t==='effort')
  assert.ok(frame)
  assert.deepEqual([frame.scale,frame.value,frame.clear,frame.effortVersion,frame.baseEffortVersion], ['rpe',value,value==null,effortVersion,baseEffortVersion])
  await phoneReceiver.idle()
  assert.equal(phoneState.active.entries[0].sets[0].rpe,value ?? undefined)
 }
 await sendEffort(8,0)
 await sendEffort(null,1)
 const setFrame=sent.slice(beforeActualSet).find(m=>m.t==='set'&&m.setId==='r1'); assert.notEqual(setFrame.eventId,'idle-set'); assert.equal(setFrame.weight,undefined); assert.equal(setFrame.reps,undefined); assert.equal(setFrame.rest,undefined); assert.equal(setFrame.workout,undefined); assert.equal(setFrame.summary,undefined); assert.ok(setFrame.setId)
 // A stale SDK callback after close must not retry a live event or touch a new connection.
 holdNext = true
 assert.equal(rpc.sendLiveValue({ t: 'weight', sid: 's1', ex: 0, set: 2, entryInstanceId: 'entry1', setId: 'r2', weight: 46, weightUnit: 'kg' }), true)
 const lateRelease = releaseSend
 releaseSend = null
 const disconnectedId = sent.at(-1).eventId
 assert.equal(rt().rpc.liveInFlight.size, 1)
 conn.onClose()
 assertLegacyArchiveIsHistorical()
 const boundary = sent.length
 assert.equal(rt().rpc.liveInFlight.size, 0)
 assert.ok((await complete(1)).ok)
 assert.equal(sent.length, boundary)
 assert.equal(session.loadState().workout.rows[0][1].done, true)
 assert.equal(rpc.pendingCount(), 2)
 conn.onOpen()
 assertLegacyArchiveIsHistorical()
 const restored = await query('reconnect')
 assertLegacyArchiveIsHistorical()
 lateRelease(new Error('stale SDK callback'))
 assert.equal(rt().rpc.liveInFlight.size, 0)
 assert.equal(errors.some(error => error.eventId === disconnectedId), false)
 assert.deepEqual(sent.filter(m => m.eventId === failedId).length, 1)
 assert.deepEqual(sent.filter(m => m.eventId === disconnectedId).length, 1)
 assert.equal(restored.setIdx, 1)
 assert.deepEqual(restored.rows.map(rows => rows.map(r => r.setId)), [['r2']])
 assert.equal(entered, 1)
 assert.ok(!sent.slice(boundary).some(m => m.t === 'set'))
 conn.onClose()
 const closed = await session.commitLocalClose('s1','saved'); assert.ok(closed.ok, JSON.stringify(closed)); rpc.stopServer(); (await import('../src/lib/runtime.js')).bindRuntime({}); rpc.startServer({}); assertLegacyArchiveIsHistorical(); conn.onOpen(); assertLegacyArchiveIsHistorical(); const terminal=await query('reboot'); assertLegacyArchiveIsHistorical(); assert.equal(terminal.active,false); assert.equal(terminal.terminal.disposition,'saved'); assert.equal(terminal.terminal.sid,'s1'); assert.equal((await accept(start)).reason,'session_closed'); assert.ok(!sent.slice(boundary).some(m=>m.t==='session_close')); assert.equal(disk.get('watch_close_journal_v1')?.entries?.s1,undefined)
 const next = {...start,sid:'s2',requestId:'start2'}
 phoneState.active = phoneSession('s2')
 assert.equal((await accept(next)).status,'accepted')
 const closeBoundary = sent.length, closedAt = Date.now()
 const liveClose = await session.commitLocalClose('s2','discarded',closedAt)
 assert.ok(liveClose.ok)
 const closeFrame = sent.slice(closeBoundary).find(m=>m.t==='session_close')
 assert.ok(closeFrame)
 assert.deepEqual([closeFrame.sid,closeFrame.disposition,closeFrame.closedAt], ['s2','discarded',closedAt])
 await phoneReceiver.idle()
 assert.equal(phoneState.active,null)
 assert.equal(phoneState.watchClosed.s2.disposition,'discarded')
 assert.equal(rpc.pendingCount(),2)
 console.log('PASS: V4 start, transient values and effort, independent live sends, failure cleanup, legacy cleanup, offline progress, reconnect snapshots, and immediate close.')
} finally { phoneReceiver.dispose(); rpc.stopServer(); rt().destroyed=true }
