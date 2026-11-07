// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { makeTransfer, persistentReceiver, persistentSender, TRANSFER_TTL } from '../../../watch-app/src/lib/persistent-transfer.js'
function disk() {
  const map = new Map(); let fail = false
  return { map, fail: value => { fail = value }, read: async key => structuredClone(map.get(key)), write: async (key, value) => { if (fail) return false; map.set(key, structuredClone(value)); return true } }
}
const snapshot = (rev = 1, data = 'x'.repeat(19500)) => ({ t: 'sync', protocolVersion: 3, sid: 's', commitRev: rev, data })
describe('persistent selective transfer, real disk adapter failure windows', () => {
  it('persists 20 chunks, loses one ACK, restarts both endpoints and only repeats the unconfirmed chunk', async () => {
    const txDisk = disk(), rxDisk = disk(), applied = []; let time = 1000
    const apply = async (msg, meta) => { if (!applied.includes(meta.transferId)) applied.push(meta.transferId); return { ok: true } }
    let tx = persistentSender(txDisk, () => {}, () => time), rx = persistentReceiver(rxDisk, apply, () => time)
    await tx.enqueue(snapshot()); const begin = await tx.next(); expect(begin.count).toBe(20)
    await tx.receipt((await rx.receive(begin))[0])
    const counts = {}; let lost = false
    for (let i = 0; i < 7; i++) {
      const chunk = await tx.next(); counts[chunk.index] = (counts[chunk.index] || 0) + 1
      const replies = await rx.receive(chunk)
      if (i === 6) { lost = true; break }
      await tx.receipt(replies[0])
    }
    expect(lost).toBe(true); expect(applied).toHaveLength(0)
    // A sender crash preserves byte-identical content and receiver disk includes chunk 6.
    tx = persistentSender(txDisk, () => {}, () => time); rx = persistentReceiver(rxDisk, apply, () => time)
    time += 65000; await tx.resume()
    const resumed = await tx.next(); expect(resumed.transferId).toBe(begin.transferId)
    const resumedAck = (await rx.receive(resumed))[0]; expect(resumedAck.received).toEqual([0, 1, 2, 3, 4, 5, 6])
    await tx.receipt(resumedAck)
    for (let i = 0; i < 20; i++) {
      const msg = await tx.next(); if (!msg) break
      if (msg.t === 'sync_chunk') counts[msg.index] = (counts[msg.index] || 0) + 1
      for (const reply of await rx.receive(msg)) await tx.receipt(reply)
    }
    expect(applied).toHaveLength(1); expect(Object.keys(counts)).toHaveLength(20)
    expect(Object.values(counts).every(n => n === 1)).toBe(true)
    expect(await tx.next()).toBeNull()
  })
  it('recovers saved chunks even when ACK and final applied receipt are lost', async () => {
    const store = disk(), applied = []; const apply = async (_, m) => { applied.push(m.transferId); return { ok: true } }
    const job = makeTransfer(snapshot(1, '小🏋️'.repeat(2000)), 1, 1)
    let rx = persistentReceiver(store, apply, () => 10)
    await rx.receive({ t: 'sync_begin', ...job.meta })
    for (let index = job.chunks.length - 1; index >= 0; index--) await rx.receive({ t: 'sync_chunk', ...job.meta, index, data: job.chunks[index] })
    expect(applied).toHaveLength(1)
    rx = persistentReceiver(store, apply, () => 100000)
    expect((await rx.receive({ t: 'sync_begin', ...job.meta }))[0].t).toBe('sync_applied')
    expect(applied).toHaveLength(1)
  })
  it('never ACKs a failed metadata/chunk write and never applies corrupt or expired data', async () => {
    const store = disk(); let applies = 0
    const rx = persistentReceiver(store, async () => { applies++; return { ok: true } }, () => 100)
    const job = makeTransfer(snapshot(1, '中文'), 1, 1)
    store.fail(true); expect((await rx.receive({ t: 'sync_begin', ...job.meta }))[0].t).toBe('sync_error')
    store.fail(false); await rx.receive({ t: 'sync_begin', ...job.meta })
    store.fail(true); expect((await rx.receive({ t: 'sync_chunk', ...job.meta, index: 0, data: job.chunks[0] }))[0].t).toBe('sync_error')
    store.fail(false); expect((await rx.receive({ t: 'sync_chunk', ...job.meta, index: 0, data: job.chunks[0].replace('中文', '文字') }))[0].t).toBe('sync_error')
    expect(applies).toBe(0)
    const restarted = persistentReceiver(store, async () => { applies++; return { ok: true } }, () => TRANSFER_TTL + 1000)
    expect((await restarted.receive({ t: 'sync_resume', ...job.meta }))[0].t).toBe('unknown_transfer'); expect(applies).toBe(0)
  })
  it('keeps in-flight content stable, coalesces only queued generations and bounds receiver slots', async () => {
    const d = disk(), tx = persistentSender(d)
    await tx.enqueue(snapshot()); const first = await tx.next()
    await tx.enqueue(snapshot(1, 'other')); await tx.enqueue(snapshot(2, 'newest'))
    const state = await d.read('sync_tx_v1'); expect(state.active.meta.transferId).toBe(first.transferId); expect(state.queued.snapshot.commitRev).toBe(2)
    const rx = persistentReceiver(disk(), async () => ({ ok: true }))
    for (let i = 1; i <= 2; i++) expect((await rx.receive({ t: 'sync_begin', ...makeTransfer(snapshot(i), i).meta }))[0].t).toBe('sync_begin_ack')
    expect((await rx.receive({ t: 'sync_begin', ...makeTransfer(snapshot(3), 3).meta }))[0].reason).toBe('transfer_capacity')
  })
})

it('drops an actual chunk, restarts both peers and resends only the missing block', async () => {
  const a=disk(), b=disk(); let time=1000, applications=0
  const apply=async()=>{ applications++; return {ok:true} }
  let tx=persistentSender(a,()=>{},()=>time), rx=persistentReceiver(b,apply,()=>time)
  await tx.enqueue(snapshot()); const begin=await tx.next(); await tx.receipt((await rx.receive(begin))[0])
  for(let i=0;i<6;i++) for(const m of await rx.receive(await tx.next())) await tx.receipt(m)
  const dropped=await tx.next(); expect(dropped.index).toBe(6) // NOT delivered to RX
  tx=persistentSender(a,()=>{},()=>time); rx=persistentReceiver(b,apply,()=>time); time+=65000; await tx.resume()
  const resume=await tx.next(); const reply=(await rx.receive(resume))[0]; expect(reply.received).toEqual([0,1,2,3,4,5]); await tx.receipt(reply)
  const repeated=await tx.next(); expect(repeated.index).toBe(6); expect(repeated.data).toBe(dropped.data)
  for(const m of await rx.receive(repeated)) await tx.receipt(m)
  for(let i=7;i<20;i++) { const chunk=await tx.next(); expect(chunk.index).toBe(i); for(const m of await rx.receive(chunk)) await tx.receipt(m) }
  expect(applications).toBe(1); expect(await tx.next()).toBeNull()
})
it('persists cancellation, retries lost cancel ACK after reboot, then rebuilds FULL with a new ID', async () => {
  const d=disk(); let time=1000
  const delta={...snapshot(),t:'sync_delta',baseCommitRev:99}, full=snapshot(2)
  let tx=persistentSender(d,()=>{},()=>time,async()=>full)
  await tx.enqueue(delta); const begin=await tx.next()
  await tx.receipt({...begin,t:'sync_error',reason:'revision_gap'})
  const cancel=await tx.next(); expect(cancel.t).toBe('sync_cancel'); expect(cancel.transferId).toBe(begin.transferId)
  tx=persistentSender(d,()=>{},()=>time,async()=>full); time+=65000
  expect((await tx.next()).t).toBe('sync_cancel')
  await tx.receipt({...cancel,t:'sync_cancel_ack'}); time+=65000
  const next=await tx.next(); expect(next.t).toBe('sync_begin'); expect(next.transferId).not.toBe(begin.transferId)
  expect((await d.read('sync_tx_v1')).active.snapshot).toEqual(full)
})
it('does not promote retained snapshots as Delta bases, including after receiver reboot', async () => {
  const d=disk(), rx=persistentReceiver(d,async()=>({ok:true,status:'retained'})), txDisk=disk(), bases=[]
  const tx=persistentSender(txDisk,s=>bases.push(s)); await tx.enqueue(snapshot(1,'small'))
  const begin=await tx.next(); await tx.receipt((await rx.receive(begin))[0])
  for(const reply of await rx.receive(await tx.next())) await tx.receipt(reply)
  expect(bases).toHaveLength(0); expect(await tx.next()).toBeNull()
  const restart=persistentReceiver(d,async()=>{throw Error('must not reapply')})
  expect((await restart.receive(begin))[0]).toMatchObject({t:'sync_applied',status:'retained'})
})
it('recovers training apply success / receiver index failure through the atomic application marker', async () => {
  const d=disk(); let marked=false, applies=0, failIndex=false
  const original=d.write; d.write=async(k,v)=> k==='sync_rx_v1' && failIndex ? false : original(k,v)
  const apply=async()=>{ if(!marked) { marked=true; applies++ } failIndex=true; return {ok:true} }
  let rx=persistentReceiver(d,apply), job=makeTransfer(snapshot(1,'small'),1)
  await rx.receive({...job.meta,t:'sync_begin'})
  expect((await rx.receive({...job.meta,t:'sync_chunk',index:0,data:job.chunks[0]}))[0].t).toBe('sync_error')
  failIndex=false
  rx=persistentReceiver(d,async()=>({ok:marked}))
  expect((await rx.receive({...job.meta,t:'sync_begin'}))[0].t).toBe('sync_applied')
  expect(applies).toBe(1)
})
