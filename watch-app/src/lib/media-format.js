// Shared, platform-independent wire validation. Never trust filenames supplied by a peer.
export const MEDIA_ROOT = 'internal://files/watch-demo-v1'
export const mediaSourceValid = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s)
export const mediaKeyValid = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
export function mediaHeaderValid(m) {
  return !!m && mediaKeyValid(m.assetKey) && mediaSourceValid(m.sourceId) && m.width === 180 && m.height === 180 &&
    Number.isInteger(m.count) && m.count >= 2 && m.count <= 96 &&
    Number.isInteger(m.durationMs) && m.durationMs >= 100 && m.durationMs <= 35000 &&
    Number.isInteger(m.totalBytes) && m.totalBytes >= m.count*33 && m.totalBytes <= 4194304
}
export function mediaManifestValid(m) {
  if (!mediaHeaderValid(m) || !Array.isArray(m.frames) || m.frames.length !== m.count) return false
  let bytes = 0, duration = 0
  for (const f of m.frames) {
    if (!f || !Number.isInteger(f.bytes) || f.bytes < 33 || f.bytes > 65536 || !mediaKeyValid(f.sha256) ||
        !Number.isInteger(f.duration) || f.duration < 1 || f.duration > 35000) return false
    bytes += f.bytes; duration += f.duration
  }
  return bytes === m.totalBytes && bytes <= 4194304 && duration === m.durationMs
}
export function mediaDecode64(s) {
  if (typeof s !== 'string' || !s.length || s.length > 2732 || s.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) throw Error('invalid_base64')
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = []
  for (let i = 0; i < s.length; i += 4) {
    const a = abc.indexOf(s[i]), b = abc.indexOf(s[i+1]), c = abc.indexOf(s[i+2]), d = abc.indexOf(s[i+3])
    out.push((a << 2) | (b >> 4))
    if (c >= 0) out.push(((b & 15) << 4) | (c >> 2))
    if (d >= 0) out.push(((c & 3) << 6) | d)
    if ((c < 0 && (b & 15)) || (d < 0 && c >= 0 && (c & 3))) throw Error('invalid_padding')
  }
  return new Uint8Array(out)
}
// SHA-256 over a single bounded frame; verified against Node crypto in tests.
export function mediaSha256(data) {
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const n = Math.ceil((data.length + 9) / 64) * 64, b = new Uint8Array(n); b.set(data); b[data.length] = 128
  const bits = data.length * 8
  for (let i = 0; i < 4; i++) b[n-1-i] = (bits >>> (i*8)) & 255
  const ro = (v,n) => (v >>> n) | (v << (32-n)), w = new Int32Array(64)
  for (let off = 0; off < n; off += 64) {
    for (let i = 0; i < 16; i++) { const j = off+i*4; w[i] = (b[j]<<24)|(b[j+1]<<16)|(b[j+2]<<8)|b[j+3] }
    for (let i = 16; i < 64; i++) { const a=w[i-15], z=w[i-2]; w[i]=(w[i-16]+(ro(a,7)^ro(a,18)^(a>>>3))+w[i-7]+(ro(z,17)^ro(z,19)^(z>>>10)))|0 }
    let [a,c,d,e,f,g,j,l] = h
    for (let i = 0; i < 64; i++) { const t=(l+(ro(f,6)^ro(f,11)^ro(f,25))+((f&g)^(~f&j))+k[i]+w[i])|0, u=((ro(a,2)^ro(a,13)^ro(a,22))+((a&c)^(a&d)^(c&d)))|0; l=j;j=g;g=f;f=(e+t)|0;e=d;d=c;c=a;a=(t+u)|0 }
    const v=[a,c,d,e,f,g,j,l]; for(let i=0;i<8;i++) h[i]=(h[i]+v[i])|0
  }
  return h.map(v => (v>>>0).toString(16).padStart(8,'0')).join('')
}
export function mediaPngValid(b) {
  const sig=[137,80,78,71,13,10,26,10]
  if (b.length < 33 || !sig.every((v,i)=>b[i]===v) || b[12]!==73 || b[13]!==72 || b[14]!==68 || b[15]!==82) return false
  return b[16]===0 && b[17]===0 && b[18]===0 && b[19]===180 && b[20]===0 && b[21]===0 && b[22]===0 && b[23]===180
}
export const mediaImages = m => m.frames.map((f,i) => ({ src: MEDIA_ROOT+'/'+i+'.png', width:'180px', height:'180px', duration:f.duration }))
