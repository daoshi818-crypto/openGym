import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
const repo = process.cwd() + '/source'
const sources = [
  ['legacy-1.5.17', execFileSync('git', ['-C', repo, 'show', 'd2a6faf4:frontend/src/lib/update.js'], { encoding: 'utf8', windowsHide: true })],
  ['current-with-installed-1.5.17', readFileSync(new URL('../source/frontend/src/lib/update.js', import.meta.url), 'utf8')],
]
for (const [name, source] of sources) {
  const code = source.split(String.fromCharCode(10)).filter(line => !line.startsWith('import '))
    .join(String.fromCharCode(10)).replace(/export (const|function|async function)/g, '$1')
  const result = await vm.runInNewContext(code + String.fromCharCode(10) + 'checkForUpdate()', { __APP_VERSION__: '1.5.17', MOBILE: false,
    fetch: (url, options) => fetch(url, { ...options, signal: options?.signal || AbortSignal.timeout(15000) }),
    console, Date, AbortController, setTimeout, clearTimeout })
  console.log(name, JSON.stringify(result))
}
