// @vitest-environment node
import { expect, it } from 'vitest'
import { loadWatchModule, watchPersistence } from './watch-test-harness.js'
import { canonicalWire } from '../../../watch-app/src/lib/sync-wire.js'
import { applyEdit, applyRest } from '../../../watch-app/src/lib/protocol.js'

function harness() {
  const h=watchPersistence()
  Object.assign(h.ctx,{applyEdit,applyRest})
  loadWatchModule('session',h.ctx,['startSession','loadState','applySync','commitWireSnapshot'])
  h.ctx.startSession({sid:'s',name:'推',exercises:[{entryInstanceId:'e',name:'卧推',sets:1,setIds:['r'],reps:8,weight:20}]})
  const snapshot=(commitRev,rev,weight)=>canonicalWire({sid:'s',commitRev,rev,workout:'推',
    exercises:[{entryInstanceId:'e',name:'卧推',sets:1,setIds:['r'],reps:8,weight:20}],rows:[[{setId:'r',w:weight,r:8,done:false}]]})
  const meta=(message,id)=>({sid:'s',revision:message.commitRev,transferId:id,hash:message.wireHash})
  return {...h,snapshot,meta}
}
it('retains an older stamped snapshot at the same business revision and persists its receipt', async () => {
  const {ctx,snapshot,meta}=harness(), fresh=snapshot(4,2000,40), old=snapshot(4,1000,20)
  expect(await ctx.commitWireSnapshot(fresh,meta(fresh,'new'))).toMatchObject({ok:true,status:'applied'})
  expect(await ctx.commitWireSnapshot(old,meta(old,'old'))).toMatchObject({ok:true,status:'retained'})
  expect(ctx.loadState()).toMatchObject({commitRev:4,snapshotRev:2000,workout:{rows:[[{w:40}]]}})
  // Exact transfer replay reports retained again; it cannot become a delta base.
  expect(await ctx.commitWireSnapshot(old,meta(old,'old'))).toMatchObject({ok:true,status:'retained'})
  expect(ctx.loadState().syncBase.wireHash).toBe(fresh.wireHash)
})
it('lets a newer business revision win even when the phone timestamp goes backwards', async () => {
  const {ctx,snapshot,meta}=harness(), fresh=snapshot(4,2000,40), next=snapshot(5,1000,50)
  await ctx.commitWireSnapshot(fresh,meta(fresh,'new'))
  expect(await ctx.commitWireSnapshot(next,meta(next,'next'))).toMatchObject({ok:true,status:'applied'})
  expect(ctx.loadState()).toMatchObject({commitRev:5,snapshotRev:1000,workout:{rows:[[{w:50}]]}})
})
it('uses the same ordering rule for direct application and newer same-revision snapshots', () => {
  const {ctx,snapshot}=harness(), state=ctx.loadState()
  ctx.applySync(state,snapshot(4,2000,40)); ctx.applySync(state,snapshot(4,1000,20))
  expect(state.workout.rows[0][0].w).toBe(40)
  ctx.applySync(state,snapshot(4,3000,45)); expect(state.workout.rows[0][0].w).toBe(45)
})
it('keeps legacy stamp protection when protocolVersion is absent', () => {
  const {ctx,snapshot}=harness(), state=ctx.loadState(), first=snapshot(0,2000,40), old=snapshot(0,1000,20)
  delete first.protocolVersion; delete old.protocolVersion
  ctx.applySync(state,first); ctx.applySync(state,old)
  expect(state.workout.rows[0][0].w).toBe(40)
})
