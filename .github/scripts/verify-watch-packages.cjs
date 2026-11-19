// Verify each screen's explicit release version; legacy round is never relabeled.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')
const crypto = require('node:crypto'), assert = require('node:assert/strict')
const { unzip, verify } = require('./verify-blueos-signature.cjs')
const watchCertificate = 'aa3efdb2dda048973fa214e8c61fd3a4702551ea445db6c4b3a5b1e16634210f'
const root = path.resolve(__dirname, '../..')
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'watch-app/releases/targets.json'), 'utf8'))
const current = JSON.parse(fs.readFileSync(path.join(root, 'watch-app/src/manifest.json'), 'utf8'))
assert.deepEqual(Object.keys(matrix).sort(), ['round','square'])
for (const [shape, entry] of Object.entries(matrix)) {
  assert.equal(entry.target, 'watch-' + shape)
  const expectedFile = 'opengym-watch-' + (shape === 'round' ? 'round-' : '') + entry.version + '.rpk'
  assert.equal(entry.file, expectedFile)
  let source = current
  if (entry.status === 'legacy') {
    assert.match(entry.sourceCommit, /^[a-f0-9]{40}$/)
    source = JSON.parse(cp.execFileSync('git', ['show', entry.sourceCommit + ':watch-app/src/manifest.json'], {cwd:root,encoding:'utf8'}))
  } else assert.equal(entry.status, 'current')
  const archive = path.join(root, 'watch-app/releases', entry.file)
  const bytes = fs.readFileSync(archive)
  verify(bytes, watchCertificate)
  const contents = unzip(bytes)
  verify(contents['META-INF/CERT'], watchCertificate)
  const hashes = JSON.parse(unzip(contents['META-INF/CERT'])['hash.json'])
  assert.equal(hashes.algorithm, 'SHA-256')
  for (const [name, hash] of Object.entries(hashes.digests)) {
    assert.ok(contents[name], 'Signed payload missing: ' + name)
    assert.equal(crypto.createHash('sha256').update(contents[name]).digest('hex'), hash.toLowerCase(), 'Signed payload hash: ' + name)
  }
  const altered = Buffer.from(bytes); altered[40] ^= 1
  assert.throws(() => verify(altered, watchCertificate), 'Reject tampered ZIP payload')
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  assert.equal(digest, fs.readFileSync(archive + '.sha256', 'utf8').trim(), 'RPK hash: ' + shape)
  const packed = JSON.parse(cp.execFileSync('unzip', ['-p', archive, 'manifest.json'], {encoding:'utf8'}))
  const files = cp.execFileSync('unzip', ['-Z1', archive], {encoding:'utf8'}).split(/\r?\n/)
  assert.ok(files.includes(source.package + '.vru') && files.includes('META-INF/CERT'), 'BlueOS VRU/signature entries')
  for (const key of ['package','name','versionName','versionCode']) assert.equal(packed[key], source[key], shape + ': ' + key)
  assert.equal(packed.versionName, entry.version)
  assert.equal(packed.versionCode, entry.versionCode)
  assert.deepEqual(packed.deviceTypeList, [entry.target])
  assert.equal(packed.config.designWidth, shape === 'round' ? 466 : 390)
  console.log(shape + ': ' + entry.version + ' (' + entry.status + '), SHA256 ' + digest + ', signing identity / RSA / payload hashes verified')
}
if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV, 'WATCH_VERSION=' + matrix.square.version + '\nWATCH_ROUND_VERSION=' + matrix.round.version + '\n')
}
