import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const version = process.argv[2] || '1.6.1'
const release = 'https://github.com/daoshi818-crypto/openGym/releases/download/v' + version + '/'
async function get(name) {
  const response = await fetch(release + name)
  if (!response.ok) throw Error(name + ': HTTP ' + response.status)
  return response
}
const name = 'opengym-watch-0.6.0.rpk'
const remote = Buffer.from(await (await get(name)).arrayBuffer())
const local = readFileSync(new URL('../source/watch-app/releases/' + name, import.meta.url))
const digest = createHash('sha256').update(remote).digest('hex')
const expected = (await (await get(name + '.sha256')).text()).trim()
if (digest !== expected || !remote.equals(local)) throw Error('Released RPK differs from verified local build')
console.log('RPK download/local/SHA256 match:', digest)
const apkHash = (await (await get('openGym.apk.sha256')).text()).trim()
if (!/^[a-f0-9]{64}$/.test(apkHash)) throw Error('Invalid APK checksum')
const apk = await fetch(release + 'openGym.apk', { method: 'HEAD' })
if (!apk.ok || Number(apk.headers.get('content-length')) < 1_000_000) throw Error('APK download is not available')
console.log('APK download available:', apk.status, apk.headers.get('content-length'), 'SHA256:', apkHash)
const source = readFileSync(new URL('../source/frontend/src/lib/update.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '')
  .replace(/export (const|function|async function)/g, '$1')
const context = { __APP_VERSION__: '1.5.17', MOBILE: false, fetch, console, Date, AbortController, setTimeout, clearTimeout }
const update = await vm.runInNewContext(source + '\ncheckForUpdate()', { ...context })
if (!update.hasUpdate || update.latestVersion !== version || update.apkUrl !== release + 'openGym.apk') throw Error('Updated detector did not find release: ' + JSON.stringify(update))
console.log('Current detector with installed-version value 1.5.17:', JSON.stringify(update))
const legacySource = execFileSync('git', ['-C', new URL('../source/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'show', 'd2a6faf4:frontend/src/lib/update.js'], { encoding: 'utf8', windowsHide: true })
  .replace(/^import .*\r?\n/gm, '').replace(/export (const|function|async function)/g, '$1')
const legacy = await vm.runInNewContext(legacySource + '\ncheckForUpdate()', { ...context })
console.log('Original 1.5.17 detector against live CDN:', JSON.stringify(legacy))
if (!legacy.hasUpdate || legacy.latestVersion !== version) process.exitCode = 2
