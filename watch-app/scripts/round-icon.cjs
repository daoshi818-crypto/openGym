const fs = require('node:fs')
const path = require('node:path')
const sharp = require(process.env.SHARP_MODULE || '../../frontend/node_modules/sharp')

async function main() {
  const file = path.resolve(__dirname, '../src/assets/images/logo.png')
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const radius = Math.min(info.width, info.height) / 2 - 1
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const distance = Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2)
    data[(y * info.width + x) * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, radius + 0.5 - distance)))
  }
  fs.writeFileSync(file, await sharp(data, { raw: info }).png().toBuffer())
  console.log('Circular launcher icon:', info.width, info.height)
}
main().catch(e => { console.error(e); process.exitCode = 1 })
