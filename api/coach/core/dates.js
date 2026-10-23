export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + 'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}
export function localDay(value = Date.now(), timeZone) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = type => parts.find(p => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch { return localDay(value); }
}
export function reviewDay(value, timeZone) {
  if (typeof value === 'string' && validDay(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return localDay(value, timeZone);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return localDay(value, timeZone);
  return null;
}
export function daysBefore(day, n) {
  if (!validDay(day)) return null;
  const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
