import test from 'node:test';
import assert from 'node:assert/strict';
import openai from '../coach/core/adapters/openai.js';
import { runPipeline } from '../coach/core/pipeline.js';
import { build } from '../coach/core/payload.js';
import { validateDebrief, validatePlan } from '../coach/core/validate.js';
import { selectionForWorkout, selectionForPlan } from '../coach/core/debrief-selection.js';

const env = { OPENAI_API_KEY: 'test-only' };
const record = (id, day, routine, weight) => ({ id, d: day, start: new Date(day + 'T10:00:00Z').getTime(),
  routineIds: [routine], name: routine, entries: [{ id: '0001', sets: [{ done: true, w: weight, r: 10 }] }] });
const state = () => ({ unit: 'kg', routines: [{ id: 'chest', name: 'Chest', ex: [{ id: '0001', sets: 3, reps: 10 }] }],
  coach: { profile: {}, consent: { version: 2, agreedAt: '2026-10-23' } },
  workouts: [record('old', '2026-08-01', 'chest', 100), record('chest-1', '2026-10-20', 'chest', 30),
    record('chest-2', '2026-10-21', 'chest', 35), record('chest-3', '2026-10-23', 'chest', 40), record('abs', '2026-10-23', 'abs', 5)] });

test('the request deadline covers a body which never finishes after headers', async () => {
  const result = await openai.invoke({ env, prompt: 'test', timeoutMs: 30,
    fetch: async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) }) });
  assert.equal(result.timedOut, true);
});

test('a pre-aborted request never invokes the transport', async () => {
  const ctl = new AbortController(); ctl.abort(); let calls = 0;
  const result = await openai.invoke({ env, prompt: 'test', signal: ctl.signal,
    fetch: async () => { calls++; throw new Error('must not send'); } });
  assert.equal(calls, 0); assert.equal(result.cancelled, true);
});

test('streamed oversized responses are cancelled before reading more chunks', async () => {
  let reads = 0, cancelled = false;
  const result = await openai.invoke({ env, prompt: 'test', fetch: async () => ({ ok: true, status: 200,
    body: { getReader: () => ({ read: async () => { reads++; return { done: false, value: new Uint8Array(1_100_000) }; },
      cancel: async () => { cancelled = true; }, releaseLock() {} }) } }) });
  assert.equal(result.code, 1); assert.equal(reads, 2); assert.equal(cancelled, true);
  assert.match(result.stderr, /limit/);
});

test('repair receives only the remaining job budget and token limits are not authentication failures', async () => {
  let calls = 0; const timeouts = [];
  const payload = { meta: {}, plan: {}, coachProfile: {} };
  const result = await runPipeline({ kind: 'review', payload, timeoutMs: 300,
    adapter: { spawns: false, invoke: async options => { calls++; timeouts.push(options.timeoutMs);
      if (calls === 1) { await new Promise(r => setTimeout(r, 20)); return { code: 0, text: 'bad JSON' }; }
      return { code: 1, stderr: 'output token limit reached' }; } } });
  assert.equal(calls, 2); assert.ok(timeouts[1] < timeouts[0]); assert.equal(result.errorClass, 'provider');
});

test('historical single debriefs and plan debriefs share exact frozen records', () => {
  const S = state(), selection = selectionForWorkout(S, S.workouts[3]);
  const single = build(S, { handle: 'test', kind: 'debrief', debriefSelection: selection });
  assert.equal(single.session.id, 'chest-3'); assert.ok(single.previous.every(w => w.name === 'chest'));
  const plan = build(S, { handle: 'test', kind: 'debrief', debriefSelection: selectionForPlan(S, 'chest', 3) });
  assert.deepEqual(plan.sessions.map(w => w.id), ['chest-1','chest-2','chest-3']);
  assert.equal(plan.debriefScope.actual, 3);
  const created = build(S, { handle: 'test', kind: 'create' });
  // The most recent three sessions of this exercise include the separate abs session.
  assert.equal(created.history.workingWeights[0].best, 40);
});

test('a plan trend cites two supplied sessions which actually contain the claimed exercise', () => {
  const data = { summary: 'Summary', highlights: ['Recorded'], trends: [{ text: 'Trend', exerciseId: '0001', sessionRefs: ['a','b'] }], dataLimitations: [] };
  const ctx = { scope: { mode: 'plan' }, sessions: [{ ref: 'a', entries: [{ id: '0001' }] }, { ref: 'b', entries: [{ id: '0002' }] }] };
  assert.equal(validateDebrief(data, ctx).ok, false);
  ctx.sessions[1].entries[0].id = '0001'; assert.equal(validateDebrief(data, ctx).ok, true);
  data.trends[0].sessionRefs = ['a']; assert.equal(validateDebrief(data, ctx).ok, false);
});

test('duplicate exercises in one workout consume one recent-session slot', () => {
  const S = {unit:'kg',coach:{profile:{}},routines:[],customEx:[],workouts:[
    {d:'2026-10-01',start:1,entries:[{id:'0001',sets:[{done:true,w:200,r:5}]}]},
    {d:'2026-10-02',start:2,entries:[{id:'0001',sets:[{done:true,w:60,r:5}]}]},
    {d:'2026-10-03',start:3,entries:[{id:'0001',sets:[{done:true,w:30,r:5}]}]},
    {d:'2026-10-04',start:4,entries:[20,25,28].map(w=>({id:'0001',sets:[{done:true,w,r:5}]}))}
  ]};
  assert.equal(build(S,{handle:'test',kind:'create'}).history.workingWeights[0].best,60);
});

test('created plans honor complete preferred weekdays and reject implausible session workloads', () => {
  const plan = { routines: [{ id: 'r', name: 'Short session', ex: [{ id: '0001', sets: 3, reps: 10 }] }], week: { 1: 'r', 3: 'r' } };
  const ctx = { daysPerWeek: 2, preferredDays: [1,3], sessionMin: 20 };
  assert.equal(validatePlan(plan, ctx).ok, true);
  const wrongDays = { ...plan, week: { 2: 'r', 4: 'r' } };
  assert.ok(validatePlan(wrongDays, ctx).errors.some(e => e.includes('preferredDays')));
  // An incomplete weekday preference does not silently invent a full schedule constraint.
  assert.equal(validatePlan(wrongDays, { ...ctx, preferredDays: [1] }).ok, true);
  const overloaded = structuredClone(plan);
  overloaded.routines[0].ex[0].sets = 10;
  assert.ok(validatePlan(overloaded, { ...ctx, sessionMin: 10 }).errors.some(e => e.includes('session time heuristic')));
});
