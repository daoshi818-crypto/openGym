import { describe, expect, it } from 'vitest'
import { SET_NOTE_MAX, setNoteOf, withSetNote } from './set-notes.js'
import { NOTE_MAX } from './history.js'

describe('set note helpers', () => {
  it('keeps the fork note limit, not upstream\'s', () => {
    expect(SET_NOTE_MAX).toBe(NOTE_MAX)
    expect(SET_NOTE_MAX).toBe(500)
  })

  it('reads a note trimmed, and nothing when there is none', () => {
    expect(setNoteOf({ w: 60, r: 5, note: '  grip slipped  ' })).toBe('grip slipped')
    expect(setNoteOf({ w: 60, r: 5 })).toBe('')
    expect(setNoteOf({ note: 42 })).toBe('')
    expect(setNoteOf(null)).toBe('')
  })

  it('writes a note without touching the rest of the row', () => {
    const row = { w: 100, r: 5, done: true, rir: 2 }
    const out = withSetNote(row, 'felt easy')
    expect(out).toEqual({ w: 100, r: 5, done: true, rir: 2, note: 'felt easy' })
    // The stored row is left alone: the caller decides where the new version goes.
    expect(row.note).toBeUndefined()
  })

  it('drops the key when the note is cleared, blank or only whitespace', () => {
    const row = { w: 60, r: 8, note: 'old' }
    expect(withSetNote(row, '')).toEqual({ w: 60, r: 8 })
    expect(withSetNote(row, '   \n\t ')).toEqual({ w: 60, r: 8 })
    expect(withSetNote(row, null)).toEqual({ w: 60, r: 8 })
  })

  it('flattens control characters so one note stays one CSV cell and one line', () => {
    expect(withSetNote({}, 'knee\nfelt\todd').note).toBe('knee felt odd')
  })

  it('cuts a long note to the limit instead of growing the row', () => {
    const long = 'x'.repeat(SET_NOTE_MAX + 40)
    expect(withSetNote({}, long).note).toHaveLength(SET_NOTE_MAX)
    // An explicit smaller limit still wins, so a caller can bound a payload.
    expect(withSetNote({}, long, 10).note).toBe('x'.repeat(10))
  })
})
