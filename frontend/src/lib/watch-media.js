import { figureOf, gifSrc, isCustomEx } from './exercises.js'
import { mediaSourceValid, mediaManifestValid } from '../../../watch-app/src/lib/media-format.js'

export function watchMediaRef(S, ex) {
  if (!ex || isCustomEx(ex) || S.customEx?.some(e => e === ex)) return null
  const src = gifSrc(ex, figureOf(S)), match = /(?:^|\/)([A-Za-z0-9_-]{1,32})\.mp4$/.exec(src)
  return match ? { sourceId: match[1], format: 'png-v1' } : null
}

// One ephemeral pull session. No training outbox, store mutation, checkpoint, or event ACK.
export function createWatchMediaResponder({ getPlan, prepare, readChunk, send }) {
  let current = null, busy = null
  const valid = e => {
    const p = getPlan()
    return p && e.sid === p.sid && typeof e.requestId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(e.requestId) &&
      mediaSourceValid(e.sourceId) && p.workout.exercises.some(x => x.entryInstanceId === e.entryInstanceId && x.mediaRef?.sourceId === e.sourceId)
  }
  const same = e => current && ['sid','requestId','sourceId','entryInstanceId'].every(k => e[k] === current[k])
  return async e => {
    if (!['media_request','media_get_index','media_get'].includes(e?.t)) return false
    if (!valid(e)) return true
    if (busy) return true // The watch retries; never enqueue unlimited native decode/read jobs.
    const job = {}; busy = job
    const reply = obj => {
      // A follow-up pull can arrive before the SDK acknowledges this response. Release the
      // native-work lock BEFORE sending; only this job may clear its own lock in finally.
      if (busy === job) busy = null
      return Promise.resolve(send({ sid:e.sid, requestId:e.requestId, sourceId:e.sourceId, entryInstanceId:e.entryInstanceId, ...obj }))
    }
    try {
      if (e.t === 'media_request') {
        const m = await prepare(e.sourceId)
        if (!valid(e) || !mediaManifestValid(m) || m.sourceId !== e.sourceId) throw Error('unavailable')
        current = { ...e, manifest:m }
        const { frames, ...header } = m
        await reply({ t:'media_info', manifest:header })
      } else if (same(e) && e.assetKey === current.manifest.assetKey) {
        const m = current.manifest
        if (e.t === 'media_get_index' && Number.isInteger(e.index) && e.index >= 0 && e.index < m.count && e.index % 16 === 0) {
          await reply({ t:'media_index', assetKey:m.assetKey, index:e.index, frames:m.frames.slice(e.index,e.index+16) })
        } else if (e.t === 'media_get' && Number.isInteger(e.frame) && e.frame >= 0 && e.frame < m.count && Number.isInteger(e.offset) && e.offset >= 0 && e.offset < m.frames[e.frame].bytes && e.offset % 2048 === 0) {
          const c = await readChunk({ assetKey:m.assetKey, frame:e.frame, offset:e.offset })
          if (valid(e)) await reply({ t:'media_chunk', assetKey:m.assetKey, frame:e.frame, offset:e.offset, ...c })
        }
      } else await reply({ t:'media_error', reason:'session_expired' })
    } catch { await reply({ t:'media_error', reason:'unavailable' }).catch(() => {}) }
    finally { if (busy === job) busy = null }
    return true
  }
}
