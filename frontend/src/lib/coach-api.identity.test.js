// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const mock=vi.hoisted(()=>({state:{},api:vi.fn()}))
vi.mock('./demo.js',()=>({DEMO:false}))
vi.mock('./mobile.js',()=>({MOBILE:false}))
vi.mock('./api.js',()=>({api:mock.api}))
vi.mock('../store/useStore.js',()=>({useStore:{getState:()=>mock.state}}))
vi.mock('../store/useUI.js',()=>({useUI:{getState:()=>({})}}))
import { coachStatus, requestPlan, awaitedJob, resolvePending, settleAwaited } from './coach-api.js'
beforeEach(()=>{mock.state={S:{},sync:{server:'https://a.test'},user:{id:'a'}};mock.api.mockReset();settleAwaited()})
it('discards a pending status answer after switching accounts',async()=>{
  let release;mock.api.mockImplementation(()=>new Promise(r=>{release=r}))
  const status=coachStatus();mock.state.user={id:'b'};release({pending:{id:'a-proposal'}})
  await expect(status).rejects.toThrow('account changed')
})
it('does not attach a delayed job acknowledgement to the new server',async()=>{
  let release;mock.api.mockImplementation(()=>new Promise(r=>{release=r}))
  const job=requestPlan({});mock.state.sync={server:'https://b.test'};release({job:{id:'a-job'}});await job
  expect(awaitedJob()).toBeNull()
  mock.state.sync={server:'https://a.test'};expect(awaitedJob()).toBe('a-job')
})
it('defers an outbox decision belonging to another server or account',async()=>{
  const result=await resolvePending({origin:'server',originIdentity:JSON.stringify(['https://other.test','a']),proposalId:'p',requestId:'r'})
  expect(result).toEqual({deferred:true});expect(mock.api).not.toHaveBeenCalled()
})
