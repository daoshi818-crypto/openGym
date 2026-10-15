// 训练助手 · 云端中转站（Cloudflare Worker）
//
// 手表 → POST /session → KV 存储
//                       → GET /export.csv → openGym 可直接导入的 CSV
//                       → GET /config     → 手表启动时拉取的训练安排
//
// 鉴权：请求带 ?token=XXX（或 X-Token 头），与 secret GYM_TOKEN 一致才放行。
import DEFAULT_CONFIG from './default-config.js'

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

function authed(request, env, url) {
  if (!env.GYM_TOKEN) return false
  const t = url.searchParams.get('token') || request.headers.get('X-Token')
  return t === env.GYM_TOKEN
}

// 中文显示名 → openGym 动作库英文名（导入 CSV 时靠它匹配到库动作）
function nameLookup(config) {
  const m = {}
  const all = (config.allWorkouts || []).concat(config.workout ? [config.workout] : [])
  for (const w of all) for (const ex of w.exercises || []) if (ex.gym) m[ex.name] = ex.gym
  return m
}

const pad = (n) => String(n).padStart(2, '0')
const isoDate = (ms) => {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function toCsv(sessions, config) {
  const lookup = nameLookup(config)
  const esc = (v) => {
    const s = String(v == null ? '' : v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const cols = ['workout name', 'exercise', 'date', 'weight kg', 'reps', 'note']
  const rows = [cols.join(',')]
  for (const s of sessions) {
    const date = isoDate(s.startedAt)
    const note = (s.avgHr ? '均心率' + s.avgHr + ' 最大' + (s.maxHr || '-') + ' ' : '') +
      (s.calories ? s.calories + '千卡 ' : '') + s.minutes + '分钟'
    ;(s.sets || []).forEach((set, i) => {
      rows.push([
        s.workout,
        lookup[set.ex] || set.ex,
        date,
        set.weight,
        set.reps,
        i === 0 ? note : '',
      ].map(esc).join(','))
    })
  }
  return rows.join('\r\n')
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!authed(request, env, url)) return new Response('forbidden', { status: 403 })

    const stored = await env.GYM_KV.get('config', 'json')
    const config = stored || DEFAULT_CONFIG

    if (url.pathname === '/config' && request.method === 'GET') {
      return json(config)
    }

    if (url.pathname === '/session' && request.method === 'POST') {
      let s
      try { s = await request.json() } catch (e) { return json({ ok: false, error: 'bad json' }, 400) }
      if (!s || !s.id) return json({ ok: false, error: 'bad payload' }, 400)
      await env.GYM_KV.put('s:' + s.id, JSON.stringify(s))
      return json({ ok: true })
    }

    if (url.pathname === '/export.csv' && request.method === 'GET') {
      const list = await env.GYM_KV.list({ prefix: 's:' })
      const sessions = []
      for (const k of list.keys) {
        const v = await env.GYM_KV.get(k.name, 'json')
        if (v) sessions.push(v)
      }
      sessions.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
      return new Response('\ufeff' + toCsv(sessions, config), {
        headers: { 'content-type': 'text/csv; charset=utf-8' },
      })
    }

    if (url.pathname === '/' ) {
      return json({ ok: true, endpoints: ['/config', '/session (POST)', '/export.csv'] })
    }

    return new Response('not found', { status: 404 })
  },
}
