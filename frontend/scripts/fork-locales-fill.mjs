// 给所有语言包补齐新增的界面字符串（英文原文占位），让 check-locales 通过。
import fs from 'node:fs'

const dir = 'src/locales'
const KEYS = {
  'Floating countdown style': 'Floating countdown style',
  'Card': 'Card',
  'Ring': 'Ring',
  'Shows over other apps when you leave the app during a rest; tap the card to come back.': 'Shows over other apps when you leave the app during a rest; tap the card to come back.',
  'Needs the “display over other apps” permission.': 'Needs the “display over other apps” permission.',
  'Floating rest countdown': 'Floating rest countdown',
  'Heatmap': 'Heatmap',
  'Calendar': 'Calendar',
  'Connect watch': 'Connect watch',
  'Connected. Start a workout and it lands on the watch.': 'Connected. Start a workout and it lands on the watch.',
  'Looking for the watch… Open the training app on the watch.': 'Looking for the watch… Open the training app on the watch.',
  'Bluetooth is off. Turn it on and try again.': 'Bluetooth is off. Turn it on and try again.',
  'Bluetooth permission is needed.': 'Bluetooth permission is needed.',
  'Tap to pair. The watch shows your plan during a workout and records a set with one tap.': 'Tap to pair. The watch shows your plan during a workout and records a set with one tap.',
}

let files = 0
let keys = 0
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
  const p = `${dir}/${f}`
  const s = fs.readFileSync(p, 'utf8')
  const has = k => s.includes("'" + k.replace(/'/g, "\\'") + "'") || s.includes('"' + k + '"')
  const missing = Object.keys(KEYS).filter(k => !has(k))
  if (!missing.length) continue

  const idx = s.lastIndexOf('}')
  if (idx < 0) { console.log('!! no closing brace:', f); continue }

  const nl = s.includes('\r\n') ? '\r\n' : '\n'
  let head = s.slice(0, idx).replace(/\s+$/, '')
  if (head.length && !head.endsWith(',') && !head.endsWith('{')) head += ','

  const block = nl + '  // [fork] new UI strings: English placeholder until translated' + nl +
    missing.map(k => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(KEYS[k]) + ',').join(nl) + nl

  fs.writeFileSync(p, head + block + s.slice(idx))
  files += 1
  keys += missing.length
  console.log(f, 'added', missing.length)
}
console.log(`files: ${files}, keys: ${keys}`)
