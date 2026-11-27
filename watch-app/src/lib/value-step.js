// Keep firmware multi-notch deltas responsive without allowing one callback to
// jump an unexpectedly large value.
export function rotationStep(ev) {
  ev = ev?.detail && typeof ev.detail === 'object' ? ev.detail : ev
  if (!ev || ev.state === 3) return 0
  const delta = Number(ev.delta)
  if (Number.isFinite(delta) && delta !== 0) {
    // BlueOS sensitivity 1 reports a low sensitivity stream. Treat each callback
    // as one detent so firmware burst deltas cannot jump a weight/reps value.
    return delta > 0 ? 1 : -1
  }
  return ev.direction === true ? 1 : ev.direction === false ? -1 : 0
}
export function valueStep(value, field, direction, configuredStep) {
  const raw = Number(configuredStep)
  const step = field === 'w' && Number.isFinite(raw) && raw >= 0.001 ? Math.round(raw * 1000) / 1000 : field === 'w' ? 0.5 : 1
  const n = value === '' || value == null ? 0 : Number(value)
  const next = Math.max(0, Math.min(99999, (Number.isFinite(n) ? n : 0) + Math.sign(direction) * Math.abs(direction) * step))
  // Preserve up to the existing three decimal places used by unit conversion.
  return String(Math.round(next * 1000) / 1000)
}
