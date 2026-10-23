// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
const code = name => readFileSync(new URL('../../../watch-app/src/lib/'+name+'.js', import.meta.url),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/export function /g,'function ')
it('owns one HR subscription across pages and saves samples against the latest session', () => {
  const shared = {}, values = new Map(), samples = []
  const health = { DATA_TYPES: { HEART_RATE:1 }, subscribeSample: vi.fn(o=>samples.push(o)), unsubscribeSample: vi.fn() }
  const runtime = () => shared
  const page = () => {
    const ctx = { runtime, health, vibrator: {}, console, Date,
      storage: { set() {} }, readStored: key=>structuredClone(values.get(key)), writeStored: (k,v)=>values.set(k,structuredClone(v)) }
    runInNewContext(code('session')+'\n'+code('sensors')+'\nthis.api={startSession,save,loadState,startSessionHr,closeSession}',ctx)
    return ctx.api
  }
  const a=page(), b=page()
  a.startSession({sid:'s',exercises:[{sets:1,weight:20,reps:10}]})
  a.startSessionHr(); b.startSessionHr()
  expect(health.subscribeSample).toHaveBeenCalledTimes(1)
  const stale = a.loadState()
  samples[0].callback({value:120})
  stale.workout.rows[0][0].w=35; a.save(stale)
  expect(b.loadState().hr).toMatchObject({count:1,last:120})
  expect(b.loadState().workout.rows[0][0].w).toBe(35)
  const paused=b.loadState(); paused.pausedAt=Date.now(); b.save(paused)
  samples[0].callback({value:130})
  expect(a.loadState().hr.count).toBe(1)
  expect(health.unsubscribeSample).toHaveBeenCalledTimes(1)
  paused.pausedAt=0; b.save(paused); b.startSessionHr()
  expect(health.subscribeSample).toHaveBeenCalledTimes(2)
  a.closeSession('s')
  samples[1].callback({value:140})
  expect(health.unsubscribeSample).toHaveBeenCalledTimes(2)
  expect(a.loadState().active).toBe(false)
})
