import { MEDIA_ROOT, mediaSourceValid, mediaHeaderValid, mediaManifestValid, mediaDecode64, mediaSha256, mediaPngValid, mediaImages } from './media-format.js'

// Dependency-injected so retries, interrupted writes, corrupt caches and stale replies are testable.
export function createMediaClient({ disk, send, changed, schedule = setTimeout, unschedule = clearTimeout, now = Date.now }) {
  let alive = true, pending = null, timer = null, attempts = 0, processing = false
  let ref = null, manifest = null, frame = 0, offset = 0, bytes = null
  const notify = value => { if (alive) changed(value) }
  const fail = () => { unschedule(timer); pending = null; notify({ status:'error', label:'未能加载，请连接手机后重试' }) }
  const ask = (message, first = true) => {
    if (!alive) return
    if (first) { pending = message; attempts = 0 }
    const expected = pending
    try { send({ ...ref, ...message }) } catch { /* bounded timeout handles send failure */ }
    unschedule(timer)
    timer = schedule(() => {
      if (!alive || pending !== expected) return
      if (++attempts > 3) { fail(); return }
      ask(expected, false)
    }, message.t === 'media_request' ? 30000 : 6000)
  }
  const ready = m => { manifest = m; pending = null; unschedule(timer); notify({ status:'ready', label:'动作示范 · 仅供参考', frames:mediaImages(m), poster:MEDIA_ROOT+'/0.png', duration:m.durationMs }) }
  const nextFrame = () => {
    if (frame === manifest.count) {
      disk.writeText(MEDIA_ROOT+'/ready.json', JSON.stringify(manifest)).then(() => { if (alive) ready(manifest) }, fail)
      return
    }
    bytes = new Uint8Array(manifest.frames[frame].bytes); offset = 0
    ask({ t:'media_get', assetKey:manifest.assetKey, frame, offset })
  }
  const beginFrames = async () => {
    if (!mediaManifestValid(manifest)) throw Error('invalid_manifest')
    await disk.mkdir(MEDIA_ROOT)
    await disk.remove(MEDIA_ROOT+'/ready.json')
    for (let i=0; i<96 && alive; i++) await disk.remove(MEDIA_ROOT+'/'+i+'.png')
    if (!alive) return
    frame = 0; nextFrame()
  }
  return {
    async open(target) {
      if (!mediaSourceValid(target.sourceId) || !target.sid || !target.entryInstanceId) { fail(); return }
      ref = { ...target, requestId:String(now())+'_'+Math.floor(Math.random()*1000000) }
      notify({ status:'loading', label:'正在检查缓存…', frames:[], poster:'' })
      try {
        const m = JSON.parse(await disk.readText(MEDIA_ROOT+'/ready.json'))
        if (mediaManifestValid(m) && m.sourceId === ref.sourceId) {
          for (let i=0;i<m.count;i++) {
            if (!alive) return
            const b = await disk.read(MEDIA_ROOT+'/'+i+'.png')
            if (b.length !== m.frames[i].bytes || !mediaPngValid(b) || mediaSha256(b) !== m.frames[i].sha256) throw Error('corrupt_cache')
          }
          if (alive) ready(m)
          return
        }
      } catch { /* A missing/partial cache never counts as ready. */ }
      notify({ status:'loading', label:'手机正在准备 PNG 帧…' })
      ask({ t:'media_request' })
    },
    async receive(e) {
      if (!alive || !pending || processing || !ref || !['sid','requestId','sourceId','entryInstanceId'].every(k => e[k] === ref[k])) return
      if (e.t === 'media_error') { fail(); return }
      let accepted = false
      if (pending.t === 'media_request' && e.t === 'media_info') accepted = true
      if (pending.t === 'media_get_index' && e.t === 'media_index' && e.assetKey === manifest.assetKey && e.index === pending.index) accepted = true
      if (pending.t === 'media_get' && e.t === 'media_chunk' && e.assetKey === manifest.assetKey && e.frame === frame && e.offset === offset) accepted = true
      if (!accepted) return
      processing = true; unschedule(timer)
      try {
        if (e.t === 'media_info') {
          const m = e.manifest
          // Validate header with bounded dummy frames before allocating or requesting any files.
          if (!mediaHeaderValid(m) || m.sourceId !== ref.sourceId) throw Error('invalid_header')
          manifest = { ...m, frames:[] }
          ask({ t:'media_get_index', assetKey:m.assetKey, index:0 })
        } else if (e.t === 'media_index') {
          if (!Array.isArray(e.frames) || e.frames.length !== Math.min(16,manifest.count-e.index)) throw Error('invalid_index')
          manifest.frames.push(...e.frames)
          if (manifest.frames.length < manifest.count) ask({ t:'media_get_index', assetKey:manifest.assetKey, index:manifest.frames.length })
          else await beginFrames()
        } else {
          const chunk = mediaDecode64(e.data)
          if (chunk.length !== Math.min(2048,bytes.length-offset) || e.length !== chunk.length) throw Error('invalid_length')
          bytes.set(chunk,offset); offset += chunk.length
          if (offset < bytes.length) ask({ t:'media_get', assetKey:manifest.assetKey, frame, offset })
          else {
            if (!mediaPngValid(bytes) || mediaSha256(bytes) !== manifest.frames[frame].sha256) throw Error('invalid_frame')
            await disk.write(MEDIA_ROOT+'/'+frame+'.png',bytes)
            if (!alive) return
            frame++
            notify({ status:'loading', label:'接收示范 '+frame+'/'+manifest.count, ...(frame===1 ? {poster:MEDIA_ROOT+'/0.png'} : {}) })
            nextFrame()
          }
        }
      } catch { fail() }
      finally { processing = false }
    },
    close() { alive = false; unschedule(timer); pending = null; bytes = null },
  }
}
