// @vitest-environment node
import { expect, it } from 'vitest'
import { maxHeartRate, heartZone, zoneView, muscleView } from '../../../watch-app/src/lib/official-metrics.js'
import { watchPlanOf, watchSnapshotOf, watchProfileOf } from './watch-workout.js'
import { MUSCLES } from './muscles.js'
import { EXDB } from './exercises.js'

it('uses the upstream age limits and Tanaka boundaries without assuming a missing age', () => {
  expect(maxHeartRate(undefined, 2026)).toBeNull()
  expect(maxHeartRate(2020, 2026)).toBeNull()
  expect(maxHeartRate(1925, 2026)).toBeNull()
  expect(maxHeartRate(2016, 2026)).toBe(201)
  expect(maxHeartRate(1926, 2026)).toBe(138)
  expect(maxHeartRate(1996, 2026)).toBe(187)
  expect(heartZone(112,187)).toBe(1); expect(heartZone(113,187)).toBe(2)
  expect(heartZone(149,187)).toBe(3); expect(heartZone(150,187)).toBe(4)
  expect(heartZone(168,187)).toBe(4); expect(heartZone(169,187)).toBe(5)
  expect(heartZone(0,187)).toBeNull()
})
it('renders actual zone durations Z5 to Z1 and tracks birth-year changes from the same histogram', () => {
  const hr = {last:150,bpmSeconds:{112:30,113:12,150:3,169:15}}
  const view=zoneView(hr,1996,2026)
  expect(view.rows.map(r=>[r.zone,r.band,r.time])).toEqual([
    ['Z5','169+','0:15'],['Z4','150–168','0:03'],['Z3','131–149','0:00'],['Z2','113–130','0:12'],['Z1','<113','0:30']])
  expect(view.rows.find(r=>r.current).zone).toBe('Z4')
  expect(zoneView(hr,1926,2026).rows[0].time).toBe('0:18')
  expect(zoneView(hr,null,2026).max).toBeNull()
})
it('counts completed working sets per muscle, sorts shares, and keeps all rows in the denominator', () => {
  const view=muscleView({exercises:[{muscles:{chest:1,triceps:.5}},{muscles:{chest:.2,deltoids:1}}],
    rows:[[{done:true},{done:true,warmup:true},{done:false}],[{done:true},{done:true}]]})
  expect(view.rows.map(r=>[r.key,r.value,r.name])).toEqual([['deltoids','2','肩部'],['chest','1.4','胸部'],['triceps','0.5','肱三头肌']])
  expect(muscleView({exercises:[{}],rows:[[{done:true}]]}).rows).toEqual([])
})
it('transmits real muscle weights and valid birth years in active plans and snapshots', () => {
  const ex=EXDB.find(e=>e.tg && e.eq!=='body weight'), S={unit:'kg',birthYear:1996,restSec:60,bodyweight:[],
    active:{start:1,name:'推',entries:[{id:ex.id,sets:[{w:20,r:8}]}]}}
  const plan=watchPlanOf(S), muscles=plan.workout.exercises[0].muscles
  expect(Object.keys(muscles).length).toBeGreaterThan(0)
  expect(Object.keys(muscles).every(k=>MUSCLES.includes(k))).toBe(true)
  expect(watchSnapshotOf(S,null).exercises[0].muscles).toEqual(muscles)
  expect(watchSnapshotOf(S,null).profile.birthYear).toBe(1996)
  expect(plan.profile.birthYear).toBe(1996)
  expect(watchProfileOf({...S,birthYear:2025}).birthYear).toBeUndefined()
})
