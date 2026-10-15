// 网络层：拉动作清单、上传训练会话（失败就留着下次重试）。
import fetch from '@blueos.network.fetch'
import { listPending, clearPending } from './session.js'

// 部署 Worker 后把地址和 token 填在这里
export const WORKER_URL = 'https://REPLACE-ME.workers.dev'
export const TOKEN = 'REPLACE-ME'

function call(path, { method = 'GET', data = null } = {}) {
  return new Promise((resolve, reject) => {
    fetch.fetch({
      url: WORKER_URL + path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN,
      method,
      responseType: 'json',
      header: { 'Content-Type': 'application/json' },
      timeout: 15000,
      data: data ? JSON.stringify(data) : undefined,
      success: (res) => resolve(res.data),
      fail: (msg, code) => reject(new Error(msg + ' (' + code + ')')),
    })
  })
}

// 今天的训练安排（在 Worker 的配置里编辑）
export function fetchConfig() {
  return call('/config')
}

// 上传一个会话；成功返回 true
export function pushSession(session) {
  return call('/session', { method: 'POST', data: session }).then((r) => !!(r && r.ok))
}

// 把所有待上传的会话重试一遍（应用启动时调用）
export function flushPending() {
  const list = listPending()
  if (!list.length) return Promise.resolve(0)
  let sent = 0
  return list.reduce(
    (p, s) => p.then(() => pushSession(s).then((ok) => { if (ok) sent += 1; })),
    Promise.resolve()
  ).then(() => {
    if (sent === list.length) clearPending()
    return sent
  })
}
