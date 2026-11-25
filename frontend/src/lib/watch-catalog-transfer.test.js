// @vitest-environment node
import { expect, it } from 'vitest'
import { persistentSender, persistentReceiver } from '../../../watch-app/src/lib/persistent-transfer.js'
import { wireHash } from '../../../watch-app/src/lib/sync-wire.js'

const disk = () => { const map = new Map(); return { map, read: async k => structuredClone(map.get(k)), write: async (k, v) => { map.set(k, structuredClone(v)); return true } } }
it('keeps explicitly configured legacy catalog transfers separate from active-workout transfers and waits for durable apply', async () => {
  const txDisk = disk(), rxDisk = disk(), applied = []
  const options = { channel: 'catalog', types: ['plan_catalog'] }
  const payload = { t: 'plan_catalog', sid: 'catalog', commitRev: 1, at: 1, date: '2026-11-19', catalogId: 'c1', plans: [{ name: '中文'.repeat(1500) }] }
  payload.contentHash = wireHash({ ...payload, contentHash: undefined })
  let finish
  const tx = persistentSender(txDisk, m => applied.push(m), () => 1000, null, null, options)
  const rx = persistentReceiver(rxDisk, () => new Promise(resolve => { finish = resolve }), () => 1000, options)
  await tx.enqueue(payload)
  expect(txDisk.map.has('catalog_tx_v1')).toBe(true)
  const begin = await tx.next(); expect(begin.transferId.startsWith('c:')).toBe(true)
  for (const reply of await rx.receive(begin)) await tx.receipt(reply)
  for (let i = 0; i < begin.count - 1; i++) for (const reply of await rx.receive(await tx.next())) await tx.receipt(reply)
  const last = rx.receive(await tx.next())
  for (let i = 0; i < 20 && !finish; i++) await Promise.resolve()
  expect(applied).toHaveLength(0)
  finish({ ok: true })
  for (const reply of await last) await tx.receipt(reply)
  expect(applied).toHaveLength(1)
  expect(txDisk.map.has('sync_tx_v1')).toBe(false)
})
