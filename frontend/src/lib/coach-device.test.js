import { it, expect, vi, beforeEach } from 'vitest'
const disk = vi.hoisted(() => ({ files: new Map(), writes: [], fail: false, gate: null }))
vi.mock('./mobile.js', () => ({
  readJsonFile: async name => { const v = disk.files.get(name); if (v instanceof Error) throw v; return structuredClone(v ?? null) },
  writeJsonFile: async (name, value) => { disk.writes.push(name); if (disk.gate) await disk.gate; if (disk.fail) throw new Error('disk failed'); disk.files.set(name, structuredClone(value)) }
}))
import { loadCoachDevice, saveCoachDevice, _resetCoachDevice, coachPersistenceError } from './coach-device.js'
beforeEach(() => { _resetCoachDevice(); disk.files.clear(); disk.writes = []; disk.fail = false; disk.gate = null })
it('merges queued patches against committed state and alternates recoverable slots', async () => {
  disk.files.set('opengym-coach.json', { mode: 'byok', provider: 'openai' })
  let release; disk.gate = new Promise(r => { release = r })
  const first = saveCoachDevice({ model: 'a' }), second = saveCoachDevice(d => ({ counter: (d.counter || 0) + 1 }))
  await Promise.resolve(); release(); await Promise.all([first, second])
  expect(await loadCoachDevice()).toMatchObject({ mode: 'byok', model: 'a', counter: 1, revision: 2 })
  expect(disk.writes).toEqual(['opengym-coach.json.a', 'opengym-coach.json.b'])
  disk.files.set('opengym-coach.json.b', new SyntaxError('truncated JSON')); _resetCoachDevice()
  expect(await loadCoachDevice()).toMatchObject({ revision: 1, model: 'a' })
})
it('surfaces write failure without changing cache, then allows a retry', async () => {
  await saveCoachDevice({ mode: 'off' }); disk.fail = true
  await expect(saveCoachDevice({ mode: 'byok' })).rejects.toThrow('disk failed')
  expect((await loadCoachDevice()).mode).toBe('off'); expect(coachPersistenceError()).toBeTruthy()
  disk.fail = false; await saveCoachDevice({ mode: 'byok' }); expect((await loadCoachDevice()).mode).toBe('byok')
})
it('refuses to overwrite corrupt settings when no valid recovery copy exists', async () => {
  disk.files.set('opengym-coach.json', new SyntaxError('corrupt'))
  await expect(saveCoachDevice({ mode: 'off' })).rejects.toThrow('corrupt')
  expect(disk.writes).toEqual([])
})
it('recovers the older slot when a parseable newer snapshot has a bad checksum', async () => {
  await saveCoachDevice({ mode: 'byok', model: 'safe' })
  await saveCoachDevice({ model: 'new' })
  disk.files.get('opengym-coach.json.b').model = 'corrupted'
  _resetCoachDevice()
  expect(await loadCoachDevice()).toMatchObject({ model: 'safe', revision: 1 })
})
