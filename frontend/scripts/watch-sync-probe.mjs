// Repeatable host simulation; NOT BlueOS flash/Bluetooth or device timing.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { watchPersistence, loadWatchModule } from '../src/lib/watch-test-harness.js'
import { commitPageAction } from '../../watch-app/src/lib/local-action.js'
import { applyEdit, applyRest } from '../../watch-app/src/lib/protocol.js'
import { persistentSender, persistentReceiver } from '../../watch-app/src/lib/persistent-transfer.js'
import { wireHash } from '../../watch-app/src/lib/sync-wire.js'
import { createDurableWatchLifecycle } from '../src/lib/watch-commit.js'
import { ensureWatchIdentity } from '../src/lib/watch-identity.js'
import { stampWatchRevision } from '../src/lib/watch-revision.js'
import { watchSnapshotOf } from '../src/lib/watch-workout.js'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const N = 30, metrics = {}, writes = {}, queued = new Map(), clicks = new Map()
const record = (key, ms) => (metrics[key] ||= []).push(ms)
async function until(check) { const end=performance.now()+10000; while(!check()) { assert(performance.now()<end,'probe timed out '+JSON.stringify({committed,pending:c.pendingCount(),session:c.loadState(),rpc:h.shared.rpc.trace})); await sleep(1) } }
const h=watchPersistence(), c=h.ctx
Object.assign(c,{applyEdit,applyRest,console:{info(){},log(){}},WATCH_VERSION:'probe'})
loadWatchModule('event-id',c,['allocateEventIdentity','rememberEventAt'])
loadWatchModule('close-journal',c,['pendingSummaries','pendingCloseEvents','journalEntry','prepareClose','releaseCandidate','markPhase','markEntry','markDelivered'])
loadWatchModule('session',c,['startSession','loadState','save','applySync','closeSession','buildSessionSummary','summaryEventOf'])
const S={unit:'kg',workouts:[],active:{start:Date.now(),watchSid:'probe',name:'Bench',entries:[{id:'plain-bench',sets:[{w:50,r:'8',done:false}]}]}}
ensureWatchIdentity(S.active); stampWatchRevision({},S)
const snap=watchSnapshotOf(S,null)
c.startSession({...snap,name:snap.workout,exercises:snap.exercises,rows:snap.rows})
const baseline=c.loadState();baseline.commitRev=S.active.syncRev;baseline.syncBase={...snap,t:'sync',protocolVersion:3};c.save(baseline)
const originalSet=h.storage.set
h.storage.set = item => {
  writes[item.key]=(writes[item.key]||0)+1
  setTimeout(()=> { originalSet(item); if(item.key==='session_state') {
    for(const e of item.value.pendingEdits||[]) if(clicks.has(e.eventId)&&!queued.has(e.eventId)) {
      record('click_to_local_disk_ms',performance.now()-clicks.get(e.eventId)); queued.set(e.eventId,performance.now())
    }
  } },1)
}
let watch, committed=0
const phone=createDurableWatchLifecycle({
  status:s=>{if(s.phase==='storage_failed')console.error(s)},
  getState:()=>S,getTimer:()=>null,
  update:(fn,ev)=>{const prev=structuredClone(S);fn(S);stampWatchRevision(prev,S,ev?.installationId||'watch',ev?.eventId)},
  checkpoint:()=>sleep(1),completeInbox:async()=>{},finish(){},stop(){},rest(){},sendSync:async()=>{},sendEnded:async()=>{},sendAck:async()=>{},
  send:async msg=>{ if(msg.t==='committed') {
    assert.equal(msg.status,'applied'); record('enqueued_to_committed_ms',performance.now()-queued.get(msg.eventId));
    watch.onMessage(msg); committed++
  }},
})
watch={getReadyState:({success})=>success({status:1}),send:({data,success})=>{
  const start=performance.now()
  if(queued.has(data.eventId)) record('queue_wait_ms',start-queued.get(data.eventId))
  setTimeout(()=>{record('rpc_callback_ms',performance.now()-start);success();if(data.t==='weight')phone(data)},2)
},close:({success})=>success()}
c.interconnect={instance:()=>watch}
loadWatchModule('rpc',c,['startServer','stopServer','sendEvent','replayPendingEvents','pendingCount'])
c.startServer({});watch.onOpen();watch.onMessage({t:'hello_ack',protocolVersion:3,capabilities:{dependencyEvents:true}})
for(let i=0;i<N;i++) {
  const id='probe:'+i, start=performance.now();clicks.set(id,start)
  const page={state:c.loadState(),visible:true,refresh(){record('click_to_ui_ms',performance.now()-start)}}
  assert(await commitPageAction(page,function(){this.state.workout.rows[0][0].w=String(51+i);c.stageSessionEvent(this.state,{t:'weight',sid:'probe',ex:0,set:1,weight:String(51+i),at:Date.now(),eventId:id,installationId:'probe-watch'});this.refresh()},c))
  await until(()=>committed===i+1 && c.pendingCount()===0)
}
phone.dispose();c.stopServer();await sleep(10)
let totalChunks=0,duplicates=0,restarts=0
for(let i=0;i<N;i++) {
  let logical=1000,txWrites=0,rxWrites=0
  const disk=()=>{const map=new Map();return{read:async key=>structuredClone(map.get(key)),write:async(key,value)=>{await sleep(1);map.set(key,structuredClone(value));return true}}}
  const td=disk(),rd=disk(),tw=td.write,rw=rd.write
  td.write=async(...args)=>{txWrites++;return tw(...args)};rd.write=async(...args)=>{rxWrites++;return rw(...args)}
  let applied=0
  const apply=async(msg,meta)=>{const result=await c.commitWireSnapshot(msg,meta);assert(result.ok);applied++;return result}
  let tx=persistentSender(td,()=>{},()=>logical),rx=persistentReceiver(rd,apply,()=>logical)
  const value={...watchSnapshotOf(S,null),t:'sync',protocolVersion:3,padding:'x'.repeat(19000)}
  delete value.wireHash;value.wireHash=wireHash(value)
  const beginAt=performance.now();await tx.enqueue(value)
  const seen=new Set();let restarted=false,recoveryAt=null
  for(let turn=0;turn<150;turn++) {
    const msg=await tx.next();if(!msg){logical+=65000;continue}
    await sleep(2)
    if(msg.t==='sync_chunk') {
      totalChunks++;if(seen.has(msg.index))duplicates++;seen.add(msg.index)
      // One actual chunk is dropped; both endpoint instances restart from the same stores.
      if(msg.index===6&&!restarted){restarted=true;restarts++;recoveryAt=performance.now();tx=persistentSender(td,()=>{},()=>logical);rx=persistentReceiver(rd,apply,()=>logical);logical+=65000;await tx.resume();continue}
    }
    const replies=await rx.receive(msg);for(const reply of replies)await tx.receipt(reply)
    if(replies.some(r=>r.t==='sync_applied')) {record('snapshot_total_ms',performance.now()-beginAt);record('restart_recovery_host_ms',performance.now()-recoveryAt);break}
  }
  assert.equal(applied,1);assert.equal(await tx.next(),null)
  record('snapshot_tx_writes',txWrites);record('snapshot_rx_metadata_and_chunk_writes',rxWrites)
}
const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1]
const report={kind:'single-process Windows host simulation',samples:N,injected:{storage_callback_ms:1,rpc_callback_ms:2,chunk_drop_index:6,both_endpoint_restarts_per_snapshot:1,virtual_reconnect_gap_ms:65000},clock:'performance.now; no cross-device clock subtraction',metrics:Object.fromEntries(Object.entries(metrics).map(([key,a])=>[key,{n:a.length,p50:percentile(a,.5),p95:percentile(a,.95)}])),watch_storage_write_calls:writes,chunk_send_attempts:totalChunks,duplicate_chunk_attempts:duplicates,retransmission_ratio:duplicates/totalChunks,restarts,host_process_max_rss_kib:process.resourceUsage().maxRSS,host_process_final_rss_bytes:process.memoryUsage().rss,not_measured:['real watch flash durability/latency','physical Bluetooth RPC','device UI frame presentation','firmware callback non-cancellation','device heap peak','phone native mirror/AtomicFile timing']}
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
