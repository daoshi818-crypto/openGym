// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { watchPersistence, watchSource, stripImports, loadWatchModule } from './watch-test-harness.js'

function harness(disk = new Map()) {
  vi.useFakeTimers(); vi.setSystemTime(1000000)
  const h = watchPersistence(disk), jobs = [], definition = { openGymRuntime: h.shared }
  if (!disk.has('session_state')) h.ctx.writeStored('session_state', { active: true, sid: 's', startedAt: 900000, hr: {} })
  const schedule = { scheduleJob: vi.fn(o => { jobs.push(o); o.success?.({ id: jobs.length }); return jobs.length }), cancel: vi.fn(() => true) }
  const brightness = { setKeepScreenOn: vi.fn(o => o.success?.()) }, log = vi.fn(), flushHr = vi.fn(async()=>({ok:true}))
  Object.assign(h.ctx, { schedule, brightness, bindRuntime() {}, recordDiagnostic: log, flushDiagnosticLog() {},
    WATCH_VERSION: 'test', console: {log(){}}, startServer: vi.fn(), startSessionHr: vi.fn(), replayPendingEvents: vi.fn(),
    loadState: () => h.ctx.readStored('session_state') || {}, flushHr,
  })
  loadWatchModule('training-runtime', h.ctx, ['createTrainingRuntime'])
  runInNewContext(stripImports(watchSource('app.ux').match(/<script>([\s\S]*?)<\/script>/)[1]).replace('export default','globalThis.app ='),h.ctx)
  const app = h.ctx.app, instance = { $def: definition }
  app.onCreate.call(instance)
  return { ...h, app, instance, schedule, brightness, log, flushHr, jobs }
}
const settle = async () => { for(let i=0;i<30;i++) await Promise.resolve() }
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers()})

it('holds the screen during an active foreground workout even when no rest countdown is running',async()=>{
  const h=harness();h.brightness.setKeepScreenOn.mockClear();h.app.onShow.call(h.instance);await settle()
  expect(h.brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({keepScreenOn:true}))
  await vi.advanceTimersByTimeAsync(300000)
  expect(h.brightness.setKeepScreenOn.mock.calls.every(([o])=>o.keepScreenOn)).toBe(true)
})
it('registers one official sleep-aware training checkpoint job instead of relying on Page timers',async()=>{
  const h=harness();await settle()
  expect(h.jobs).toHaveLength(1)
  expect(h.jobs[0]).toMatchObject({type:2,timeout:60000,triggerMethod:'onTrainingMaintenance',params:{sid:'s'}})
  expect(h.jobs[0].interval).toBeUndefined()
})
it('checkpoints HR and releases the screen on App hide, without closing training or stopping transport',async()=>{
  const h=harness();h.app.onShow?.call(h.instance);await settle()
  h.app.onHide?.call(h.instance);await settle()
  expect(h.flushHr).toHaveBeenCalled()
  expect(h.brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({keepScreenOn:false}))
  expect(h.ctx.readStored('session_state')).toMatchObject({active:true,sid:'s'})
  expect(h.log).toHaveBeenCalledWith('app_hide',expect.anything())
})
it('does not schedule more jobs or update the screen for repeated HR-only commits',async()=>{
  const h=harness();h.app.onShow.call(h.instance);await settle()
  const screens=h.brightness.setKeepScreenOn.mock.calls.length
  for(let i=0;i<50;i++) await h.ctx.writeStoredAtomic('session_state',s=>({...s,hr:{count:i,sum:i*120}}))
  expect(h.jobs).toHaveLength(1)
  expect(h.brightness.setKeepScreenOn).toHaveBeenCalledTimes(screens)
})
it.each(['paused','closed','frozen'])('cancels the job and releases foreground display when training is %s',async mode=>{
  const h=harness();h.app.onShow.call(h.instance);await settle()
  const saved=h.ctx.readStored('training_background_job_v1')
  await h.ctx.writeStoredAtomic('session_state',s=>mode==='closed'?{active:false}:mode==='frozen'?{...s,closeIntent:{}}:{...s,pausedAt:Date.now()})
  await settle()
  expect(h.schedule.cancel).toHaveBeenCalledWith(saved.id)
  expect(h.brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({keepScreenOn:false}))
  expect(h.ctx.readStored('training_background_job_v1')).toBeNull()
  expect(await h.app.onTrainingMaintenance.call(h.instance,h.jobs[0].params)).toBe(false)
})
it('does not change display ownership until a pause has actually been committed',async()=>{
  const h=harness();h.app.onShow.call(h.instance);await settle()
  const write=h.storage.set;let pending
  h.storage.set=o=>o.key==='session_state'?pending=o:write(o)
  const pause=h.ctx.writeStoredAtomic('session_state',s=>({...s,pausedAt:Date.now()}))
  expect(h.brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({keepScreenOn:true}))
  pending.fail();expect((await pause).ok).toBe(false);await settle()
  expect(h.brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({keepScreenOn:true}))
})
it('runs a background checkpoint once and arms a new one-shot without opening any Page',async()=>{
  const h=harness();h.app.onHide.call(h.instance);await settle();h.flushHr.mockClear()
  const params=h.jobs[0].params
  expect(await h.app.onTrainingMaintenance.call(h.instance,params)).toBe(true)
  await settle()
  expect(h.flushHr).toHaveBeenCalledOnce();expect(h.jobs).toHaveLength(2)
  expect(h.ctx.readStored('training_background_job_v1').token).not.toBe(params.token)
  expect(await h.app.onTrainingMaintenance.call(h.instance,params)).toBe(false)
  expect(h.flushHr).toHaveBeenCalledOnce()
})
it('rejects old session and segment jobs after training has changed',async()=>{
  const h=harness();await settle();const previous=h.jobs[0]
  await h.ctx.writeStoredAtomic('session_state',s=>({...s,segmentStartedAt:Date.now()}));await settle()
  expect(h.jobs).toHaveLength(2)
  expect(await h.app.onTrainingMaintenance.call(h.instance,previous.params)).toBe(false)
  await h.ctx.writeStoredAtomic('session_state',s=>({...s,sid:'next'}));await settle()
  expect(h.jobs).toHaveLength(3)
  expect(await h.app.onTrainingMaintenance.call(h.instance,h.jobs[1].params)).toBe(false)
})
it('keeps at most one persisted recovery job on destruction and rejects late callbacks',async()=>{
  const h=harness();h.app.onShow.call(h.instance);await settle()
  const saved=h.ctx.readStored('training_background_job_v1'), params=h.jobs[0].params
  h.app.onDestroy.call(h.instance)
  expect(h.schedule.cancel).not.toHaveBeenCalledWith(saved.id)
  expect(await h.app.onTrainingMaintenance.call(h.instance,params)).not.toBe(true)
  const count=h.jobs.length
  await vi.advanceTimersByTimeAsync(120000)
  expect(h.jobs).toHaveLength(count);expect(vi.getTimerCount()).toBe(0)
})
it('a cold restart cancels the known previous job, restores training and fences the old token',async()=>{
  const first=harness();await settle();const saved=first.ctx.readStored('training_background_job_v1'),params=first.jobs[0].params
  first.app.onDestroy.call(first.instance)
  const second=harness(first.disk);await settle()
  expect(second.schedule.cancel).toHaveBeenCalledWith(saved.id)
  expect(second.ctx.startServer).toHaveBeenCalled()
  expect(second.ctx.startSessionHr).toHaveBeenCalled()
  expect(second.ctx.readStored('session_state')).toMatchObject({active:true,sid:'s'})
  expect(await second.app.onTrainingMaintenance.call(second.instance,params)).toBe(false)
})
it('native registration failure is bounded and a foreground resume can retry',async()=>{
  const h=harness();await settle()
  h.schedule.scheduleJob.mockImplementationOnce(o=>o.fail(null,-27))
  await h.ctx.writeStoredAtomic('session_state',s=>({...s,sid:'next'}));await settle()
  const count=h.jobs.length
  for(let i=0;i<20;i++) await h.ctx.writeStoredAtomic('session_state',s=>({...s,hr:{count:i}}))
  await vi.advanceTimersByTimeAsync(10000)
  expect(h.jobs).toHaveLength(count)
  expect(h.log).toHaveBeenCalledWith('training_job_failed',{code:-27})
  h.app.onShow.call(h.instance);await settle()
  expect(h.jobs).toHaveLength(count+1)
})
it('failed job persistence cancels the native job without affecting the workout',async()=>{
  const h=harness();await settle();const write=h.storage.set
  h.storage.set=o=>o.key==='training_background_job_v1'?o.fail():write(o)
  await h.ctx.writeStoredAtomic('session_state',s=>({...s,sid:'next'}));await settle()
  expect(h.schedule.cancel).toHaveBeenCalledWith(2)
  expect(h.ctx.readStored('session_state').sid).toBe('next')
  expect(h.log).toHaveBeenCalledWith('training_job_storage_failed',{})
})
it('lost native registration callbacks expire locally and late success is cancelled',async()=>{
  const h=harness();await settle();let lost
  h.schedule.scheduleJob.mockImplementationOnce(o=>{lost=o})
  await h.ctx.writeStoredAtomic('session_state',s=>({...s,sid:'next'}));await settle()
  await vi.advanceTimersByTimeAsync(5001)
  expect(h.log).toHaveBeenCalledWith('training_job_failed',{code:'callback_timeout'})
  lost.success({id:77});await settle()
  expect(h.schedule.cancel).toHaveBeenCalledWith(77)
  h.app.onShow.call(h.instance);await settle()
  expect(h.ctx.readStored('training_background_job_v1').sid).toBe('next')
})
it('a read failure cannot trap the screen on or crash the App lifecycle callback',async()=>{
  const h=harness();h.app.onShow.call(h.instance);await settle()
  h.ctx.loadState=()=>{throw new Error('temporary storage failure')}
  expect(()=>h.app.onHide.call(h.instance)).not.toThrow();await settle()
  expect(h.brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({keepScreenOn:false}))
  expect(h.log).toHaveBeenCalledWith('training_state_failed',{})
})
it('bounds active recovery to the existing six-hour training lifetime',async()=>{
  const h=harness();h.app.onShow.call(h.instance);await settle()
  vi.setSystemTime(900000+21600001)
  h.app.onShow.call(h.instance);await settle()
  expect(h.brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({keepScreenOn:false}))
  expect(h.schedule.cancel).toHaveBeenCalledWith(1)
  expect(h.ctx.readStored('training_background_job_v1')).toBeNull()
})
it('a native display failure never changes training data or starts a tight retry loop',async()=>{
  const h=harness();await settle()
  h.brightness.setKeepScreenOn.mockImplementationOnce(o=>o.fail(null,205))
  h.app.onShow.call(h.instance);await settle()
  expect(h.ctx.readStored('session_state')).toMatchObject({active:true,sid:'s'})
  const n=h.brightness.setKeepScreenOn.mock.calls.length
  await vi.advanceTimersByTimeAsync(10000)
  expect(h.brightness.setKeepScreenOn).toHaveBeenCalledTimes(n)
  expect(h.log).toHaveBeenCalledWith('training_screen_failed',{code:205})
  h.app.onDestroy.call(h.instance)
  expect(h.brightness.setKeepScreenOn).toHaveBeenLastCalledWith(expect.objectContaining({keepScreenOn:false}))
})
it('an idle cold start cancels obsolete training jobs and never requests a bright screen',async()=>{
  const h=harness(new Map([['session_state',{active:false}],['training_background_job_v1',{id:42,token:'old',sid:'old'}]]))
  h.app.onShow.call(h.instance);await settle()
  expect(h.schedule.cancel).toHaveBeenCalledWith(42)
  expect(h.jobs).toHaveLength(0)
  expect(h.ctx.readStored('training_background_job_v1')).toBeNull()
  expect(h.brightness.setKeepScreenOn.mock.calls.every(([o])=>!o.keepScreenOn)).toBe(true)
})
it('a checkpoint failure retains training and schedules a bounded later retry',async()=>{
  const h=harness();await settle();h.flushHr.mockResolvedValueOnce({ok:false})
  expect(await h.app.onTrainingMaintenance.call(h.instance,h.jobs[0].params)).toBe(true)
  await settle()
  expect(h.ctx.readStored('session_state')).toMatchObject({active:true,sid:'s'})
  expect(h.log).toHaveBeenCalledWith('training_checkpoint_failed',{})
  expect(h.jobs).toHaveLength(2);expect(h.jobs[1].timeout).toBe(60000)
})
