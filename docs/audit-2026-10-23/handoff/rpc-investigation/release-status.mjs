import { spawnSync } from 'node:child_process'
const repo = new URL('../source/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const credential = spawnSync('git', ['-C', decodeURIComponent(repo), 'credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true,
})
const token = credential.stdout?.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9)
if (!token) throw Error('Repository GitHub credential unavailable')
const api = 'https://api.github.com/repos/daoshi818-crypto/openGym/'
async function read(path) {
  const response = await fetch(api + path, { headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'opengym-release' } })
  if (!response.ok) throw Error('GitHub request status ' + response.status)
  return response.json()
}
const mode = process.argv[2] || 'runs'
if (mode === 'runs') {
  const data = await read('actions/runs?per_page=8')
  console.log(JSON.stringify(data.workflow_runs.map(r => ({ id: r.id, name: r.name, sha: r.head_sha.slice(0, 8), status: r.status, conclusion: r.conclusion, url: r.html_url })), null, 2))
} else if (mode === 'sizes') {
  const data = await read('git/trees/main?recursive=1')
  const totals = {}
  for (const file of data.tree.filter(t => t.type === 'blob')) {
    const group = file.path.split('/').slice(0, 2).join('/')
    totals[group] = (totals[group] || 0) + (file.size || 0)
  }
  console.log(JSON.stringify(Object.entries(totals).sort((a,b) => b[1]-a[1]).slice(0,30)))
  console.log(JSON.stringify(data.tree.filter(t => t.type === 'blob').sort((a,b) => b.size-a.size).slice(0,15).map(f => ({path:f.path,size:f.size}))))
} else if (mode === 'jobs') {
  const id = process.argv[3]
  if (!/^\d+$/.test(id)) throw Error('Invalid run ID')
  const data = await read('actions/runs/' + id + '/jobs')
  console.log(JSON.stringify(data.jobs.map(j => ({ name: j.name, status: j.status, conclusion: j.conclusion, steps: j.steps.map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion })) })), null, 2))
} else if (mode === 'release') {
  const r = await read('releases/latest')
  console.log(JSON.stringify({ tag: r.tag_name, url: r.html_url, assets: r.assets.map(a => ({ name: a.name, size: a.size, url: a.browser_download_url, digest: a.digest })) }, null, 2))
} else if (mode === 'failures') {
  const id = process.argv[3]
  if (!/^\d+$/.test(id)) throw Error('Invalid run ID')
  const data = await read('actions/runs/' + id + '/jobs')
  for (const job of data.jobs.filter(j => j.conclusion === 'failure')) {
    const response = await fetch(api + 'actions/jobs/' + job.id + '/logs', { headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'opengym-release' } })
    const log = await response.text()
    console.log(job.name, log.split('\n').filter(line => /FAIL |Test Files |Tests |Error:|AssertionError:/.test(line)).slice(-35).join('\n'))
  }
} else throw Error('Unsupported status operation')
