import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tempData, writeState, recentSampleState } from './helpers.mjs';
import { selectionForWorkout, selectionForPlan } from '../coach/core/debrief-selection.js';
const dir = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const day = new Date().toISOString().slice(0,10);
const workout = (id, rid, i) => ({ id, d: day, start: Date.now()-3600000+i*1000, end: Date.now(), name: rid,
  routineIds:[rid], entries:[{id:'0001',sets:[{done:true,w:20+i,r:10}]}] });
const source = () => recentSampleState({routines:[{id:'chest',name:'Chest',ex:[{id:'0001',sets:3,reps:10}]},{id:'abs',name:'Abs',ex:[]}],workouts:[workout('chest','chest',1),workout('abs','abs',2)]});
async function settle(uid) {
  const until = Date.now()+10000;
  while(jobs.status(uid).job && Date.now()<until) await new Promise(r=>setTimeout(r,10));
  assert.equal(jobs.status(uid).job,null);
  return jobs.status(uid);
}
test('real queue preserves frozen session selection, report evidence, scope and decision identity',async()=>{
  let answer={summary:'Only recorded sessions.',score:8,highlights:['Work sets recorded.'],watch:[],nextTime:[],trends:[],dataLimitations:[]},calls=0;
  const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  cfg.save({enabled:true,provider:'compatible',providerOptions:{compatible:{baseUrl:'http://127.0.0.1:'+server.address().port}},models:{compatible:'fixture'},caps:{perProfileDaily:20}});
  try {
    const S=source();writeState(dir,'single',S);
    jobs.enqueue('single',{kind:'debrief',debriefSelection:selectionForWorkout(S,S.workouts[0])});
    const first=(await settle('single')).pending;
    assert.equal(first.workout.id,'chest');assert.equal(first.evidenceSnapshot.sessions.length,1);
    assert.throws(()=>jobs.resolvePending('single',{proposalId:'wrong',requestId:'r'}),e=>e.code==='pending_mismatch');
    assert.equal(jobs.status('single').pending.id,first.id);
    jobs.resolvePending('single',{proposalId:first.id,requestId:'keep',accepted:['debrief']});
    jobs.enqueue('single',{kind:'debrief',debriefSelection:selectionForWorkout(S,S.workouts[1])});
    const second=(await settle('single')).pending;
    assert.equal(jobs.resolvePending('single',{proposalId:first.id,requestId:'retry'}).alreadyResolved,true);
    assert.equal(jobs.status('single').pending.id,second.id);

    const P=source();P.workouts=Array.from({length:6},(_,i)=>workout('c'+i,'chest',i)).flatMap((w,i)=>[w,workout('a'+i,'abs',i+100)]);
    const selection=selectionForPlan(P,'chest',5);
    P.workouts.push(workout('later','chest',200));writeState(dir,'plan',P);
    jobs.enqueue('plan',{kind:'debrief',debriefSelection:selection});
    const report=(await settle('plan')).pending;
    assert.equal(report.scope.actual,5);
    assert.deepEqual(report.evidenceSnapshot.sessions.map(w=>w.id),['c1','c2','c3','c4','c5']);
    assert.equal(jobs.readState('plan').coach.lastReview,undefined);
    const beforeCalls=calls, beforeCap=jobs.capState('plan').used;
    P.workouts.find(w=>w.id==='c1').entries[0].sets[0].w=99;writeState(dir,'plan',P);
    assert.throws(()=>jobs.enqueue('plan',{kind:'debrief',debriefSelection:selection}),e=>e.code==='selection_stale');
    assert.equal(calls,beforeCalls);assert.equal(jobs.capState('plan').used,beforeCap);

    answer={summary:'Outside scope.',changes:[{id:'bad',type:'week',target:{weekday:1},before:null,after:'abs',why:'Wrong scope.'}]};
    writeState(dir,'scoped',source());
    jobs.enqueue('scoped',{kind:'review',scope:{kind:'routine',routineId:'chest'}});
    const rejected=await settle('scoped');assert.equal(rejected.pending,null);assert.equal(rejected.last.errorClass,'unusable');
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
