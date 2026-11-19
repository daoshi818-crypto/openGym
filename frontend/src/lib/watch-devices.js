// This phone's chosen watch is a transport preference, never a synced profile field.
const KEY = 'opengym_blueos_devices_v1'
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(id)
export function createWatchDevices(storage = globalThis.localStorage) {
  let value
  try { value = JSON.parse(storage?.getItem(KEY) || 'null') } catch { /* unavailable */ }
  let devices = (Array.isArray(value?.devices) ? value.devices : []).filter(d => validId(d.id)).slice(0, 12)
  let selectedId = devices.some(d => d.id === value?.selectedId) ? value.selectedId : ''
  const save = () => { try { storage?.setItem(KEY, JSON.stringify({ devices, selectedId })) } catch { /* memory-only */ } }
  return {
    read: () => ({ selectedId, devices: devices.map(d => ({ ...d })) }),
    discover(id, info = {}, now = Date.now()) {
      if (!validId(id)) return false
      const old = devices.find(d => d.id === id)
      const name = String(info.deviceName || info.name || old?.name || 'vivo WATCH').slice(0, 80)
      const others = devices.filter(d => d.id !== id)
      others.sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId))
      devices = [{ id, name, version: String(info.watchVersion || old?.version || '').slice(0, 24), lastSeenAt: now }, ...others].slice(0, 12)
      // Keep the explicit selection even if another watch checks in.
      save(); return true
    },
    select(id) {
      if (!devices.some(d => d.id === id)) return false
      selectedId = id; save(); return true
    },
    accepts(id) { return validId(id) && selectedId === id },
  }
}
