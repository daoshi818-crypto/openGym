import file from '@blueos.storage.file'
import { runtime } from './runtime.js'
import { createMediaClient } from './media-client.js'

// Serialize file work across overlay generations. A cancelled download cannot overwrite a newer cache.
export function openWatchMedia(target, send, changed) {
  const r = runtime()
  if (r.mediaClient) r.mediaClient.close()
  let alive = true
  const operation = (method, args) => new Promise((resolve,reject) => {
    const timer = setTimeout(() => { r.mediaDiskPoisoned = true; reject(Error('file_timeout')) },5000)
    file[method]({ ...args, success:value=>{clearTimeout(timer);resolve(value)}, fail:error=>{clearTimeout(timer);reject(error)} })
  })
  const serial = work => {
    const next = (r.mediaDisk || Promise.resolve()).catch(() => {}).then(() => { if (!alive || r.mediaDiskPoisoned) throw Error('cancelled_or_disk_timeout'); return work() })
    r.mediaDisk = next.catch(() => {})
    return next
  }
  const disk = {
    readText: uri => serial(() => operation('readText',{uri})).then(d=>d.text),
    writeText: (uri,text) => serial(() => operation('writeText',{uri,text})),
    read: uri => serial(() => operation('readArrayBuffer',{uri,length:65537})).then(d=>new Uint8Array(d.buffer)),
    write: (uri,buffer) => serial(() => operation('writeArrayBuffer',{uri,buffer})),
    mkdir: uri => serial(() => operation('mkdir',{uri,recursive:true}).catch(() => {})),
    remove: uri => serial(() => operation('delete',{uri}).catch(() => {})),
  }
  const client = createMediaClient({ disk, send, changed })
  const handle = { receive:e=>client.receive(e), close:()=>{ alive=false;client.close();if(r.mediaClient===handle)r.mediaClient=null } }
  r.mediaClient = handle
  client.open(target).catch(() => { if(alive) changed({status:'error',label:'缓存不可用，请重试'}) })
  return handle
}
