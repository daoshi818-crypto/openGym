import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tempData, writeState, recentSampleState } from './helpers.mjs';
const dir = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const { coachRoutes } = await import('../coach/routes.js');
const P = () => ({ coach_contract: 1, chat_actions_contract: 1, replyType: 'proposal', answer: 'Pending confirmation', summary: 'One edit', targetRoutineId: 'r1', changes: [{ id: 'one', type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4, why: 'User request' }], notes: [], clarification: '' });
async function settle(uid) { for (let i=0;i<300;i++) { const s=jobs.status(uid); if (!s.job) return s; await new Promise(r=>setTimeout(r,10)); } throw new Error('not settled'); }
test('chat queue: idempotency, read/revise/failure, stale completion and old client gate', async () => {
  let answer = P(), calls=0, release = null, hold=false;
  const server = http.createServer((req,res) => { req.resume(); req.on('end', async () => { calls++; if (hold) await new Promise(r=>release=r); res.setHeader('content-type','application/json'); res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]})); }); });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  cfg.save({enabled:true,provider:'compatible',providerOptions:{compatible:{baseUrl:'http://127.0.0.1:'+server.address().port}},models:{compatible:'fixture'},caps:{perProfileDaily:20}});
  const uid='chat', S=recentSampleState(); writeState(dir,uid,S);
  const req = (id, extra={}) => ({ kind:'chat', chatActionsVersion:1, note:'Please adjust',clientRequestId:id,...extra });
  try {
    const a=req('q1'), started=jobs.enqueue(uid,a); assert.deepEqual(jobs.enqueue(uid,a),started);
    let s=await settle(uid), p1=s.pending;
    assert.equal(calls,1); assert.equal(s.cap.used,1); assert.equal(p1.kind,'review'); assert.equal(p1.source,'chat'); assert.equal(p1.revision,1);
    assert.equal(jobs.readState(uid).routines[0].ex[0].sets,S.routines[0].ex[0].sets);
    jobs.enqueue(uid,a); assert.equal(jobs.capState(uid).used,1);
    assert.throws(()=>jobs.enqueue(uid,{...a,note:'different'}),e=>e.code==='invalid_request');
    assert.throws(()=>jobs.enqueue(uid,{kind:'ask',note:'old client'}),e=>e.code==='upgrade_required');
    const routes=coachRoutes({json:(_res,status,body)=>({status,body}),readSession:()=>({id:uid}),readBody:async()=>({}),requireAdmin:()=>true});
    const legacy=await routes['GET /api/coach/status']({url:'/api/coach/status'},{});
    // json helper return is not propagated in the normal route: capture it explicitly below.
    let response; const gate=coachRoutes({json:(_r,status,body)=>response={status,body},readSession:()=>({id:uid}),readBody:async()=>({}),requireAdmin:()=>true});
    await gate['GET /api/coach/status']({url:'/api/coach/status'},{}); assert.equal(response.body.pending,null); assert.equal(response.body.upgradeRequired,true); assert.equal(jobs.status(uid).pending.id,p1.id);
    await gate['GET /api/coach/status']({url:'/api/coach/status?chatActionsVersion=1'},{}); assert.equal(response.body.pending.id,p1.id);
    assert.throws(()=>jobs.resolvePending(uid,{proposalId:p1.id,requestId:'old'}),e=>e.code==='upgrade_required');
    answer={...P(),replyType:'answer',answer:'Explained, nothing applied',changes:[]};
    const ref={id:p1.id,revision:p1.revision};jobs.enqueue(uid,req('q2',{proposalRef:ref}));s=await settle(uid);
    assert.equal(s.pending.kind,'ask');assert.equal(s.pending.prev.id,p1.id);assert.equal(s.pending.changes,undefined);
    jobs.resolvePending(uid,{chatActionsVersion:1,proposalId:s.pending.id,requestId:'read'});assert.equal(jobs.status(uid).pending.id,p1.id);
    answer=P();answer.changes[0].after=5;jobs.enqueue(uid,req('q3',{proposalRef:ref}));s=await settle(uid);const p2=s.pending;
    assert.equal(p2.revision,2);assert.equal(p2.parentProposalId,p1.id);assert.notEqual(p2.id,p1.id);
    answer={...P(),changes:[{...P().changes[0],type:'week'}]};jobs.enqueue(uid,req('q4',{proposalRef:{id:p2.id,revision:2}}));s=await settle(uid);assert.equal(s.last.outcome,'failed');assert.equal(s.pending.id,p2.id);
    hold=true;answer=P();jobs.enqueue(uid,req('q5',{proposalRef:{id:p2.id,revision:2}}));
    while(!release) await new Promise(r=>setTimeout(r,5));
    jobs.resolvePending(uid,{chatActionsVersion:1,revision:2,proposalId:p2.id,requestId:'dismiss',dismissed:true});release();hold=false;
    s=await settle(uid);assert.equal(s.pending,null);assert.equal(s.last.errorClass,'pending_mismatch');
    const stored=JSON.parse(fs.readFileSync(path.join(dir,'coach',uid+'.json'),'utf8'));assert.equal(stored.chatRequests.length,5);
  } finally { if(release)release(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
});
