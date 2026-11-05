// One callback = one logical step; raw firmware delta is not an angle contract.
export function rotationStep(ev) {
  if (!ev || ev.state === 3) return 0
  const delta = Number(ev.delta)
  if (Number.isFinite(delta) && delta !== 0) return delta > 0 ? 1 : -1
  return ev.direction === true ? 1 : ev.direction === false ? -1 : 0
}
export function valueStep(value, field, direction, configuredStep) {
  const raw = Number(configuredStep)
  const step = field === 'w' && Number.isFinite(raw) && raw >= 0.001 ? Math.round(raw * 1000) / 1000 : field === 'w' ? 0.5 : 1
  const n = value === '' || value == null ? 0 : Number(value)
  const next = Math.max(0, Math.min(99999, (Number.isFinite(n) ? n : 0) + (direction > 0 ? step : -step)))
  // Preserve up to the existing three decimal places used by unit conversion.
  return String(Math.round(next * 1000) / 1000)
}
