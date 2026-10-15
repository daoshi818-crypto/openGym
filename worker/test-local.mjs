// Worker 本地测试：模拟 KV，跑通 配置 → 上传会话 → 导出 CSV 全链路
import worker from './src/index.js'

const store = new Map()
const env = {
  GYM_TOKEN: 'test-token',
  GYM_KV: {
    get: async (k, type) => { const v = store.get(k); return v == null ? null : (type === 'json' ? JSON.parse(v) : v) },
    put: async (k, v) => { store.set(k, v) },
    list: async ({ prefix = '' } = {}) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }),
  },
}

const base = 'https://x/?token=test-token'
const call = (path, init) => worker.fetch(new Request(base.replace('/?', path + '?'), init), env)

// 1) 未授权
const bad = await worker.fetch(new Request('https://x/config?token=wrong'), env)
console.log('1) 错误 token →', bad.status, bad.status === 403 ? '✓' : '✗')

// 2) 配置
const cfg = await (await call('/config')).json()
console.log('2) /config → 默认训练:', cfg.workout.name, '|', cfg.workout.exercises.length, '个动作 | profile:', JSON.stringify(cfg.profile))

// 3) 上传一个会话（模拟手表完成 2 组）
const session = {
  id: 's' + Date.now(),
  workout: cfg.workout.name,
  startedAt: Date.now() - 40 * 60000,
  endedAt: Date.now(),
  minutes: 40,
  avgHr: 128, maxHr: 156, calories: 312,
  sets: [
    { ex: cfg.workout.exercises[0].name, set: 1, reps: '12', weight: '35', at: Date.now() - 30 * 60000 },
    { ex: cfg.workout.exercises[0].name, set: 2, reps: '12', weight: '40', at: Date.now() - 28 * 60000 },
  ],
}
const up = await (await call('/session', { method: 'POST', body: JSON.stringify(session), headers: { 'content-type': 'application/json' } })).json()
console.log('3) /session →', JSON.stringify(up), up.ok ? '✓' : '✗')

// 4) 导出 CSV
const csv = await (await call('/export.csv')).text()
console.log('4) /export.csv →')
console.log(csv.split('\r\n').map(l => '   ' + l).join('\n'))
const rows = csv.trim().split('\r\n')
const ok = rows[0].startsWith('workout name,exercise,date,weight kg,reps') &&
  rows[1].includes('cable underhand pulldown') && rows[1].includes('35') && rows[1].includes('均心率128') && rows[2].includes('40')
console.log(ok ? '✓ CSV 列名、动作英文匹配名、重量、心率备注都正确' : '✗ CSV 有问题')
