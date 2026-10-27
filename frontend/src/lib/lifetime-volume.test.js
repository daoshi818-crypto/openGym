import { describe, expect, it } from 'vitest'
import { lifetimeVolume } from './history.js'
describe('lifetime volume', () => {
  it('recounts sets, leaves warmups out and includes imported and legacy totals', () => {
    expect(lifetimeVolume({workouts:[{entries:[{sets:[{w:60,r:5,done:true},{w:20,r:10,done:true,phase:'warmup',warmup:true}]}],vol:0},{vol:5000},{vol:-10}]})).toBe(5300)
    expect(lifetimeVolume({})).toBe(0)
  })
})
