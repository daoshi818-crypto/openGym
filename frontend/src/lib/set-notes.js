// A short note on one set ("grip slipped", "a little twinge", "felt easy"), adapted from
// upstream v1.4.4 (#907-adjacent "A note on any set").
//
// The fork already had the field and the editor (sheets.jsx SetNote writes `set.note`, guarded by
// history.js NOTE_MAX) plus a render test, but nothing reached it: no menu item opened the sheet,
// nothing showed the note again, and the note never left the device. This module is the one place
// that reads and writes the field, so the editor, the export, the import, the MCP bridge and the
// Coach payload all agree on what a set note is and how long it may be.
//
// It rides on the set row itself (not on a side of a per-side set: the row is what survives
// finish-workout, the watch round trip and the history edit sheet). A per-side set keeps one note
// on the row, the way the set menu opens on the row.
import { NOTE_MAX } from './history.js'

/** The fork's existing note limit (history.js NOTE_MAX), not upstream's smaller 140. */
export const SET_NOTE_MAX = NOTE_MAX

/** The set's note, trimmed, or '' when it has none. */
export const setNoteOf = s => (s && typeof s.note === 'string' ? s.note.trim() : '')

/**
 * `row` with `text` as its note (control characters flattened, cut to `max`), or without one when
 * `text` is blank. Never mutates `row`: a cleared note drops the key rather than storing ''.
 */
export function withSetNote(row, text, max = SET_NOTE_MAX) {
  const note = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
  const { note: _old, ...rest } = row || {}
  return note ? { ...rest, note } : rest
}
