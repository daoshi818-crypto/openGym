// Date range shared by the CSV export sheet.
import { isoOf, todayISO } from './format.js'
const DAY = 86400000

const dateOf = iso => new Date(iso + 'T12:00:00')
const addDays = (iso, n) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d) }
const daysBetween = (a, b) => Math.round((dateOf(b) - dateOf(a)) / DAY)
const validIso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOf(dateOf(s)) === s

/**
 * The days a report covers, both ends included. '7d' is the last seven days with today, '4w' the
 * last 28, '3m' back to the same date three months ago (the day after it, so 15 Jul – 15 Oct is
 * not one day too long). 'custom' takes `from`/`to`; swapped ends are put the right way round,
 * and an end in the future is cut to today.
 */
export function reportRange(range, { from, to, today = todayISO() } = {}) {
  let start, end = today
  if (range === '7d') start = addDays(today, -6)
  else if (range === '4w') start = addDays(today, -27)
  else if (range === '3m') {
    const d = dateOf(today); const day = d.getDate()
    d.setDate(1); d.setMonth(d.getMonth() - 3)
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()))
    start = addDays(isoOf(d), 1)
  } else {
    start = validIso(from) ? from : addDays(today, -27)
    end = validIso(to) ? to : today
    if (start > end) [start, end] = [end, start]
    if (end > today) end = today
    if (start > end) start = end
  }
  return { from: start, to: end, days: daysBetween(start, end) + 1 }
}
