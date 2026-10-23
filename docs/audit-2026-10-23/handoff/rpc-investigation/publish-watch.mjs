import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const repo = fileURLToPath(new URL('../source/', import.meta.url))
const credential = spawnSync('git', ['-C', repo, 'credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true,
})
const token = credential.stdout?.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9)
if (!token) throw Error('Repository credential unavailable')
const api = 'https://api.github.com/repos/daoshi818-crypto/openGym/'
const headers = { Authorization: 'Bearer ' + token, 'User-Agent': 'opengym-watch-release' }
// Keep credentials on stdin and retain the same endpoints when fetch TLS is unstable.
async function download(url, options = {}) {
  if (process.env.WATCH_PUBLISH_HTTP1 !== '1') return fetch(url, options)
  const dir = mkdtempSync(join(tmpdir(), 'opengym-publish-'))
  try {
    const config = ['url = ' + JSON.stringify(url), ...Object.entries(options.headers || {}).map(([k,v]) => 'header = ' + JSON.stringify(k + ': ' + v))].join('\n')
    const args = ['--config', '-', '--http1.1', '--silent', '--show-error', '--location', '--connect-timeout', '10', '--max-time', '40', '--write-out', '%{http_code}']
    if (options.method) args.push('--request', options.method)
    if (options.body != null) { const file = join(dir, 'body'); writeFileSync(file, options.body); args.push('--data-binary', '@' + file) }
    const r = spawnSync(process.env.WATCH_PUBLISH_CURL || 'curl.exe', args, { input: config, windowsHide: true, maxBuffer: 15 * 1024 * 1024 })
    if (r.status !== 0) throw Error('GitHub transport: ' + String(r.stderr).trim())
    const status = Number(r.stdout.subarray(-3).toString()), body = r.stdout.subarray(0, -3)
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body.toString()), text: async () => body.toString(), arrayBuffer: async () => body }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
async function request(url, options = {}) {
  const response = await download(url, { ...options, headers: { ...headers, ...options.headers } })
  if (!response.ok) throw Error('GitHub HTTP ' + response.status)
  return response.json()
}
const manifest = JSON.parse(readFileSync(new URL('../source/watch-app/src/manifest.json', import.meta.url)))
const version = manifest.versionName
const tag = 'watch-v' + version
const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
const name = 'opengym-watch-' + version + '.rpk'
const bytes = readFileSync(new URL('../source/watch-app/releases/' + name, import.meta.url))
const digest = createHash('sha256').update(bytes).digest('hex')
const expected = readFileSync(new URL('../source/watch-app/releases/' + name + '.sha256', import.meta.url), 'utf8').trim()
if (digest !== expected) throw Error('Local RPK hash mismatch')
const mode = process.argv[2]
if (mode === 'status') {
  const release = (await request(api + 'releases?per_page=20')).find(r => r.tag_name === tag)
  console.log(JSON.stringify(release ? { id: release.id, draft: release.draft, tag: release.tag_name, assets: release.assets.map(a => ({id:a.id,name:a.name,state:a.state,size:a.size,digest:a.digest})) } : { missing: tag }, null, 2))
} else if (mode === 'publish') {
  console.log('Reading current GitHub release state')
  const releases = await request(api + 'releases?per_page=20')
  let release = releases.find(r => r.tag_name === tag)
  if (!release) release = await request(api + 'releases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    tag_name: tag, target_commitish: commit, name: 'opengym 手表 ' + version,
    body: readFileSync(new URL('../source/docs/watch-' + version + '.md', import.meta.url), 'utf8'),
    draft: true, prerelease: false, make_latest: 'false',
  }) })
  for (const [assetName, data] of [[name, bytes], [name + '.sha256', Buffer.from(expected + '\n')]]) {
    if (release.assets.some(a => a.name === assetName && a.state === 'uploaded' && a.size === data.length)) { console.log('Already uploaded: ' + assetName); continue }
    console.log('Uploading: ' + assetName)
    await request(release.upload_url.replace(/\{.*$/, '') + '?name=' + encodeURIComponent(assetName), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data,
    })
  }
  console.log('Publishing verified assets')
  const body = readFileSync(new URL('../source/docs/watch-' + version + '.md', import.meta.url), 'utf8').replace(/\]\(watch-([\d.]+)\//g, '](' + 'https://raw.githubusercontent.com/daoshi818-crypto/openGym/' + commit + '/docs/watch-$1/')
  release = await request(api + 'releases/' + release.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false, make_latest: 'false', body }) })
  console.log(JSON.stringify({ tag: release.tag_name, url: release.html_url, assets: release.assets.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest })) }, null, 2))
} else if (mode === 'verify') {
  const release = await request(api + 'releases/tags/' + tag)
  if (release.draft) throw Error('Release is still a draft')
  const asset = release.assets.find(a => a.name === name)
  if (!asset) throw Error('RPK asset missing')
  const response = await download(asset.browser_download_url)
  if (!response.ok) throw Error('RPK download HTTP ' + response.status)
  const remote = Buffer.from(await response.arrayBuffer())
  if (!remote.equals(bytes)) throw Error('Downloaded RPK differs from local verified build')
  const hashResponse = await download(asset.browser_download_url + '.sha256')
  if (!hashResponse.ok || (await hashResponse.text()).trim() !== digest) throw Error('Published checksum mismatch')
  const latestPhone = await request(api + 'releases/latest')
  if (latestPhone.tag_name !== 'v1.6.2') throw Error('Watch release changed latest phone release')
  console.log(JSON.stringify({ release: release.html_url, download: asset.browser_download_url, bytes: remote.length, sha256: digest, latestPhone: latestPhone.tag_name }, null, 2))
} else throw Error('Use publish or verify')
